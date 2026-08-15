import type { CorrectionRequest } from './types'

/**
 * Block 7.2.7d — Listen-Indikator für den Auto-Apply-Status einer Korrektur.
 *
 * - `applied`: Eintrag wurde automatisch aktualisiert (`appliedAt` gesetzt).
 * - `manual_needed`: Approve durch, aber Apply hat ergeben dass der User
 *   manuell tätig werden muss (`invalid_time_format` oder `missing_calendar_entry`).
 * - `error`: Repository-Error beim Apply — Worker / Owner sollen es ggf. erneut
 *   versuchen.
 * - `null`: Kein Indikator (Status nicht resolved, oder Apply nicht relevant
 *   weil `kind_not_supported` — der Status-Pill sagt dann schon alles).
 *
 * Die Detail-Screens nutzen weiterhin `CorrectionApplyBadge`, das exakt den
 * gleichen 4-State-Raum abbildet, nur prominenter.
 */
export type CorrectionApplySummary =
  | { kind: 'applied' }
  | { kind: 'manual_needed' }
  | { kind: 'error' }

export function deriveCorrectionApplySummary(
  request: CorrectionRequest,
): CorrectionApplySummary | null {
  if (request.status !== 'resolved') return null
  if (request.appliedAt) return { kind: 'applied' }
  const skip = request.applySkipReason
  if (skip === 'invalid_time_format' || skip === 'missing_calendar_entry') {
    return { kind: 'manual_needed' }
  }
  if (skip === 'repository_error') return { kind: 'error' }
  return null
}
