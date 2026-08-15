// @vitest-environment jsdom
/**
 * Failed-media discard/retry wiring (Cluster 1 / B3).
 *
 * Component-level proof of the tap semantics the screen relies on:
 *   - failed bubble + retryCount < 3  → tap fires onRetry
 *   - failed bubble + retryCount >= 3 → tap fires onDiscardFailed (verwerfen)
 *
 * Plus a source-inspection guard that MessageThreadScreen routes every failed
 * media discard through the unified durable discard `discardFailedMediaMessage`
 * and renders the ChatConnectionBanner from the connection state.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Voice bubble pulls in the audio player + signed-URL resolver — stub both so
// the render is deterministic and offline-safe.
vi.mock('../../src/hooks/useVoicePlayer', () => ({
  useVoicePlayer: () => ({
    durationMs: 4000,
    isCurrentTrack: false,
    positionMs: 0,
    isPlaying: false,
    isLoading: false,
    hasError: false,
    rate: 1 as const,
    toggle: vi.fn(),
    setRate: vi.fn(),
    play: vi.fn(async () => {}),
    seek: vi.fn(),
  }),
  releaseVoicePlayer: vi.fn(),
}))
vi.mock('../../src/lib/chat/voice/storageUrl', () => ({
  resolveChatAttachmentUrl: vi.fn(async () => 'https://signed/voice'),
  invalidateChatAttachmentUrl: vi.fn(),
}))

import { VoiceMessageBubble } from '../../src/components/chat/VoiceMessageBubble'
import type { ChatAttachment } from '../../src/lib/chat/types'

function makeVoiceAttachment(): ChatAttachment {
  return {
    id: 'att-voice-1',
    messageId: 'msg-1',
    assetType: 'voice',
    mimeType: 'audio/mp4',
    sizeBytes: 2000,
    storageBucket: 'chat-customer',
    storagePath: 'prov/thread/voice-1.m4a',
    width: null,
    height: null,
    durationMs: 4000,
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

describe('VoiceMessageBubble — failed tap semantics', () => {
  it('taps retry when the failed-retry count is below 3', () => {
    const onRetry = vi.fn()
    const onDiscardFailed = vi.fn()
    render(
      createElement(VoiceMessageBubble, {
        attachment: makeVoiceAttachment(),
        createdAt: Date.now(),
        status: 'failed',
        isOwnBubble: true,
        onRetry,
        onDiscardFailed,
        failedRetryCount: 1,
      }),
    )
    fireEvent.click(screen.getByLabelText('Erneut senden'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onDiscardFailed).not.toHaveBeenCalled()
  })

  it('offers discard (verwerfen) once 3 retries have failed', () => {
    const onRetry = vi.fn()
    const onDiscardFailed = vi.fn()
    render(
      createElement(VoiceMessageBubble, {
        attachment: makeVoiceAttachment(),
        createdAt: Date.now(),
        status: 'failed',
        isOwnBubble: true,
        onRetry,
        onDiscardFailed,
        failedRetryCount: 3,
      }),
    )
    expect(screen.queryByText(/antippen, um zu verwerfen/i)).toBeTruthy()
    // Accessible name mirrors the destructive action once the tap discards.
    fireEvent.click(screen.getByLabelText('Sprachnachricht verwerfen'))
    expect(onDiscardFailed).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })
})

describe('MessageThreadScreen — media discard wiring (source contract)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/screens/MessageThreadScreen.tsx'),
    'utf-8',
  )

  it('routes voice/photo/video discard through discardFailedMediaMessage', () => {
    // No legacy per-surface discard workflow references remain.
    expect(src).not.toContain('discardFailedAttachmentWorkflow')
    expect(src).not.toContain('discardFailedVideoWorkflow')
    // The three media discard handlers all call the unified durable discard.
    const calls = src.match(/discardFailedMediaMessage\(chatThreadId, clientMessageId\)/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  it('wires the voice bubble discard affordance', () => {
    expect(src).toContain('onDiscardFailed={')
    expect(src).toContain('handleVoiceDiscard(voiceClientId)')
    expect(src).toContain('failedRetryCount={voiceRetryCount[voiceClientId] ?? 0}')
  })

  it('renders the ChatConnectionBanner from the connection state', () => {
    expect(src).toContain('const connectionState = useChatConnectionState()')
    expect(src).toContain('<ChatConnectionBanner state={connectionState} />')
  })
})
