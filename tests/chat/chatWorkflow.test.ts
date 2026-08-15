import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import {
  setChatRepository,
  resetChatRepository,
} from '../../src/lib/chat/repository/registry'
import {
  sendMessageWorkflow,
  sendVoiceNoteWorkflow,
  sendVideoMessageWorkflow,
  enqueueThreadMigrationWorkflow,
  sendSingleAttachmentOptimisticWorkflow,
  ChatRBACError,
  ChatFileValidationError,
  ChatUploadError,
  ChatSendQueuedError,
  OfflineError,
} from '../../src/lib/workflow/chatWorkflow'
import { VOICE_MAX_DURATION_MS } from '../../src/lib/chat/voice/types'
import type {
  ChatChannelType,
  ChatThreadViewModel,
} from '../../src/lib/chat/types'
import type { ChatAttachmentBlob } from '../../src/lib/chat/repository/chatAttachmentUploader'
import { uploadChatAttachmentBlob } from '../../src/lib/chat/repository/chatAttachmentUploader'
import { supabase } from '../../src/lib/supabase'

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/lib/chat/repository/chatAttachmentUploader', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/chat/repository/chatAttachmentUploader')>()
  return { ...original, uploadChatAttachmentBlob: vi.fn() }
})

// Replace uploadWithRetry with a no-sleep version so retry tests run instantly.
// Preserves retry count (maxAttempts) without real delays.
vi.mock('../../src/lib/chat/uploadWithRetry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/chat/uploadWithRetry')>()
  return {
    ...original,
    uploadWithRetry: vi.fn(async <T>(fn: () => Promise<T>, opts?: { maxAttempts?: number }) => {
      const maxAttempts = opts?.maxAttempts ?? 3
      let lastErr: unknown
      for (let i = 0; i < maxAttempts; i++) {
        try {
          return await fn()
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr
    }),
  }
})

// Stub IDB cache — unavailable in Node test env.
vi.mock('../../src/lib/chat/attachmentPendingCache', () => ({
  cacheAttachment: vi.fn().mockResolvedValue(undefined),
  clearCachedAttachment: vi.fn().mockResolvedValue(undefined),
  getCachedAttachment: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn() },
}))

// Mirror PostgrestFilterBuilder: chainable `.abortSignal()` + thenable, so the
// media send timeout (sendChatMessageWithAttachmentsRpc) resolves against the
// same shape the real client returns. Use mockReturnValue(rpcBuilder(...)).
function rpcBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    abortSignal: () => builder,
    then: (f?: ((v: unknown) => unknown) | null, r?: ((e: unknown) => unknown) | null) =>
      Promise.resolve(result).then(f, r),
  }
  return builder
}

function makeThread(channelType: ChatChannelType, id = 't1'): ChatThreadViewModel {
  const now = Date.now()
  return {
    id,
    channelType,
    customerUserId: 'cust-1',
    craftsmanUserId: 'craft-1',
    providerId: 'prov-1',
    legacyThreadId: null,
    legacySource: null,
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
  }
}

describe('chatWorkflow RBAC guards', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
  })

  it('rejects worker sending in customer channel (worker_in_customer_channel)', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendMessageWorkflow({
        threadId: 't1',
        body: 'hi customer',
        clientMessageId: 'cmid-1',
        callerRole: 'worker',
      }),
    ).rejects.toMatchObject({
      name: 'ChatRBACError',
      code: 'worker_in_customer_channel',
    })
    // Ensure no row was inserted
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('rejects customer sending in office channel (customer_in_internal_channel)', async () => {
    repo._seedThread(makeThread('office'))
    await expect(
      sendMessageWorkflow({
        threadId: 't1',
        body: 'hi office',
        clientMessageId: 'cmid-2',
        callerRole: 'customer',
      }),
    ).rejects.toMatchObject({
      name: 'ChatRBACError',
      code: 'customer_in_internal_channel',
    })
  })

  it('rejects customer sending in team channel', async () => {
    repo._seedThread(makeThread('team'))
    await expect(
      sendMessageWorkflow({
        threadId: 't1',
        body: 'x',
        clientMessageId: 'cmid-team',
        callerRole: 'customer',
      }),
    ).rejects.toMatchObject({ code: 'customer_in_internal_channel' })
  })

  it('rejects customer sending in assignment channel', async () => {
    repo._seedThread(makeThread('assignment'))
    await expect(
      sendMessageWorkflow({
        threadId: 't1',
        body: 'x',
        clientMessageId: 'cmid-asgn',
        callerRole: 'customer',
      }),
    ).rejects.toMatchObject({ code: 'customer_in_internal_channel' })
  })

  it('rejects send when thread missing (thread_not_found)', async () => {
    await expect(
      sendMessageWorkflow({
        threadId: 'missing',
        body: 'x',
        clientMessageId: 'cmid-3',
        callerRole: 'craftsman',
      }),
    ).rejects.toMatchObject({ code: 'thread_not_found' })
  })

  // CHAT-1: a thread freshly created via get-or-create RPC is not in the
  // cache until service.ts seeds it via ensureThreadInCache — the first send
  // used to always fail with thread_not_found. InMemory: _seedThread replaces
  // the RPC insert; ensureThreadInCache is the seed path the service awaits.
  it('send succeeds after the thread is seeded via the ensureThreadInCache path', async () => {
    // Before the seed: guard rejects (and stays — the guard is not removed).
    await expect(
      sendMessageWorkflow({
        threadId: 't-fresh',
        body: 'Erste Nachricht',
        clientMessageId: 'cmid-seed-1',
        callerRole: 'craftsman',
        currentUserId: 'craft-1',
      }),
    ).rejects.toMatchObject({ code: 'thread_not_found' })

    repo._seedThread(makeThread('customer', 't-fresh'))
    const seeded = await repo.ensureThreadInCache('t-fresh')
    expect(seeded?.id).toBe('t-fresh')

    const msg = await sendMessageWorkflow({
      threadId: 't-fresh',
      body: 'Erste Nachricht',
      clientMessageId: 'cmid-seed-1',
      callerRole: 'craftsman',
      currentUserId: 'craft-1',
    })
    expect(msg.body).toBe('Erste Nachricht')
    expect(repo.getMessages('t-fresh')).toHaveLength(1)
  })

  it('allows craftsman sending in customer channel', async () => {
    repo._seedThread(makeThread('customer'))
    const msg = await sendMessageWorkflow({
      threadId: 't1',
      body: 'hello',
      clientMessageId: 'cmid-ok-1',
      callerRole: 'craftsman',
      currentUserId: 'craft-1',
    })
    expect(msg.body).toBe('hello')
    expect(repo.getMessages('t1')).toHaveLength(1)
  })

  it('allows owner sending in office channel', async () => {
    repo._seedThread(makeThread('office'))
    const msg = await sendMessageWorkflow({
      threadId: 't1',
      body: 'team note',
      clientMessageId: 'cmid-ok-2',
      callerRole: 'owner',
    })
    expect(msg.body).toBe('team note')
  })

  it('allows worker sending in assignment channel', async () => {
    repo._seedThread(makeThread('assignment'))
    const msg = await sendMessageWorkflow({
      threadId: 't1',
      body: 'on site',
      clientMessageId: 'cmid-ok-3',
      callerRole: 'worker',
    })
    expect(msg.body).toBe('on site')
  })

  it('promotes messageType to artifact_card when artifactType passed', async () => {
    repo._seedThread(makeThread('customer'))
    const msg = await sendMessageWorkflow({
      threadId: 't1',
      body: 'see offer',
      clientMessageId: 'cmid-art',
      artifactType: 'offer',
      artifactId: 'off-1',
      callerRole: 'craftsman',
      currentUserId: 'craft-1',
    })
    expect(msg.messageType).toBe('artifact_card')
    expect(msg.artifactType).toBe('offer')
  })

  it('enqueueThreadMigrationWorkflow rejects worker', async () => {
    await expect(
      enqueueThreadMigrationWorkflow('legacy-1', 'conversations', 'worker'),
    ).rejects.toBeInstanceOf(ChatRBACError)
  })

  it('enqueueThreadMigrationWorkflow allows craftsman/owner/customer/admin', async () => {
    // No throw expected — InMemory enqueue is no-op
    await enqueueThreadMigrationWorkflow('legacy-1', 'conversations', 'craftsman')
    await enqueueThreadMigrationWorkflow('legacy-2', 'conversations', 'owner')
    await enqueueThreadMigrationWorkflow('legacy-3', 'conversations', 'customer')
    await enqueueThreadMigrationWorkflow('legacy-4', 'conversations', 'admin')
  })
})

describe('sendVoiceNoteWorkflow guards', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
  })

  function makeBlob(size = 1024): Blob {
    return new Blob([new Uint8Array(size)], { type: 'audio/mp4' })
  }

  // Empty = zero BYTES, not zero duration. The native iOS recorder reports
  // msDuration=0 for valid freshly-finalized m4a (AVURLAsset race); a 0ms take
  // that carries audio bytes is intentionally accepted now — duration is
  // resolved upstream in useVoiceRecorder.finalizeStop.
  it('rejects empty (zero-byte) blob', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-empty',
        callerRole: 'craftsman',
        blob: makeBlob(0),
        durationMs: 0,
        mimeType: 'audio/mp4',
        currentUserId: 'craft-1',
      }),
    ).rejects.toThrow(/chat\.voice\.empty/)
  })

  it('rejects over-length recordings (> 5 minutes)', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-long',
        callerRole: 'craftsman',
        blob: makeBlob(),
        durationMs: VOICE_MAX_DURATION_MS + 1,
        mimeType: 'audio/mp4',
        currentUserId: 'craft-1',
      }),
    ).rejects.toThrow(/chat\.voice\.too_long/)
  })

  it('rejects empty blob bodies', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-zero',
        callerRole: 'craftsman',
        blob: new Blob([], { type: 'audio/mp4' }),
        durationMs: 2000,
        mimeType: 'audio/mp4',
        currentUserId: 'craft-1',
      }),
    ).rejects.toThrow(/chat\.voice\.empty/)
  })

  it('rejects worker sending voice in customer channel', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-w-cust',
        callerRole: 'worker',
        blob: makeBlob(),
        durationMs: 5000,
        mimeType: 'audio/mp4',
      }),
    ).rejects.toMatchObject({
      name: 'ChatRBACError',
      code: 'worker_in_customer_channel',
    })
  })

  it('rejects customer sending voice in office channel', async () => {
    repo._seedThread(makeThread('office'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-c-office',
        callerRole: 'customer',
        blob: makeBlob(),
        durationMs: 5000,
        mimeType: 'audio/mp4',
      }),
    ).rejects.toMatchObject({
      name: 'ChatRBACError',
      code: 'customer_in_internal_channel',
    })
  })

  it('rejects send when thread missing', async () => {
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 'gone',
        clientMessageId: 'vn-missing',
        callerRole: 'craftsman',
        blob: makeBlob(),
        durationMs: 5000,
        mimeType: 'audio/mp4',
      }),
    ).rejects.toMatchObject({ code: 'thread_not_found' })
  })

  it('rejects customer-channel send without currentUserId (cold-start race)', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendVoiceNoteWorkflow({
        threadId: 't1',
        clientMessageId: 'vn-no-session',
        callerRole: 'craftsman',
        blob: makeBlob(),
        durationMs: 5000,
        mimeType: 'audio/mp4',
        currentUserId: null,
      }),
    ).rejects.toThrow(/Sitzung wird verbunden/)
  })
})

describe('chatWorkflow registry isolation', () => {
  it('resetChatRepository falls back to default InMemory', () => {
    const custom = new InMemoryChatRepository()
    setChatRepository(custom)
    resetChatRepository()
    // After reset, registry still returns the same instance reference
    // (resetChatRepository only calls .resetState(), it does NOT replace).
    // This documents current behavior so future change is intentional.
    expect(custom.isHydrated()).toBe(false)
  })
})

describe('sendSingleAttachmentOptimisticWorkflow — pre-insert guards', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    vi.mocked(uploadChatAttachmentBlob).mockReset()
    vi.mocked(supabase.rpc).mockReset()
    vi.unstubAllGlobals()
  })

  function makeFile(name: string, type: string, size: number): File {
    const buf = new Uint8Array(size)
    return new File([buf], name, { type })
  }

  it('rejects 0-byte file before inserting optimistic bubble', async () => {
    repo._seedThread(makeThread('customer'))
    const empty = new File([], 'photo.jpg', { type: 'image/jpeg' })
    await expect(
      sendSingleAttachmentOptimisticWorkflow({
        threadId: 't1',
        clientMessageId: 'att-empty',
        callerRole: 'craftsman',
        file: empty,
        kind: 'photo',
        currentUserId: 'craft-1',
      }),
    ).rejects.toBeInstanceOf(ChatFileValidationError)
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('rejects file over 50 MB before inserting optimistic bubble', async () => {
    repo._seedThread(makeThread('customer'))
    const big = makeFile('huge.jpg', 'image/jpeg', 50 * 1024 * 1024 + 1)
    await expect(
      sendSingleAttachmentOptimisticWorkflow({
        threadId: 't1',
        clientMessageId: 'att-big',
        callerRole: 'craftsman',
        file: big,
        kind: 'photo',
        currentUserId: 'craft-1',
      }),
    ).rejects.toBeInstanceOf(ChatFileValidationError)
    expect(repo.getMessages('t1')).toHaveLength(0)
  })

  it('queues an offline send as a pending bubble (WhatsApp semantics) instead of throwing OfflineError', async () => {
    repo._seedThread(makeThread('customer'))
    vi.stubGlobal('navigator', { onLine: false })
    const file = makeFile('photo.jpg', 'image/jpeg', 1024)
    // Offline is a queued success: the optimistic bubble IS inserted (pending)
    // and the send is enqueued for the drain-worker; the workflow signals this
    // with a non-fatal ChatSendQueuedError, never OfflineError.
    await expect(
      sendSingleAttachmentOptimisticWorkflow({
        threadId: 't1',
        clientMessageId: 'att-offline',
        callerRole: 'craftsman',
        file,
        kind: 'photo',
        currentUserId: 'craft-1',
      }),
    ).rejects.toBeInstanceOf(ChatSendQueuedError)
    const msgs = repo.getMessages('t1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].status).toBe('pending')
    expect(msgs[0].clientMessageId).toBe('att-offline')
  })
})

describe('sendSingleAttachmentOptimisticWorkflow — upload failure path', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    vi.mocked(uploadChatAttachmentBlob).mockReset()
    vi.mocked(supabase.rpc).mockReset()
    vi.unstubAllGlobals()
    vi.stubGlobal('navigator', { onLine: true })
  })

  function makeJpeg(size = 1024): File {
    return new File([new Uint8Array(size)], 'photo.jpg', { type: 'image/jpeg' })
  }

  it('inserts optimistic bubble then marks it failed after 3 upload errors', async () => {
    repo._seedThread(makeThread('customer'))
    vi.mocked(uploadChatAttachmentBlob).mockRejectedValue(new Error('storage_unavailable'))

    await expect(
      sendSingleAttachmentOptimisticWorkflow({
        threadId: 't1',
        clientMessageId: 'att-fail',
        callerRole: 'craftsman',
        file: makeJpeg(),
        kind: 'photo',
        currentUserId: 'craft-1',
      }),
    ).rejects.toBeInstanceOf(ChatUploadError)

    const msgs = repo.getMessages('t1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].status).toBe('failed')
  })

  it('upload error has bubbleInserted=true so caller can suppress toast', async () => {
    repo._seedThread(makeThread('customer'))
    vi.mocked(uploadChatAttachmentBlob).mockRejectedValue(new Error('net_err'))

    const err = await sendSingleAttachmentOptimisticWorkflow({
      threadId: 't1',
      clientMessageId: 'att-bi',
      callerRole: 'craftsman',
      file: makeJpeg(),
      kind: 'photo',
      currentUserId: 'craft-1',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ChatUploadError)
    expect((err as ChatUploadError).bubbleInserted).toBe(true)
  })
})

describe('sendSingleAttachmentOptimisticWorkflow — success path', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    vi.mocked(uploadChatAttachmentBlob).mockReset()
    vi.mocked(supabase.rpc).mockReset()
    vi.unstubAllGlobals()
    vi.stubGlobal('navigator', { onLine: true })
  })

  it('returns messageId + attachmentId and flips the optimistic bubble to sent on RPC ACK', async () => {
    repo._seedThread(makeThread('customer'))

    const blobResult: ChatAttachmentBlob = {
      assetType: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      storageBucket: 'chat-customer',
      storagePath: 'uploads/abc.jpg',
      width: null,
      height: null,
      durationMs: null,
      posterStoragePath: null,
    }
    vi.mocked(uploadChatAttachmentBlob).mockResolvedValue(blobResult)
    vi.mocked(supabase.rpc).mockReturnValue(
      rpcBuilder({
        data: { message_id: 'msg-server-1', attachment_ids: ['att-server-1'] },
        error: null,
      }) as unknown as ReturnType<typeof supabase.rpc>,
    )

    const result = await sendSingleAttachmentOptimisticWorkflow({
      threadId: 't1',
      clientMessageId: 'att-ok',
      callerRole: 'craftsman',
      file: new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' }),
      kind: 'photo',
      currentUserId: 'craft-1',
    })

    expect(result.messageId).toBe('msg-server-1')
    expect(result.attachmentId).toBe('att-server-1')
    // Optimistic row still in stream (Realtime not simulated in unit test).
    expect(repo.getMessages('t1')).toHaveLength(1)
    // L3: the bubble flips to 'sent' on the RPC ACK rather than waiting for the
    // Realtime echo — so a degraded socket no longer leaves it stuck on the
    // pending clock. The echo still replaceOptimistic's it with the server row.
    expect(repo.getMessages('t1')[0].status).toBe('sent')
  })

  it('marks bubble failed when RPC returns an error', async () => {
    repo._seedThread(makeThread('customer'))

    vi.mocked(uploadChatAttachmentBlob).mockResolvedValue({
      assetType: 'image', mimeType: 'image/jpeg', sizeBytes: 512,
      storageBucket: 'chat-customer', storagePath: 'uploads/rpc-fail.jpg',
      width: null, height: null, durationMs: null, posterStoragePath: null,
    } as ChatAttachmentBlob)
    vi.mocked(supabase.rpc).mockReturnValue(
      rpcBuilder({ data: null, error: { message: 'rpc_boom', code: '42501' } }) as unknown as ReturnType<typeof supabase.rpc>,
    )

    await expect(
      sendSingleAttachmentOptimisticWorkflow({
        threadId: 't1',
        clientMessageId: 'att-rpc-fail',
        callerRole: 'craftsman',
        file: new File([new Uint8Array(512)], 'x.jpg', { type: 'image/jpeg' }),
        kind: 'photo',
        currentUserId: 'craft-1',
      }),
    ).rejects.toBeInstanceOf(ChatUploadError)

    expect(repo.getMessages('t1')[0].status).toBe('failed')
  })
})

describe('sendVideoMessageWorkflow — duration guard', () => {
  const baseInput = {
    threadId: 't1',
    clientMessageId: 'cmid-vid',
    callerRole: 'craftsman' as const,
    videoBlob: new Blob(['x'], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    posterFile: null,
  }

  it('rejects a video longer than 60s (known duration)', async () => {
    await expect(
      sendVideoMessageWorkflow({ ...baseInput, durationMs: 61_000 }),
    ).rejects.toBeInstanceOf(ChatFileValidationError)
  })

  it('does NOT reject on unknown duration (durationMs 0) — no false block of an un-probeable clip', async () => {
    // durationMs 0 must pass validation; with no thread seeded it then fails at
    // the RBAC/thread-lookup stage, proving it got PAST the duration check
    // rather than being rejected as a ChatFileValidationError.
    await expect(
      sendVideoMessageWorkflow({ ...baseInput, durationMs: 0 }),
    ).rejects.not.toBeInstanceOf(ChatFileValidationError)
  })
})
