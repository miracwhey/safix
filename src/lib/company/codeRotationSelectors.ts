/**
 * Pure selectors for code-rotation UI.
 *
 * Keeps rate-limit math and confirmation copy out of components/workflows so
 * they remain trivially testable and consistent across surfaces.
 */

import type { CodeAuditEntry } from './codeRotation'

export type RotationDisabledReason = 'rate_limit' | null

const RATE_LIMIT_PER_24H = 5
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Mirrors the server-side rate-limit (5 rotations / 24h). Used to disable the
 * UI button before submission. The RPC remains the source of truth — this is
 * UX-only and the server will reject if the client clock is skewed.
 */
export function deriveRotationDisabledReason(
  audit: CodeAuditEntry[],
  now: Date = new Date(),
): RotationDisabledReason {
  const cutoff = now.getTime() - RATE_LIMIT_WINDOW_MS
  const recent = audit.filter((a) => Date.parse(a.rotatedAt) > cutoff)
  return recent.length >= RATE_LIMIT_PER_24H ? 'rate_limit' : null
}

/**
 * Confirmation copy shown in the rotate-confirm dialog. Member count assures
 * the owner that existing team members will not be locked out.
 */
export function deriveRotationConfirmationCopy(activeMemberCount: number): {
  title: string
  body: string
  cta: string
} {
  const memberSentence =
    activeMemberCount === 0
      ? 'Bisher ist niemand beigetreten — du kannst jederzeit rotieren.'
      : activeMemberCount === 1
        ? 'Dein 1 Mitarbeiter bleibt im Team — kein Re-Join nötig.'
        : `Deine ${activeMemberCount} Mitarbeiter bleiben im Team — kein Re-Join nötig.`

  return {
    title: 'Team-Code rotieren?',
    body: `Der alte Code wird sofort ungültig. ${memberSentence}`,
    cta: 'Code rotieren',
  }
}
