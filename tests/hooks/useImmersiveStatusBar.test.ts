// @vitest-environment jsdom
/**
 * useImmersiveStatusBar · component-level dark-viewer status-bar style.
 *
 * The app runs fullscreen app-wide (overlay stays ON), so this hook only flips
 * the glyph STYLE. Coverage:
 *   - on mount: setOverlaysWebView(true) [re-assert] + Style.Light
 *   - on cleanup: hand style back to the route default (jsdom pathname "/" →
 *     Style.Dark); overlay is NEVER turned off and no background is painted
 *   - isNativePlatform()=false short-circuits both mount and cleanup
 *   - multi-instance handover (cleanup-before-setup) keeps immersive armed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const setOverlaysWebView = vi.fn(async (_arg: { overlay: boolean }) => {})
const setStyle = vi.fn(async (_arg: { style: string }) => {})
const setBackgroundColor = vi.fn(async (_arg: { color: string }) => {})
const isNativePlatform = vi.fn(() => true)

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => isNativePlatform(),
  },
}))

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setOverlaysWebView: (arg: { overlay: boolean }) => setOverlaysWebView(arg),
    setStyle: (arg: { style: string }) => setStyle(arg),
    setBackgroundColor: (arg: { color: string }) => setBackgroundColor(arg),
  },
  Style: { Light: 'LIGHT', Dark: 'DARK' },
}))

import {
  useImmersiveStatusBar,
  __resetImmersiveStatusBarForTests,
} from '../../src/hooks/useImmersiveStatusBar'

// The hook awaits two dynamic import() calls and a serialized chain before
// touching the plugin, so a few microtask turns aren't enough — yield to the
// macrotask queue twice so the imports + the awaited plugin calls fully settle.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(async () => {
  // Drain any chain op deferred by the prior test's auto-cleanup BEFORE clearing
  // the mocks, then reset the module-level ref-count/chain for full isolation.
  await flush()
  setOverlaysWebView.mockClear()
  setStyle.mockClear()
  setBackgroundColor.mockClear()
  isNativePlatform.mockReset()
  isNativePlatform.mockReturnValue(true)
  __resetImmersiveStatusBarForTests()
})

describe('useImmersiveStatusBar', () => {
  it('enables overlay + Light style on mount', async () => {
    renderHook(() => useImmersiveStatusBar())
    await flush()
    expect(setOverlaysWebView).toHaveBeenCalledWith({ overlay: true })
    expect(setStyle).toHaveBeenCalledWith({ style: 'LIGHT' })
    expect(setBackgroundColor).not.toHaveBeenCalled()
  })

  it('hands style back to the route default on cleanup without turning overlay off', async () => {
    const { unmount } = renderHook(() => useImmersiveStatusBar())
    await flush()
    setOverlaysWebView.mockClear()
    setStyle.mockClear()

    unmount()
    await flush()

    // jsdom pathname "/" is a light route → Dark glyphs, overlay stays on.
    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' })
    expect(setOverlaysWebView).not.toHaveBeenCalledWith({ overlay: false })
    expect(setBackgroundColor).not.toHaveBeenCalled()
  })

  it('short-circuits entirely on web (isNativePlatform=false)', async () => {
    isNativePlatform.mockReturnValue(false)
    const { unmount } = renderHook(() => useImmersiveStatusBar())
    await flush()
    unmount()
    await flush()
    expect(setOverlaysWebView).not.toHaveBeenCalled()
    expect(setStyle).not.toHaveBeenCalled()
    expect(setBackgroundColor).not.toHaveBeenCalled()
  })

  it('does NOT restore the route default during a same-commit handover (A unmounts, B mounts)', async () => {
    const a = renderHook(() => useImmersiveStatusBar())
    await flush()
    setStyle.mockClear()

    // Model React's cleanup-before-setup ordering: A's unmount decrements to 0
    // and schedules a deferred restore; B mounts and re-increments to 1 before
    // the deferred check runs, so the restore must be skipped (stays Light).
    a.unmount()
    const b = renderHook(() => useImmersiveStatusBar())
    await flush()

    expect(setStyle).not.toHaveBeenCalledWith({ style: 'DARK' })

    // Now the genuine last viewer leaves → restore fires (route default Dark).
    b.unmount()
    await flush()
    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' })
    expect(setOverlaysWebView).not.toHaveBeenCalledWith({ overlay: false })
  })
})
