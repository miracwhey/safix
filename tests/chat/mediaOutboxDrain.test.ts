/**
 * Media-outbox drain-worker + shared send engine (chatWorkflow).
 *
 * Verifies the WhatsApp send-queue guarantees:
 *   - drain idempotency: a server row already present ⇒ no re-upload
 *   - double-drain guard: concurrent drains upload each record exactly once
 *   - transient failure ⇒ bubble stays pending + capped backoff retry
 *   - permanent failure ⇒ record 'failed' + red bubble
 *   - backoff progression (5s → 15s → 60s → 5min cap)
 *   - offline ⇒ drain early-returns (no upload)
 *
 * The mediaOutbox module is mocked with a synchronous in-memory Map so the
 * only real timer is the backoff setTimeout (drivable with fake timers). The
 * repository is a focused fake tracking the engine's state transitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ChatStorageUploadError } from '../../src/lib/chat/errors'
import type { ChatAttachmentBlob } from '../../src/lib/chat/repository/chatAttachmentUploader'
import type { ChatRepository } from '../../src/lib/chat/repository/ChatRepository'
import type { MediaOutboxRecord } from '../../src/lib/chat/mediaOutbox'

// ── In-memory mediaOutbox mock ────────────────────────────────────────────
const ob = vi.hoisted(() => {
  const store = new Map<string, MediaOutboxRecord>()
  return {
    store,
    enqueue: vi.fn(async (r: MediaOutboxRecord) => { store.set(r.clientMessageId, { ...r }) }),
    get: vi.fn(async (id: string) => store.get(id) ?? null),
    listAll: vi.fn(async () => [...store.values()]),
    listForThread: vi.fn(async (t: string) => [...store.values()].filter((r) => r.threadId === t)),
    markAttempt: vi.fn(async (id: string) => {
      const r = store.get(id)
      if (r) store.set(id, { ...r, attempts: r.attempts + 1, lastAttemptAt: Date.now(), state: 'queued' })
    }),
    markFailed: vi.fn(async (id: string) => {
      const r = store.get(id)
      if (r) store.set(id, { ...r, state: 'failed' })
    }),
    requeue: vi.fn(async (id: string) => {
      const r = store.get(id)
      if (r) store.set(id, { ...r, state: 'queued' })
    }),
    setUploadedPath: vi.fn(async (id: string, storagePath: string, poster?: string | null) => {
      const r = store.get(id)
      if (r) {
        store.set(id, {
          ...r,
          storagePath,
          metadata: { ...r.metadata, posterStoragePath: poster ?? r.metadata.posterStoragePath ?? null },
        })
      }
    }),
    remove: vi.fn(async (id: string) => { store.delete(id) }),
    requestOutboxDrain: vi.fn(),
    CHAT_OUTBOX_DRAIN_EVENT: 'fixup:chat-drain-outbox',
  }
})

vi.mock('../../src/lib/chat/mediaOutbox', () => ({
  enqueue: ob.enqueue,
  get: ob.get,
  listAll: ob.listAll,
  listForThread: ob.listForThread,
  markAttempt: ob.markAttempt,
  markFailed: ob.markFailed,
  requeue: ob.requeue,
  setUploadedPath: ob.setUploadedPath,
  remove: ob.remove,
  requestOutboxDrain: ob.requestOutboxDrain,
  CHAT_OUTBOX_DRAIN_EVENT: ob.CHAT_OUTBOX_DRAIN_EVENT,
}))

// ── Blob caches: drain reads the persisted blob from here ─────────────────
vi.mock('../../src/lib/chat/voice/recordingCache', () => ({
  cacheVoiceRecording: vi.fn().mockResolvedValue(undefined),
  clearVoiceRecording: vi.fn().mockResolvedValue(undefined),
  readVoiceRecording: vi.fn(async () => ({
    clientMessageId: 'x',
    threadId: 't',
    channelType: 'customer',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }),
    durationMs: 3200,
    mimeType: 'audio/mp4',
    fileExtension: 'm4a',
    createdAt: Date.now(),
  })),
}))
vi.mock('../../src/lib/chat/attachmentPendingCache', () => ({
  cacheAttachment: vi.fn().mockResolvedValue(undefined),
  clearCachedAttachment: vi.fn().mockResolvedValue(undefined),
  getCachedAttachment: vi.fn().mockResolvedValue(null),
}))

// ── Uploader: single mock we assert on ────────────────────────────────────
const uploadMock = vi.fn<(...a: unknown[]) => Promise<ChatAttachmentBlob>>()
vi.mock('../../src/lib/chat/repository/chatAttachmentUploader', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/chat/repository/chatAttachmentUploader')>()
  return {
    ...original,
    uploadVoiceNoteBlob: (...a: unknown[]) => uploadMock(...a),
    uploadChatAttachmentBlob: (...a: unknown[]) => uploadMock(...a),
    uploadVideoAttachmentBlob: (...a: unknown[]) => uploadMock(...a),
  }
})

// uploadWithRetry: single attempt, no sleeps (fake timers hostile to real sleep).
vi.mock('../../src/lib/chat/uploadWithRetry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/chat/uploadWithRetry')>()
  return {
    ...original,
    uploadWithRetry: vi.fn(async <T>(fn: (signal: AbortSignal) => Promise<T>) =>
      fn(new AbortController().signal),
    ),
  }
})

// ── supabase.rpc ⇒ controllable send result ───────────────────────────────
const rpcResult = vi.hoisted(() => ({ current: { data: { message_id: 'srv-1', attachment_ids: ['att-1'], message_type: 'voice' }, error: null as unknown } }))
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(() => ({ abortSignal: () => Promise.resolve(rpcResult.current) })),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

import {
  drainMediaOutbox,
  mediaOutboxBackoffMs,
} from '../../src/lib/workflow/chatWorkflow'
import { setChatRepository, resetChatRepository } from '../../src/lib/chat/repository/registry'

// ── Focused fake repository ───────────────────────────────────────────────
interface FakeRepo extends Partial<ChatRepository> {
  sentServerRows: Set<string>
  markedSent: string[]
  markedFailed: string[]
  discarded: string[]
}

function makeFakeRepo(): FakeRepo {
  const repo: FakeRepo = {
    sentServerRows: new Set(),
    markedSent: [],
    markedFailed: [],
    discarded: [],
    hasSentServerRow(id: string) { return repo.sentServerRows.has(id) },
    markOptimisticSent(_t: string, id: string) { repo.markedSent.push(id) },
    failOptimisticMessage(_t: string, tempId: string) { repo.markedFailed.push(tempId) },
    discardOptimisticMessage(_t: string, id: string) { repo.discarded.push(id) },
    updateOptimisticAttachment() {},
    resetOptimisticToPending() {},
    insertOptimisticMessage() { return 'temp_x' },
    getConnectionState() { return 'connected' },
  }
  return repo
}

function makeBlob(): ChatAttachmentBlob {
  return {
    assetType: 'voice',
    mimeType: 'audio/mp4',
    sizeBytes: 3,
    storageBucket: 'chat-customer',
    storagePath: 'prov/thread/pending/cmid.m4a',
    width: null,
    height: null,
    durationMs: 3200,
    posterStoragePath: null,
  }
}

function queuedRecord(clientMessageId = 'cmid-1'): MediaOutboxRecord {
  return {
    clientMessageId,
    threadId: 'thread-1',
    channelType: 'customer',
    providerId: 'prov-1',
    kind: 'voice',
    fileName: `voice-${clientMessageId}.m4a`,
    mimeType: 'audio/mp4',
    storagePath: '',
    metadata: { durationMs: 3200, fileExtension: 'm4a', caption: null },
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    state: 'queued',
  }
}

let repo: FakeRepo

beforeEach(() => {
  ob.store.clear()
  ob.enqueue.mockClear(); ob.get.mockClear(); ob.listAll.mockClear()
  ob.markAttempt.mockClear(); ob.markFailed.mockClear(); ob.remove.mockClear()
  uploadMock.mockReset()
  rpcResult.current = { data: { message_id: 'srv-1', attachment_ids: ['att-1'], message_type: 'voice' }, error: null }
  vi.stubGlobal('navigator', { onLine: true })
  repo = makeFakeRepo()
  setChatRepository(repo as unknown as ChatRepository)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetChatRepository()
  vi.useRealTimers()
})

describe('backoff schedule', () => {
  it('progresses 5s → 15s → 60s → 5min and caps', () => {
    expect(mediaOutboxBackoffMs(1)).toBe(5_000)
    expect(mediaOutboxBackoffMs(2)).toBe(15_000)
    expect(mediaOutboxBackoffMs(3)).toBe(60_000)
    expect(mediaOutboxBackoffMs(4)).toBe(300_000)
    expect(mediaOutboxBackoffMs(9)).toBe(300_000)
  })
})

describe('drain idempotency', () => {
  it('skips the upload when a server row already exists', async () => {
    ob.store.set('idem-1', queuedRecord('idem-1'))
    repo.sentServerRows.add('idem-1')

    await drainMediaOutbox()

    expect(uploadMock).not.toHaveBeenCalled()
    expect(repo.markedSent).toContain('idem-1')
    expect(ob.remove).toHaveBeenCalledWith('idem-1')
  })

  it('uploads + sends + removes on a clean run', async () => {
    ob.store.set('clean-1', queuedRecord('clean-1'))
    uploadMock.mockResolvedValue(makeBlob())

    await drainMediaOutbox()

    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(repo.markedSent).toContain('clean-1')
    expect(ob.store.has('clean-1')).toBe(false)
  })
})

describe('double-drain guard', () => {
  it('uploads a record exactly once under concurrent drains', async () => {
    ob.store.set('dd-1', queuedRecord('dd-1'))
    let resolveUpload: (b: ChatAttachmentBlob) => void = () => {}
    uploadMock.mockImplementation(
      () => new Promise<ChatAttachmentBlob>((res) => { resolveUpload = res }),
    )

    const p1 = drainMediaOutbox()
    const p2 = drainMediaOutbox()
    // Spin the microtask loop until the (single) upload is actually in flight —
    // only then is the in-flight guard proven to have blocked the second drain.
    while (uploadMock.mock.calls.length === 0) await Promise.resolve()
    resolveUpload(makeBlob())
    await Promise.all([p1, p2])

    expect(uploadMock).toHaveBeenCalledTimes(1)
  })
})

describe('failure handling', () => {
  it('transient upload failure keeps the record queued + schedules a backoff retry', async () => {
    vi.useFakeTimers()
    ob.store.set('trans-1', queuedRecord('trans-1'))
    // Producer-shape, NOT a synthetic fetch error: the uploader always wraps
    // network failures in ChatStorageUploadError with a German user message
    // and status 0 — classification must key on .status, never on .message.
    uploadMock
      .mockRejectedValueOnce(
        new ChatStorageUploadError('Datei konnte nicht hochgeladen werden. Bitte erneut versuchen.', {
          status: 0,
          storageReason: 'Upload Netzwerkfehler',
        }),
      )
      .mockResolvedValueOnce(makeBlob())

    await drainMediaOutbox()

    // Bubble stays pending (not failed), record still queued, attempt recorded.
    expect(repo.markedFailed).toHaveLength(0)
    expect(ob.store.get('trans-1')?.state).toBe('queued')
    expect(ob.markAttempt).toHaveBeenCalledWith('trans-1')

    // A backoff timer is scheduled for the first retry (5s).
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)

    // The retry succeeded ⇒ record removed, bubble sent.
    expect(uploadMock).toHaveBeenCalledTimes(2)
    expect(repo.markedSent).toContain('trans-1')
    expect(ob.store.has('trans-1')).toBe(false)
  })

  it('permanent failure flips the record failed + the bubble red', async () => {
    ob.store.set('perm-1', queuedRecord('perm-1'))
    // RLS reject (42501) — non-retryable.
    uploadMock.mockRejectedValue(Object.assign(new Error('nope'), { code: '42501' }))

    await drainMediaOutbox()

    expect(repo.markedFailed).toContain('temp_perm-1')
    expect(ob.markFailed).toHaveBeenCalledWith('perm-1')
  })

  it('drops the record + removes the bubble when the blob is gone', async () => {
    // image kind ⇒ reads attachmentPendingCache, which we mocked to return null.
    ob.store.set('gone-1', { ...queuedRecord('gone-1'), kind: 'image' })

    await drainMediaOutbox()

    expect(uploadMock).not.toHaveBeenCalled()
    expect(repo.discarded).toContain('gone-1')
    expect(ob.remove).toHaveBeenCalledWith('gone-1')
  })
})

describe('offline', () => {
  it('early-returns without touching the queue or uploader', async () => {
    ob.store.set('off-1', queuedRecord('off-1'))
    vi.stubGlobal('navigator', { onLine: false })

    await drainMediaOutbox()

    expect(ob.listAll).not.toHaveBeenCalled()
    expect(uploadMock).not.toHaveBeenCalled()
  })
})
