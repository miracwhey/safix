// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installScrollSafeClicks } from '../../src/lib/ui/useScrollSafeClicks'

describe('installScrollSafeClicks — scroll-keyed synthetic-click guard', () => {
  let cleanup: () => void
  let fired: boolean
  let target: HTMLElement

  function setup(tag = 'button', attrs: Record<string, string> = {}) {
    target = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) target.setAttribute(k, v)
    target.addEventListener('click', () => {
      fired = true
    })
    document.body.appendChild(target)
  }
  function tap() {
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  }
  function scroll() {
    document.dispatchEvent(new Event('scroll', { bubbles: false }))
  }
  function click(): MouseEvent {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true })
    target.dispatchEvent(e)
    return e
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fired = false
    cleanup = installScrollSafeClicks(document)
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('lets a genuine tap (no scroll) through', () => {
    setup()
    tap()
    const e = click()
    expect(fired).toBe(true)
    expect(e.defaultPrevented).toBe(false)
  })

  it('cancels the click that follows a scroll', () => {
    setup()
    tap()
    scroll()
    const e = click()
    expect(fired).toBe(false)
    expect(e.defaultPrevented).toBe(true)
  })

  it('does NOT cancel clicks on a <canvas> (3D / WebGL surface) even after a scroll', () => {
    setup('canvas')
    tap()
    scroll()
    click()
    expect(fired).toBe(true)
  })

  it('honours the data-allow-move-click opt-out after a scroll', () => {
    setup('div', { 'data-allow-move-click': '' })
    tap()
    scroll()
    click()
    expect(fired).toBe(true)
  })

  it('recovers: a tap right after a suppressed scroll-click still works once the gesture resets', () => {
    setup()
    // first: scroll artefact is suppressed
    tap()
    scroll()
    expect(click().defaultPrevented).toBe(true)
    expect(fired).toBe(false)
    // after the scroll grace window, a fresh tap (pointerdown resets the
    // gesture, no new scroll) goes through again
    vi.advanceTimersByTime(250)
    tap()
    const e = click()
    expect(fired).toBe(true)
    expect(e.defaultPrevented).toBe(false)
  })
})
