// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { channelMock, removeChannelMock, fetchLikeStatusMock } = vi.hoisted(() => {
  const subscribe = vi.fn()
  const on = vi.fn()
  const chainable = { on, subscribe }
  on.mockReturnValue(chainable)
  subscribe.mockReturnValue(chainable)
  return {
    channelMock: vi.fn(() => chainable),
    removeChannelMock: vi.fn(),
    fetchLikeStatusMock: vi.fn(async () => ({ likeCount: 5, isLikedByCurrentUser: false })),
  }
})

vi.mock('../../src/lib/supabase', () => ({
  supabase: { channel: channelMock, removeChannel: removeChannelMock },
}))

vi.mock('../../src/lib/providerMedia/portfolioLikeService', () => ({
  fetchLikeStatus: fetchLikeStatusMock,
  toggleLike: vi.fn(),
}))

import { useLikeStatus } from '../../src/lib/providerMedia/useLikeStatus'

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// M3 — an off-screen reel card (enabled=false) must hold no Realtime channel
// and fire no status fetch, so a scrolled feed can't accumulate per-card subs.
// ---------------------------------------------------------------------------

describe('useLikeStatus — viewport gating (M3)', () => {
  it('opens no channel and fires no fetch when disabled (off-screen)', () => {
    renderHook(() => useLikeStatus('media-1', false))
    expect(channelMock).not.toHaveBeenCalled()
    expect(fetchLikeStatusMock).not.toHaveBeenCalled()
  })

  it('opens exactly one channel + fetches when enabled (on-screen)', async () => {
    renderHook(() => useLikeStatus('media-1', true))
    await waitFor(() => expect(fetchLikeStatusMock).toHaveBeenCalledTimes(1))
    expect(channelMock).toHaveBeenCalledTimes(1)
    expect(channelMock).toHaveBeenCalledWith('portfolio-likes-media-1')
  })

  it('defaults to enabled when the flag is omitted (lightbox / other callers)', async () => {
    renderHook(() => useLikeStatus('media-2'))
    await waitFor(() => expect(channelMock).toHaveBeenCalledWith('portfolio-likes-media-2'))
  })

  it('opens the channel only after scrolling into view (false → true)', async () => {
    const { rerender } = renderHook(({ on }: { on: boolean }) => useLikeStatus('media-3', on), {
      initialProps: { on: false },
    })
    expect(channelMock).not.toHaveBeenCalled()
    rerender({ on: true })
    await waitFor(() => expect(channelMock).toHaveBeenCalledTimes(1))
  })
})
