/**
 * Pure helpers for bubble-status rendering. Testable without a DOM.
 *
 * 4 distinct status stages from ADR D-6:
 *   pending   → ⏱ (sending)
 *   sent      → ✓  white 60 %
 *   delivered → ✓✓ white 90 %
 *   read      → ✓✓ cyan #7DD3FC
 *   failed    → ✗  rose
 */

import type { ChatMessageStatus } from '../../lib/chat'

export type BubbleStatusGlyph = 'clock' | 'check' | 'check-double' | 'x'

export interface BubbleStatusToken {
  glyph: BubbleStatusGlyph
  /** semantic colour token consumed by the icon component */
  tone: 'pending' | 'muted' | 'normal' | 'read' | 'error'
  /** human-readable label for a11y */
  label: string
}

export function bubbleStatusToken(status: ChatMessageStatus): BubbleStatusToken {
  switch (status) {
    case 'pending':
      return { glyph: 'clock', tone: 'pending', label: 'Wird gesendet' }
    case 'sent':
      return { glyph: 'check', tone: 'muted', label: 'Gesendet' }
    case 'delivered':
      return { glyph: 'check-double', tone: 'normal', label: 'Zugestellt' }
    case 'read':
      return { glyph: 'check-double', tone: 'read', label: 'Gelesen' }
    case 'failed':
      return { glyph: 'x', tone: 'error', label: 'Fehlgeschlagen' }
  }
}

const TONE_CLASSES_OWN: Record<BubbleStatusToken['tone'], string> = {
  pending: 'text-white/55',
  muted: 'text-white/60',
  normal: 'text-white/90',
  read: 'text-cyan-300',
  error: 'text-rose-300',
}

const TONE_CLASSES_PEER: Record<BubbleStatusToken['tone'], string> = {
  pending: 'text-slate-400',
  muted: 'text-slate-400',
  normal: 'text-slate-500',
  read: 'text-cyan-500',
  error: 'text-rose-500',
}

export function bubbleStatusToneClass(
  tone: BubbleStatusToken['tone'],
  isOwnBubble: boolean,
  variant: 'default' | 'v5' = 'default',
): string {
  // Own bubbles are brand-blue on every surface now (v5 included), so the glyph
  // always uses the own palette (white / cyan-300); the peer palette
  // (slate / cyan-500) would wash out on blue. `variant` is retained for API
  // symmetry with the icon component.
  void variant
  return isOwnBubble ? TONE_CLASSES_OWN[tone] : TONE_CLASSES_PEER[tone]
}

/**
 * Returns true when this status icon should be rendered at all.
 * Peer bubbles never show a status icon — only own bubbles do.
 */
export function shouldRenderBubbleStatus(isOwnBubble: boolean): boolean {
  return isOwnBubble
}
