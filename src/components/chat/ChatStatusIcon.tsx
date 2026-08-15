import { useMemo } from 'react'
import type { ChatMessageStatus } from '../../lib/chat'
import {
  bubbleStatusToken,
  bubbleStatusToneClass,
  shouldRenderBubbleStatus,
} from './chatBubbleStatus'

type Props = {
  status: ChatMessageStatus
  isOwnBubble: boolean
  /**
   * Retained for API symmetry. Own bubbles are brand-blue on every surface now,
   * so the glyph always uses the own (white/cyan-300) palette regardless of
   * variant — see bubbleStatusToneClass.
   */
  variant?: 'default' | 'v5'
}

/**
 * Renders the 4-stage bubble-status glyph from ADR D-6. The component returns
 * `null` for peer bubbles — peer bubbles never display a status icon.
 *
 * Glyphs:
 *   pending   → ⏱
 *   sent      → ✓
 *   delivered → ✓✓
 *   read      → ✓✓ (cyan, the most-noticed transition)
 *   failed    → ✗
 *
 * The component re-keys on `status` so React mounts a fresh node and triggers
 * the `chat-status-tick` keyframe each transition (transform + opacity only).
 */
export function ChatStatusIcon({ status, isOwnBubble, variant = 'default' }: Props) {
  const token = useMemo(() => bubbleStatusToken(status), [status])
  if (!shouldRenderBubbleStatus(isOwnBubble)) return null

  const toneClass = bubbleStatusToneClass(token.tone, isOwnBubble, variant)

  return (
    <span
      key={status}
      className={`chat-status-tick inline-flex items-center ${toneClass}`}
      role="img"
      aria-label={token.label}
    >
      {renderGlyph(token.glyph)}
    </span>
  )
}

function renderGlyph(glyph: 'clock' | 'check' | 'check-double' | 'x') {
  switch (glyph) {
    case 'clock':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'check':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M3.4 8.4 6.4 11.4 12.6 5.2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'check-double':
      return (
        <svg width="18" height="14" viewBox="0 0 20 14" fill="none" aria-hidden>
          <path
            d="M1.6 7.4 4.4 10.2 9.8 4.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.6 7.4 10.4 10.2 18.4 1.8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'x':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M4.4 4.4 11.6 11.6 M11.6 4.4 4.4 11.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      )
  }
}
