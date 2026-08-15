/**
 * Cold-start outbox wiring (Cluster 1 / Verify-Fund).
 *
 * Source contract: session.ts must arm the media-outbox auto-drain at MODULE
 * BOOTSTRAP (listener-bind block), not only inside handleAppResume. After an
 * app-kill mid-send, the cold-start rehydration nudge (requestOutboxDrain →
 * CHAT_OUTBOX_DRAIN_EVENT) fires long before any resume — without the
 * bootstrap arming it dispatches into a listener-less window and the queued
 * send sits until the next background/foreground cycle.
 *
 * A render/runtime test cannot cover this: importing session.ts triggers its
 * real module side effects (supabase auth listener, initial refresh), so the
 * wiring is pinned as a source contract like the screen discard wiring.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('session.ts — media outbox cold-start wiring (source contract)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/lib/session.ts'), 'utf-8')

  it('arms the auto-drain triggers in the bootstrap listener-bind block', () => {
    const bootstrapBlock = src.split('visibilityListenerBound = true')[1] ?? ''
    expect(bootstrapBlock).toContain('startMediaOutboxAutoDrain()')
    expect(bootstrapBlock).toContain('void drainMediaOutbox()')
  })

  it('keeps the resume-path arming (belt and braces, not a replacement)', () => {
    const marker = src.indexOf('function handleAppResume')
    expect(marker).toBeGreaterThan(-1)
    // The realtime-restart cascade (incl. the outbox kick) sits within the
    // first ~4k chars of the resume handler.
    const resumeBlock = src.slice(marker, marker + 4000)
    expect(resumeBlock).toContain('startMediaOutboxAutoDrain()')
    expect(resumeBlock).toContain('void drainMediaOutbox()')
  })
})
