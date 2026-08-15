import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import { setChatRepository } from '../../src/lib/chat/repository/registry'
import {
  sendAttachmentMessageWorkflow,
  ChatRBACError,
} from '../../src/lib/workflow/chatWorkflow'
import type {
  ChatChannelType,
  ChatThreadViewModel,
} from '../../src/lib/chat/types'

// Mock the storage-only blob uploader so we don't hit real Supabase storage.
vi.mock('../../src/lib/chat/repository/chatAttachmentUploader', () => ({
  uploadChatAttachmentBlob: vi.fn(async ({ file }: { file: File }) => ({
    assetType: 'image',
    mimeType: file.type,
    sizeBytes: file.size,
    storageBucket: 'chat-customer',
    storagePath: `prov/thread/pending/${crypto.randomUUID()}.png`,
    width: null,
    height: null,
    durationMs: null,
    posterStoragePath: null,
  })),
  cleanupOrphanAttachmentBlobs: vi.fn().mockResolvedValue(undefined),
  bucketForChannel: vi.fn(),
  assetTypeForMime: vi.fn(),
  uploadChatAttachment: vi.fn(),
}))

// Track mock state for the supabase RPC.
const rpcMock = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    // Mirror PostgrestFilterBuilder: chainable `.abortSignal()` + thenable, so
    // the workflow's send timeout (sendChatMessageWithAttachmentsRpc) resolves
    // against the same shape the real client returns.
    rpc: (...args: unknown[]) => {
      const pending = Promise.resolve(rpcMock(...args))
      const builder = {
        abortSignal: () => builder,
        then: (
          onF?: ((v: unknown) => unknown) | null,
          onR?: ((e: unknown) => unknown) | null,
        ) => pending.then(onF, onR),
      }
      return builder
    },
    // Mock retained for shape-compatibility — post-M3 (silent block drop,
    // migration 20260515000001) the workflow no longer calls
    // `isBlockedByCounterpart`, so `.from('user_blocks').select(...)` is not
    // hit by the test path. Inbound block defense is RLS-only.
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  },
}))

function makeThread(channelType: ChatChannelType): ChatThreadViewModel {
  const now = Date.now()
  return {
    id: 't1',
    channelType,
    customerUserId: 'cust',
    craftsmanUserId: 'craft',
    providerId: 'prov',
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

function makeFile(name = 'a.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

describe('sendAttachmentMessageWorkflow (atomic RPC)', () => {
  let repo: InMemoryChatRepository

  beforeEach(async () => {
    repo = new InMemoryChatRepository()
    await repo.initialize()
    setChatRepository(repo)
    rpcMock.mockReset()
  })

  it('rejects empty file list', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-empty',
        callerRole: 'craftsman',
        files: [],
      }),
    ).rejects.toThrow(/empty/)
  })

  it('rejects more than 20 files', async () => {
    repo._seedThread(makeThread('customer'))
    const files = Array.from({ length: 21 }, () => makeFile())
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-many',
        callerRole: 'craftsman',
        files,
      }),
    ).rejects.toThrow(/too_many|maximum 20/)
  })

  it('rejects worker → customer-channel', async () => {
    repo._seedThread(makeThread('customer'))
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-w',
        callerRole: 'worker',
        files: [makeFile()],
      }),
    ).rejects.toBeInstanceOf(ChatRBACError)
  })

  it('rejects customer → office-channel', async () => {
    repo._seedThread(makeThread('office'))
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-c',
        callerRole: 'customer',
        files: [makeFile()],
      }),
    ).rejects.toMatchObject({ code: 'customer_in_internal_channel' })
  })

  it('rejects when thread missing', async () => {
    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 'nope',
        clientMessageId: 'cmid-tnf',
        callerRole: 'craftsman',
        files: [makeFile()],
      }),
    ).rejects.toMatchObject({ code: 'thread_not_found' })
  })

  it('craftsman + customer-channel uploads blobs and calls atomic RPC', async () => {
    repo._seedThread(makeThread('customer'))
    rpcMock.mockResolvedValue({
      data: {
        message_id: 'msg-1',
        attachment_ids: ['att-1', 'att-2'],
        message_type: 'image',
        idempotent: false,
      },
      error: null,
    })

    const result = await sendAttachmentMessageWorkflow({
      threadId: 't1',
      caption: 'see photos',
      clientMessageId: 'cmid-ok',
      callerRole: 'craftsman',
      files: [makeFile('a.png'), makeFile('b.png')],
      currentUserId: 'craft-1',
    })

    expect(rpcMock).toHaveBeenCalledOnce()
    const [rpcName, rpcArgs] = rpcMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(rpcName).toBe('rpc_send_chat_message_with_attachments')
    expect(rpcArgs.p_thread_id).toBe('t1')
    expect(rpcArgs.p_client_message_id).toBe('cmid-ok')
    expect(rpcArgs.p_body).toBe('see photos')
    expect(Array.isArray(rpcArgs.p_attachments)).toBe(true)
    expect((rpcArgs.p_attachments as unknown[]).length).toBe(2)

    expect(result.messageId).toBe('msg-1')
    expect(result.attachmentIds).toEqual(['att-1', 'att-2'])
    expect(result.messageType).toBe('image')
    expect(result.attachments).toHaveLength(2)
  })

  it('cleans up uploaded blobs when RPC fails', async () => {
    const { cleanupOrphanAttachmentBlobs } = await import(
      '../../src/lib/chat/repository/chatAttachmentUploader'
    )
    repo._seedThread(makeThread('customer'))
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'P0001 access_denied: ...', code: 'P0001' },
    })

    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-fail',
        callerRole: 'craftsman',
        files: [makeFile('a.png'), makeFile('b.png')],
        currentUserId: 'craft-1',
      }),
    ).rejects.toMatchObject({ code: 'P0001' })

    expect(cleanupOrphanAttachmentBlobs).toHaveBeenCalledOnce()
    const [calledBlobs] = (cleanupOrphanAttachmentBlobs as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(calledBlobs).toHaveLength(2)
  })

  it('cleans up partial uploads when blob-upload throws mid-loop', async () => {
    const uploader = await import('../../src/lib/chat/repository/chatAttachmentUploader')
    const { cleanupOrphanAttachmentBlobs, uploadChatAttachmentBlob } = uploader
    repo._seedThread(makeThread('customer'))

    let calls = 0
    ;(uploadChatAttachmentBlob as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls++
      if (calls === 2) throw new Error('storage upload failed for file 2')
      return {
        assetType: 'image',
        mimeType: 'image/png',
        sizeBytes: 3,
        storageBucket: 'chat-customer',
        storagePath: `prov/thread/pending/${calls}.png`,
        width: null,
        height: null,
        durationMs: null,
        posterStoragePath: null,
      }
    })

    await expect(
      sendAttachmentMessageWorkflow({
        threadId: 't1',
        clientMessageId: 'cmid-storage-fail',
        callerRole: 'craftsman',
        files: [makeFile('a.png'), makeFile('b.png'), makeFile('c.png')],
        currentUserId: 'craft-1',
      }),
    ).rejects.toThrow(/storage upload failed/)

    // First file blob uploaded, second threw → cleanup is called with the 1 blob.
    expect(cleanupOrphanAttachmentBlobs).toHaveBeenCalled()
    expect(rpcMock).not.toHaveBeenCalled()
  })
})
