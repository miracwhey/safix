// @vitest-environment jsdom
/**
 * ChatConnectionBanner — state rendering (Cluster 1 / B3).
 *
 * offline  → persistent "Nachrichten werden gesendet…" copy
 * connecting → "Verbinde …"
 * connected → collapsed, no copy (banner not shown)
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { ChatConnectionBanner } from '../../src/components/chat/ChatConnectionBanner'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const OFFLINE_COPY = 'Keine Verbindung — Nachrichten werden gesendet, sobald du wieder online bist'

describe('ChatConnectionBanner', () => {
  it('renders the offline copy when state is offline', () => {
    render(createElement(ChatConnectionBanner, { state: 'offline' }))
    expect(screen.queryByText(OFFLINE_COPY)).toBeTruthy()
  })

  it('renders "Verbinde …" only after the 1.5s grace period', () => {
    vi.useFakeTimers()
    const { container } = render(createElement(ChatConnectionBanner, { state: 'connecting' }))
    // Within the grace window the bar stays collapsed — every thread-open
    // passes through ~0.3–2s of 'connecting' before SUBSCRIBED.
    expect(container.querySelector('[aria-hidden="false"]')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1_500)
    })
    expect(screen.queryByText('Verbinde …')).toBeTruthy()
    expect(container.querySelector('[aria-hidden="false"]')).toBeTruthy()
    expect(screen.queryByText(OFFLINE_COPY)).toBeNull()
  })

  it('shows no connection copy when connected (collapsed + aria-hidden)', () => {
    const { container } = render(createElement(ChatConnectionBanner, { state: 'connected' }))
    expect(screen.queryByText(OFFLINE_COPY)).toBeNull()
    expect(screen.queryByText('Verbinde …')).toBeNull()
    const wrapper = container.querySelector('[data-connection-state="connected"]') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.style.maxHeight).toBe('0px')
  })
})
