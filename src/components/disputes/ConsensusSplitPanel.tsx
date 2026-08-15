import { useEffect, useState } from 'react'
import type { SplitProposal } from '../../lib/disputes/types'
import { formatEuro } from '../../lib/payments'
import {
  proposeSplitWorkflow,
  confirmSplitWorkflow,
  rejectSplitWorkflow,
} from '../../lib/workflow'

type Props = {
  disputeId: string
  jobId: string
  /** Canonical frozen escrow total (server-authoritative, EUR). */
  totalAmount: number
  /** Platform fee rate as a decimal (0.05 / 0.09). */
  feeRate: number
  /** Auth user id of the viewer — decides whether a pending proposal is "mine" or "theirs". */
  currentUserId: string
  /** The dispute's currently-pending proposal, or undefined when none is pending. */
  activeProposal?: SplitProposal
  /** Called after every successful mutation so the caller can refetch the active proposal. */
  onChanged?: () => void
  /**
   * Floor for the craftsman share (percent of the frozen total) that is already
   * irreversibly released/paid out. A proposal below this would require clawing
   * back money the corridor never pulls back (SEPA), so the slider cannot go
   * below it. 0 when nothing has been released yet.
   */
  minCraftsmanPercent?: number
}

type Submitting = null | 'propose' | 'confirm' | 'reject'

/**
 * Maps the raw RPC / workflow error (DB-enforced authz + state guards) onto a
 * friendly German message. The DB is the security boundary; this only makes the
 * rejection legible. Falls back to a generic message for anything unrecognised.
 */
function mapSplitError(e: unknown): string {
  const raw = (
    e instanceof Error
      ? e.message
      : typeof e === 'object' && e !== null && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e ?? '')
  ).toLowerCase()

  if (!raw) return 'Aktion fehlgeschlagen. Bitte erneut versuchen.'
  if (/proposer.*cannot.*confirm|cannot.*confirm.*own|own.*proposal|eigenen vorschlag/.test(raw))
    return 'Du kannst deinen eigenen Vorschlag nicht bestätigen — das muss die Gegenseite tun.'
  if (/not.?a.?party|nicht.*partei|not authorized|permission denied|42501|violates row-level|rls/.test(raw))
    return 'Nur die beiden Streit-Parteien können einen Vorschlag machen oder bestätigen.'
  if (/superseded|expired|not.?pending|not_pending|already (accepted|rejected|resolved)|stale|zombie|veraltet|gone/.test(raw))
    return 'Dieser Vorschlag ist nicht mehr aktuell. Die Ansicht wurde aktualisiert.'
  if (/cap|max.*round|round.*limit|too many|limit.*reached|maximal|obergrenze/.test(raw))
    return 'Die maximale Anzahl an Vorschlägen wurde erreicht. Bitte wartet auf die Operator-Entscheidung (Last Resort).'
  if (/disabled|consensus_split_disabled/.test(raw))
    return 'Diese Funktion ist derzeit nicht verfügbar.'
  if (/not hydrated|unhydrated/.test(raw))
    return 'Daten werden noch geladen. Bitte einen Moment warten und erneut versuchen.'
  if (/not.?found|nicht gefunden/.test(raw))
    return 'Der Streitfall oder Vorschlag wurde nicht gefunden.'
  if (/network|fetch|timeout|abort/.test(raw))
    return 'Netzwerkfehler. Bitte erneut versuchen.'
  return 'Aktion fehlgeschlagen. Bitte erneut versuchen.'
}

/**
 * Money breakdown for a craftsman-share ratio. Mirrors the operator
 * SplitResolutionPanel math exactly so both surfaces show identical numbers:
 *   craftsman net = total · ratio · (1 − fee)
 *   platform fee  = total · ratio · fee
 *   customer refund = total · (1 − ratio)
 * The three add up to the frozen total.
 */
function MoneyBreakdown({
  total,
  ratio,
  feeRate,
}: {
  total: number
  ratio: number
  feeRate: number
}) {
  const craftsmanNet = total * ratio * (1 - feeRate)
  const platformFee = total * ratio * feeRate
  const customerRefund = total * (1 - ratio)

  return (
    <div className="mt-3 space-y-1.5 border-t border-slate-200/80 pt-3">
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-slate-600">Handwerker erhält (Netto)</span>
        <span className="font-semibold text-emerald-700">{formatEuro(craftsmanNet)}</span>
      </div>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-slate-600">Kunden-Rückerstattung</span>
        <span className="font-semibold text-rose-700">{formatEuro(customerRefund)}</span>
      </div>
      <div className="flex items-center justify-between text-[13px]">
        <span className="text-slate-500">Plattform-Gebühr ({Math.round(feeRate * 100)} %)</span>
        <span className="font-semibold text-slate-500">{formatEuro(platformFee)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-slate-200/80 pt-1.5 text-[12px] text-slate-500">
        <span>Eingefroren gesamt</span>
        <span className="font-semibold">{formatEuro(total)}</span>
      </div>
    </div>
  )
}

/**
 * Slider + live preview used both for the first proposal and for a
 * counter-proposal. The ratio is always the craftsman's share (matches
 * SplitProposal.proposedRatio + Dispute.splitRatio semantics) regardless of
 * which party is proposing.
 */
function ProposeForm({
  total,
  feeRate,
  initialPct,
  minPct,
  submitting,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  total: number
  feeRate: number
  initialPct: number
  minPct: number
  submitting: Submitting
  submitLabel: string
  onSubmit: (ratio: number) => void
  onCancel?: () => void
}) {
  // The slider can never drop below the already-released craftsman share: a
  // smaller proposal would require a clawback of money already paid out, which
  // the corridor deliberately avoids. Clamp into [sliderMin, 99].
  const sliderMin = Math.min(99, Math.max(1, Math.ceil(minPct)))
  const [craftsmanPct, setCraftsmanPct] = useState(Math.max(initialPct, sliderMin))
  const ratio = craftsmanPct / 100
  const isValid = craftsmanPct >= sliderMin && craftsmanPct < 100
  const busy = submitting === 'propose'

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="font-semibold text-emerald-700">Handwerker: {craftsmanPct} %</span>
        <span className="font-semibold text-rose-700">Kunde: {100 - craftsmanPct} %</span>
      </div>
      <input
        type="range"
        min={sliderMin}
        max={99}
        value={craftsmanPct}
        onChange={(e) => setCraftsmanPct(Math.max(sliderMin, Number(e.target.value)))}
        disabled={submitting !== null}
        className="w-full accent-slate-700 disabled:opacity-50"
        aria-label="Handwerker-Anteil in Prozent"
      />
      <div className="mt-0.5 flex justify-between text-[10px] text-slate-400">
        <span>{sliderMin} %</span>
        <span>99 %</span>
      </div>
      {sliderMin > 1 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
          Mindestens {sliderMin} % müssen beim Handwerker bleiben – der bereits
          ausgezahlte Anteil kann nicht zurückgefordert werden.
        </p>
      ) : null}

      <MoneyBreakdown total={total} ratio={ratio} feeRate={feeRate} />

      <button
        type="button"
        onClick={() => isValid && !busy && onSubmit(ratio)}
        disabled={!isValid || submitting !== null}
        className="mt-3 w-full rounded-xl bg-slate-900 px-3 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Wird gesendet …' : submitLabel}
      </button>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting !== null}
          className="mt-2 w-full rounded-xl bg-white px-3 py-2 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200 transition active:scale-[0.97] disabled:opacity-50"
        >
          Abbrechen
        </button>
      ) : (
        <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-400">
          Die Gegenseite kann bestätigen, ablehnen oder kontern.
        </p>
      )}
    </div>
  )
}

/**
 * Party-facing consensus-split panel (P4 Teil B). Lets the two dispute parties
 * agree a split ratio between themselves. Drives its UI purely from
 * `activeProposal`; all authorization + state guards live in the DB RPC.
 *
 * States:
 *  - no pending proposal      → slider + preview + "Vorschlag senden"
 *  - pending, proposed by me  → "Warte auf Antwort" + "Vorschlag ändern"
 *  - pending, by the other    → breakdown + Bestätigen / Ablehnen / Gegenvorschlag
 */
export default function ConsensusSplitPanel({
  disputeId,
  totalAmount,
  feeRate,
  currentUserId,
  activeProposal,
  onChanged,
  minCraftsmanPercent,
}: Props) {
  const [submitting, setSubmitting] = useState<Submitting>(null)
  const [error, setError] = useState<string | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  // Preset for the compose slider — only relevant when countering/adjusting an
  // existing proposal. 50 % is the neutral default for the very first proposal.
  const [composeInitialPct, setComposeInitialPct] = useState(50)

  const proposalId = activeProposal?.id ?? null

  // Reset all transient UI whenever the underlying proposal changes (new round,
  // accepted, rejected, refetched). Prevents a stale compose form or error
  // banner from surviving a state transition.
  useEffect(() => {
    setSubmitting(null)
    setError(null)
    setComposeOpen(false)
  }, [proposalId])

  const hasProposal = !!activeProposal
  const mine = hasProposal && activeProposal!.proposedBy === currentUserId
  const theirs = hasProposal && !mine

  // Multi-click guard: every mutation funnels through here; concurrent calls are
  // dropped while one is in flight. On success we refetch via onChanged (the
  // parent re-renders this panel with the fresh proposal); on failure we surface
  // a friendly message and leave the UI interactive for a retry.
  const run = async (kind: Exclude<Submitting, null>, fn: () => Promise<unknown>) => {
    if (submitting !== null) return
    setSubmitting(kind)
    setError(null)
    try {
      await fn()
      onChanged?.()
    } catch (e) {
      setError(mapSplitError(e))
    } finally {
      setSubmitting(null)
    }
  }

  const handlePropose = (ratio: number) =>
    run('propose', () => proposeSplitWorkflow(disputeId, ratio))

  const handleConfirm = () => {
    if (!activeProposal) return
    void run('confirm', () => confirmSplitWorkflow(activeProposal.id))
  }

  const handleReject = () => {
    if (!activeProposal) return
    void run('reject', () => rejectSplitWorkflow(activeProposal.id))
  }

  const openCompose = () => {
    setError(null)
    setComposeInitialPct(
      activeProposal ? Math.round(activeProposal.proposedRatio * 100) : 50,
    )
    setComposeOpen(true)
  }

  const showCompose = !hasProposal || composeOpen

  return (
    <div className="mt-4 rounded-[18px] bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-500">
        Einvernehmliche Aufteilung
      </div>

      {/* Pending proposal from the other party — read-only summary */}
      {theirs && !composeOpen ? (
        <>
          <p className="mt-1 text-[12px] text-slate-500">
            Die Gegenseite schlägt vor, {Math.round(activeProposal!.proposedRatio * 100)} % an den
            Handwerker freizugeben und {100 - Math.round(activeProposal!.proposedRatio * 100)} % dem
            Kunden zu erstatten.
          </p>
          <MoneyBreakdown total={totalAmount} ratio={activeProposal!.proposedRatio} feeRate={feeRate} />

          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting !== null}
              className="w-full rounded-xl bg-emerald-500 px-3 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting === 'confirm' ? 'Wird bestätigt …' : 'Bestätigen — Settlement startet'}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleReject}
                disabled={submitting !== null}
                className="flex-1 rounded-xl bg-white px-3 py-2.5 text-[13px] font-semibold text-rose-600 ring-1 ring-rose-200 transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting === 'reject' ? 'Wird abgelehnt …' : 'Ablehnen'}
              </button>
              <button
                type="button"
                onClick={openCompose}
                disabled={submitting !== null}
                className="flex-1 rounded-xl bg-blue-50 px-3 py-2.5 text-[13px] font-semibold text-blue-700 ring-1 ring-blue-200 transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Gegenvorschlag
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* Pending proposal made by me — waiting for the other party */}
      {mine && !composeOpen ? (
        <>
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2.5 ring-1 ring-blue-100">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-hidden />
            <span className="text-[12px] font-semibold text-blue-800">
              Warte auf Antwort der Gegenseite
            </span>
          </div>
          <p className="mt-2 text-[12px] text-slate-500">
            Dein Vorschlag: {Math.round(activeProposal!.proposedRatio * 100)} % Handwerker ·{' '}
            {100 - Math.round(activeProposal!.proposedRatio * 100)} % Kunde.
          </p>
          <MoneyBreakdown total={totalAmount} ratio={activeProposal!.proposedRatio} feeRate={feeRate} />
          <button
            type="button"
            onClick={openCompose}
            disabled={submitting !== null}
            className="mt-3 w-full rounded-xl bg-white px-3 py-2 text-[13px] font-semibold text-slate-600 ring-1 ring-slate-200 transition active:scale-[0.97] disabled:opacity-50"
          >
            Vorschlag ändern
          </button>
        </>
      ) : null}

      {/* Compose / counter form */}
      {showCompose ? (
        <div className={hasProposal ? 'mt-3' : 'mt-2'}>
          {!hasProposal ? (
            <p className="mb-3 text-[12px] text-slate-500">
              Schlage eine Aufteilung des eingefrorenen Betrags vor. Der gewählte Anteil wird an den
              Handwerker freigegeben, der Rest dem Kunden erstattet.
            </p>
          ) : null}
          <ProposeForm
            // Remount the form when the preset or floor changes so the slider picks up the new values.
            key={`${proposalId ?? 'new'}-${composeInitialPct}-${minCraftsmanPercent ?? 0}`}
            total={totalAmount}
            feeRate={feeRate}
            initialPct={composeInitialPct}
            minPct={minCraftsmanPercent ?? 0}
            submitting={submitting}
            submitLabel={
              !hasProposal
                ? 'Vorschlag senden'
                : mine
                  ? 'Aktualisierten Vorschlag senden'
                  : 'Gegenvorschlag senden'
            }
            onSubmit={handlePropose}
            onCancel={hasProposal ? () => setComposeOpen(false) : undefined}
          />
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 text-[12px] leading-relaxed text-red-500" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
