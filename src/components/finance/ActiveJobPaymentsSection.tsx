import { Link } from 'react-router-dom'
import type { CraftsmanPayoutJobEntry } from '../../lib/payout'
import type { PaymentState } from '../../lib/payments/types'
import type { ProviderPayoutAccount } from '../../lib/payout/types'
import type { MoneyFlowProjection, PrimaryNextAction } from '../../lib/payments/moneyFlowProjection'
import { resolveMoneyFlowProjection } from '../../lib/payments/moneyFlowProjection'
import { getJobById } from '../../lib/jobs'
import { formatEuro, formatRelativeTime } from '../../lib/shared/formatters'
import ContentSection from '../primitives/ContentSection'

// ── Craftsman-language text derivation ───────────────────────────────────────

/**
 * Maps payment state + projection to a clear one-line status the craftsman
 * can understand. Answers: "Wo ist mein Geld?"
 */
function deriveStatusLine(entry: CraftsmanPayoutJobEntry, proj: MoneyFlowProjection | null): string {
  if (!proj) {
    // Fallback when projection unavailable
    switch (entry.state) {
      case 'in_escrow':
      case 'work_in_progress':
        return 'Geld gesichert'
      case 'release_pending':
        return 'Warte auf Kundenbestätigung'
      case 'released':
        return entry.payoutEligible ? 'Zur Auszahlung übergeben' : 'Freigegeben, Konto nicht bereit'
      case 'disputed':
        return 'Geld eingefroren — Konflikt läuft'
      default:
        return 'Einzahlung läuft'
    }
  }

  // With full projection data
  if (proj.isDisputed) return 'Geld eingefroren — Konflikt läuft'

  if (proj.isTerminal) {
    if (proj.payoutStatus === 'payout_failed') return 'Auszahlung fehlgeschlagen — SaFix prüft den Fall'
    if (proj.payoutStatus === 'payout_completed') return 'Auf deinem Konto'
    if (proj.payoutStatus === 'payout_in_transit') return 'Auszahlung läuft'
    if (proj.payoutStatus === 'transfer_triggered') return 'Zur Auszahlung übergeben — wartet auf Bankbestätigung'
    if (proj.payoutStatus === 'transfer_reversed') return 'Überweisung storniert — Klärung läuft, Geld sicher verwahrt'
    if (proj.requiresReconciliation) return 'Freigabe registriert — Auszahlung wird geprüft'
    return 'Freigegeben — wird zur Auszahlung übergeben'
  }

  switch (entry.state) {
    case 'in_escrow':
      return 'Kunde hat bezahlt. Dein Geld ist gesichert.'
    case 'work_in_progress':
      if (proj.releasedPercent > 0) {
        return `${proj.releasedPercent} % freigegeben. Rest wartet auf Fertigstellung.`
      }
      return 'Geld gesichert. Arbeit läuft.'
    case 'release_pending':
      return 'Arbeit abgeschlossen. Warte auf Kundenbestätigung.'
    case 'released':
      if (proj.payoutStatus === 'payout_failed') return 'Auszahlung fehlgeschlagen — SaFix prüft den Fall'
      if (proj.payoutStatus === 'payout_completed') return 'Auf deinem Konto'
      if (proj.payoutStatus === 'payout_in_transit') return 'Auszahlung läuft'
      if (proj.payoutStatus === 'transfer_triggered') return 'Zur Auszahlung übergeben — wartet auf Bankbestätigung'
      if (proj.payoutStatus === 'transfer_reversed') return 'Überweisung storniert — Klärung läuft, Geld sicher verwahrt'
      if (proj.payoutStatus === 'payout_blocked') return 'Freigegeben, aber Auszahlungskonto nicht bereit'
      if (proj.requiresReconciliation) return 'Freigabe registriert — Auszahlung wird geprüft'
      return 'Freigegeben — Auszahlung wird vorbereitet'
    default:
      return proj.fundingStatusLabel
  }
}

/**
 * Maps primaryAction to craftsman-language next step.
 * Answers: "Was passiert als Nächstes?" + "Wer muss handeln?"
 */
function deriveNextStepLine(proj: MoneyFlowProjection | null): string | null {
  if (!proj) return null
  if (proj.isTerminal) return null

  switch (proj.primaryAction) {
    case 'wait_for_customer_payment':
      return 'Kunde hat noch nicht bezahlt'
    case 'start_work':
      return 'Nächster Schritt: Arbeitsbeginn markieren'
    case 'complete_work':
      return 'Nächster Schritt: Arbeit als fertig markieren'
    case 'release_first_tranche':
      return '25 % werden bei Arbeitsbeginn automatisch freigegeben'
    case 'release_final_tranche':
      return 'Kunde muss die Fertigstellung bestätigen'
    case 'resolve_dispute':
      return 'SaFix prüft den Konflikt'
    case 'fix_provider_payout_setup':
      return 'Auszahlungskonto einrichten, damit Geld ankommen kann'
    case 'no_action':
      return null
  }
}

/**
 * Derives a short mechanic sentence explaining the auto-payout path.
 * Answers: "Wird danach automatisch zur Auszahlung übergeben?"
 *
 * Only shown for non-terminal, non-disputed states where the craftsman
 * benefits from knowing that payout is automatic.
 */
function deriveMechanicLine(entry: CraftsmanPayoutJobEntry, proj: MoneyFlowProjection | null): string | null {
  if (!proj) return null
  if (proj.isTerminal || proj.isDisputed) return null

  switch (entry.state) {
    case 'in_escrow':
    case 'work_in_progress':
      return 'Nach Freigabe wird dein Geld automatisch zur Auszahlung übergeben.'
    case 'release_pending':
      return 'Nach Bestätigung wird dein Geld automatisch zur Auszahlung übergeben.'
    case 'released':
      // Already paid out — no mechanic explanation needed
      return null
    default:
      return null
  }
}

type TriggerActor = 'du' | 'kunde' | 'system' | 'fixup' | null

function deriveTriggerActor(action: PrimaryNextAction): TriggerActor {
  switch (action) {
    case 'start_work':
    case 'complete_work':
    case 'fix_provider_payout_setup':
      return 'du'
    case 'wait_for_customer_payment':
    case 'release_final_tranche':
      return 'kunde'
    case 'release_first_tranche':
      return 'system'
    case 'resolve_dispute':
      return 'fixup'
    case 'no_action':
      return null
  }
}

const ACTOR_LABELS: Record<Exclude<TriggerActor, null>, string> = {
  du: 'Deine Aktion',
  kunde: 'Wartet auf Kunde',
  system: 'Automatisch',
  fixup: 'SaFix prüft',
}

const ACTOR_STYLES: Record<Exclude<TriggerActor, null>, string> = {
  du: 'bg-blue-100 text-blue-700',
  kunde: 'bg-amber-100 text-amber-700',
  system: 'bg-slate-100 text-slate-600',
  fixup: 'bg-purple-100 text-purple-700',
}

/**
 * Derives the last relevant event timestamp + label for the craftsman.
 *
 * Priority: most recent AND most relevant wins.
 * Tranche releases from the projection are preferred over generic job
 * timestamps when available, because "25 % freigegeben" is more useful
 * than "Auftrag angenommen" for a job that's already in progress.
 */
function deriveLastEvent(
  jobId: string,
  proj: MoneyFlowProjection | null,
): { label: string; relativeTime: string } | null {
  const job = getJobById(jobId)
  if (!job) return null

  // Collect candidates with timestamps, pick the most recent
  const candidates: { label: string; at: number }[] = []

  if (job.paymentReleasedAt) {
    candidates.push({ label: 'Zahlung freigegeben', at: job.paymentReleasedAt })
  }
  if (job.workCompletedAt) {
    candidates.push({ label: 'Arbeit fertig', at: job.workCompletedAt })
  }

  // Tranche releases — more specific than "Auftrag angenommen"
  if (proj) {
    for (const t of proj.tranches) {
      if (t.isReleased && t.releasedAt) {
        const pct = t.percentage > 0 ? `${t.percentage} % freigegeben` : 'Teilfreigabe'
        candidates.push({ label: pct, at: t.releasedAt })
      }
    }
  }

  // proposalAcceptedAt only if nothing more specific exists
  if (candidates.length === 0 && job.proposalAcceptedAt) {
    candidates.push({ label: 'Auftrag angenommen', at: job.proposalAcceptedAt })
  }

  if (candidates.length === 0) return null

  // Most recent first
  candidates.sort((a, b) => b.at - a.at)
  const best = candidates[0]
  return { label: best.label, relativeTime: formatRelativeTime(best.at) }
}

// ── Sort + filter ────────────────────────────────────────────────────────────

/** States relevant for the craftsman's active overview. */
const VISIBLE_STATES: ReadonlySet<PaymentState> = new Set([
  'in_escrow',
  'work_in_progress',
  'release_pending',
  'released',
  'disputed',
])

function getSortPriority(entry: CraftsmanPayoutJobEntry): number {
  if (entry.state === 'disputed') return 0
  if (entry.state === 'release_pending') return 1
  if (entry.state === 'released' && !entry.payoutEligible) return 2
  if (entry.state === 'work_in_progress') return 3
  if (entry.state === 'in_escrow') return 4
  if (entry.state === 'released' && entry.payoutEligible) return 5
  return 6
}

function getStateBadgeStyle(
  state: PaymentState,
  payoutEligible: boolean,
  proj: MoneyFlowProjection | null,
): string {
  if (state === 'released' && proj) {
    if (proj.payoutStatus === 'payout_failed') return 'bg-rose-100 text-rose-700'
    if (proj.payoutStatus === 'payout_completed') return 'bg-emerald-100 text-emerald-700'
    if (proj.payoutStatus === 'payout_in_transit') return 'bg-blue-100 text-blue-700'
    if (proj.requiresReconciliation) return 'bg-amber-100 text-amber-700'
  }
  if (state === 'disputed') return 'bg-rose-100 text-rose-700'
  if (state === 'release_pending') return 'bg-amber-100 text-amber-700'
  if (state === 'released' && payoutEligible) return 'bg-emerald-100 text-emerald-700'
  if (state === 'released') return 'bg-rose-100 text-rose-700'
  if (state === 'work_in_progress' || state === 'in_escrow') return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-600'
}

function getStateShortLabel(entry: CraftsmanPayoutJobEntry, proj: MoneyFlowProjection | null): string {
  if (entry.state === 'released' && proj) {
    if (proj.payoutStatus === 'payout_failed') return 'Fehler'
    if (proj.payoutStatus === 'transfer_reversed') return 'Rückbuchung'
    if (proj.payoutStatus === 'payout_completed') return 'Angekommen'
    if (proj.payoutStatus === 'payout_in_transit') return 'Auszahlung'
    if (proj.requiresReconciliation) return 'Klärung'
  }
  switch (entry.state) {
    case 'in_escrow': return 'Gesichert'
    case 'work_in_progress': return 'Arbeit läuft'
    case 'release_pending': return 'Freigabe'
    case 'released': return entry.payoutEligible ? 'Übergeben' : 'Blockiert'
    case 'disputed': return 'Konflikt'
    default: return 'Ausstehend'
  }
}

// ── Component ────────────────────────────────────────────────────────────────

type Props = {
  perJob: CraftsmanPayoutJobEntry[]
  payoutAccount: ProviderPayoutAccount | null
}

export default function ActiveJobPaymentsSection({ perJob, payoutAccount }: Props) {
  const visible = perJob
    .filter((e) => VISIBLE_STATES.has(e.state))
    .sort((a, b) => getSortPriority(a) - getSortPriority(b))

  if (visible.length === 0) return null

  return (
    <ContentSection eyebrow="Aufträge" title="Zahlungsübersicht">
      <div className="space-y-3">
        {visible.map((entry) => {
          const proj = resolveMoneyFlowProjection(entry.jobId, payoutAccount)
          const statusLine = deriveStatusLine(entry, proj)
          const nextStep = deriveNextStepLine(proj)
          const mechanicLine = deriveMechanicLine(entry, proj)
          const actor = proj ? deriveTriggerActor(proj.primaryAction) : null
          const lastEvent = deriveLastEvent(entry.jobId, proj)
          const deadline = proj?.acceptanceDeadlineLabel || null
          const amount = entry.netAmount > 0 ? entry.netAmount : entry.grossAmount

          return (
            <Link
              key={entry.paymentId}
              to={`/craftsman/jobs/${entry.jobId}`}
              className="block rounded-card bg-canvas p-4 ring-1 ring-edge transition hover:ring-ink-muted/30"
            >
              {/* Row 1: Title + Amount + State badge */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-ink">
                    {entry.jobTitle}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[15px] font-semibold tabular-nums text-ink">
                    {entry.isExact ? '' : 'ca. '}{formatEuro(amount)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${getStateBadgeStyle(entry.state, entry.payoutEligible, proj)}`}
                  >
                    {getStateShortLabel(entry, proj)}
                  </span>
                </div>
              </div>

              {/* Row 2: Status line — "Wo ist mein Geld?" */}
              <p className="mt-1.5 text-[13px] leading-snug text-ink-sub">
                {statusLine}
              </p>

              {/* Row 2b: Mechanic line — "Wird danach automatisch zur Auszahlung übergeben?" */}
              {mechanicLine && (
                <p className="mt-1 text-[12px] leading-snug text-ink-muted">
                  {mechanicLine}
                </p>
              )}

              {/* Row 3: Next step + trigger actor + deadline */}
              {(nextStep || deadline) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {actor && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ACTOR_STYLES[actor]}`}
                    >
                      {ACTOR_LABELS[actor]}
                    </span>
                  )}
                  {nextStep && (
                    <span className="text-[12px] text-ink-muted">{nextStep}</span>
                  )}
                </div>
              )}

              {/* Deadline banner — only when acceptance auto-release is ticking */}
              {deadline && (
                <div className="mt-2 rounded-[8px] bg-amber-50 px-3 py-1.5 ring-1 ring-amber-200">
                  <p className="text-[12px] font-medium text-amber-800">{deadline}</p>
                </div>
              )}

              {/* Row 4: Last event — compact footer */}
              {lastEvent && (
                <p className="mt-2 text-[11px] text-ink-muted">
                  {lastEvent.label} · {lastEvent.relativeTime}
                </p>
              )}
            </Link>
          )
        })}
      </div>
    </ContentSection>
  )
}
