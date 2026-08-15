// @vitest-environment jsdom
/**
 * ImageMessageBubble — signed-URL onError hardening (Cluster 1 / B3, P2 #8).
 *
 * A sent image whose signed URL fails to load must:
 *   1. invalidate the shared URL cache + re-resolve exactly ONCE, then
 *   2. if the fresh URL also fails, fall through to "Bild nicht verfügbar"
 *      (no endless resolve loop).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const resolveMock = vi.fn<(bucket: string, path: string) => Promise<string>>()
const invalidateMock = vi.fn<(bucket: string, path: string) => void>()

vi.mock('../../src/lib/chat/voice/storageUrl', () => ({
  resolveChatAttachmentUrl: (bucket: string, path: string) => resolveMock(bucket, path),
  invalidateChatAttachmentUrl: (bucket: string, path: string) => invalidateMock(bucket, path),
}))
vi.mock('../../src/lib/observability', () => ({
  logWarning: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import { ImageMessageBubble } from '../../src/components/chat/ImageMessageBubble'
import type { ChatAttachment } from '../../src/lib/chat/types'

function makeAttachment(): ChatAttachment {
  return {
    id: 'att-1',
    messageId: 'msg-1',
    assetType: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    storageBucket: 'chat-customer',
    storagePath: 'prov/thread/img-1.jpg',
    width: 800,
    height: 600,
    durationMs: null,
    posterStoragePath: null,
    transcript: null,
    transcriptLanguage: null,
    uploadedAt: Date.now(),
    deletedAt: null,
    transcodeStatus: 'none',
    h264Url: null,
    posterUrl: null,
    transcodeProvider: null,
    transcodeError: null,
  } as ChatAttachment
}

afterEach(cleanup)
beforeEach(() => {
  resolveMock.mockReset()
  invalidateMock.mockReset()
})

describe('ImageMessageBubble — onError re-resolve guard', () => {
  it('re-resolves exactly once, then goes terminal on a second failure', async () => {
    resolveMock
      .mockResolvedValueOnce('https://signed/url-1')
      .mockResolvedValueOnce('https://signed/url-2')

    render(
      createElement(ImageMessageBubble, {
        attachment: makeAttachment(),
        caption: null,
        createdAt: Date.now(),
        status: 'sent',
        isOwnBubble: true,
      }),
    )

    // Mount resolve.
    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(1))
    const img = (await screen.findByAltText('Bild im Chat')) as HTMLImageElement

    // First load failure → invalidate + one re-resolve.
    fireEvent.error(img)
    await waitFor(() => expect(resolveMock).toHaveBeenCalledTimes(2))
    expect(invalidateMock).toHaveBeenCalledTimes(1)

    // Second failure on the fresh URL → terminal, NO third resolve.
    const img2 = (await screen.findByAltText('Bild im Chat')) as HTMLImageElement
    fireEvent.error(img2)
    await screen.findByText('Bild nicht verfügbar')
    expect(resolveMock).toHaveBeenCalledTimes(2)
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })
})
