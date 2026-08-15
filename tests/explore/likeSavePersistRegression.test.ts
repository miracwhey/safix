// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { createElement, useState } from 'react'

/**
 * Regression: like/save toggles silently dropped their DB write when the
 * component bumped another state (e.g. a pop-animation key) right before
 * calling toggle(). The hooks captured their snapshot INSIDE a setState
 * updater, which React only runs synchronously via its eager-state bailout —
 * and that bailout is SKIPPED once another setState already queued work on the
 * fiber. Result: optimistic flip but no toggleLike()/toggleSave() → likes
 * couldn't be removed and saved reels never persisted. These harnesses
 * reproduce the exact "setState-before-toggle" call shape and assert the
 * service IS reached.
 */

const mocks = vi.hoisted(() => {
  const subscribe = vi.fn()
  const on = vi.fn()
  const chainable = { on, subscribe }
  on.mockReturnValue(chainable)
  subscribe.mockReturnValue(chainable)
  return {
    channelMock: vi.fn(() => chainable),
    removeChannelMock: vi.fn(),
    fetchLikeStatusMock: vi.fn(async () => ({ likeCount: 1, isLikedByCurrentUser: true })),
    toggleLikeMock: vi.fn(async () => ({ likeCount: 0, isLikedByCurrentUser: false })),
    fetchSaveStatusMock: vi.fn(async () => ({ saveCount: 0, isSavedByCurrentUser: false, folderId: null })),
    toggleSaveMock: vi.fn(async () => ({ saveCount: 1, isSavedByCurrentUser: true, folderId: null })),
  }
})

vi.mock('../../src/lib/supabase', () => ({
  supabase: { channel: mocks.channelMock, removeChannel: mocks.removeChannelMock },
}))
vi.mock('../../src/lib/providerMedia/portfolioLikeService', () => ({
  fetchLikeStatus: mocks.fetchLikeStatusMock,
  toggleLike: mocks.toggleLikeMock,
}))
vi.mock('../../src/lib/providerMedia/portfolioSaveService', () => ({
  fetchSaveStatus: mocks.fetchSaveStatusMock,
  toggleSave: mocks.toggleSaveMock,
  setSaveFolder: vi.fn(async () => ({ saveCount: 1, isSavedByCurrentUser: true, folderId: null })),
  unsave: vi.fn(async () => ({ saveCount: 0, isSavedByCurrentUser: false, folderId: null })),
}))

import { useLikeStatus } from '../../src/lib/providerMedia/useLikeStatus'
import { useSaveStatus } from '../../src/lib/providerMedia/useSaveStatus'

beforeEach(() => {
  vi.clearAllMocks()
})

// Mirrors ExploreReelCard.handleLike: a pop-key setState immediately before
// like.toggle() — the call shape that defeated the eager-state snapshot.
function LikeHarness() {
  const [pop, setPop] = useState(0)
  const like = useLikeStatus('media-1', true)
  return createElement(
    'button',
    {
      onClick: () => {
        setPop((k) => k + 1)
        void like.toggle()
      },
    },
    `like-${pop}-${like.isLiked}`,
  )
}

function SaveHarness() {
  const [pop, setPop] = useState(0)
  const save = useSaveStatus('media-1', true)
  return createElement(
    'button',
    {
      onClick: () => {
        setPop((k) => k + 1)
        void save.toggle()
      },
    },
    `save-${pop}-${save.isSaved}`,
  )
}

describe('like/save persist regression (setState-before-toggle)', () => {
  it('unlike reaches toggleLike() even with a sibling setState before it', async () => {
    const { getByRole } = render(createElement(LikeHarness))
    await waitFor(() => expect(mocks.fetchLikeStatusMock).toHaveBeenCalledTimes(1))
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(mocks.toggleLikeMock).toHaveBeenCalledTimes(1))
  })

  it('save reaches toggleSave() even with a sibling setState before it', async () => {
    const { getByRole } = render(createElement(SaveHarness))
    await waitFor(() => expect(mocks.fetchSaveStatusMock).toHaveBeenCalledTimes(1))
    fireEvent.click(getByRole('button'))
    await waitFor(() => expect(mocks.toggleSaveMock).toHaveBeenCalledTimes(1))
  })

  it('does not double-write when tapped twice within the same tick (pending guard)', async () => {
    const { getByRole } = render(createElement(SaveHarness))
    await waitFor(() => expect(mocks.fetchSaveStatusMock).toHaveBeenCalledTimes(1))
    const btn = getByRole('button')
    fireEvent.click(btn)
    fireEvent.click(btn) // second tap before the first settles → guarded by pending
    await waitFor(() => expect(mocks.toggleSaveMock).toHaveBeenCalledTimes(1))
  })
})
