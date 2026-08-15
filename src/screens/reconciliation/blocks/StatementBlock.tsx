import { useState } from 'react'
import { AlertCircle, CheckCircle2, Info, Send } from 'lucide-react'
import { submitDisputeResponseWorkflow } from '../../../lib/workflow/disputeResponseWorkflow'
import { logError } from '../../../lib/observability'
import type { ReconciliationView } from '../../../lib/reconciliation'
import {
  canSubmitDisputeResponse,
  formatResponseDeadlineLabel,
  isDisputeResponseDeadlineUrgent,
} from '../../../lib/disputes/disputeResponseSelectors'
import type { Job } from '../../../lib/jobs/types'
import type { DisputeResponseSession } from '../../../lib/disputes/disputeResponseSelectors'

type Props = {
  view: ReconciliationView
  job: Job | null
  session: DisputeResponseSession
  /** Called after a successful submit so the parent can pull a fresh history snapshot. */
  onSubmitted?: () => void
  /** When true, render the compact form variant used inside the job tab embed. */
  compact?: boolean
}

const MIN_STATEMENT_CHARS = 20
const MAX_STATEMENT_CHARS = 4_000

export function StatementBlock({
  view,
  job,
  session,
  onSubmitted,
  compact,
}: Props) {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isAlreadySubmitted = view.status === 'under_review' || view.status === 'resolved'
  const allowed =
    !!job &&
    canSubmitDisputeResponse({
      dispute: view.dispute,
      session,
      job,
    })
  const lifecycleAcceptsAStatement =
    view.status === 'customer_waiting' || view.status === 'provider_waiting'
  const showForm = lifecycleAcceptsAStatement && allowed
  const showAlreadySubmittedNotice = isAlreadySubmitted

  if (!showForm && !showAlreadySubmittedNotice) {
    return null
  }

  const trimmed = draft.trim()
  const charsValid = trimmed.length >= MIN_STATEMENT_CHARS
  const canSubmit = charsValid && !submitting

  async function onSubmit() {
    if (!job) return
    if (!charsValid) {
      setError(`Bitte mindestens ${MIN_STATEMENT_CHARS} Zeichen schildern.`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // Workflow resolves the session via its own session-store; the
      // composer signature mirrors `DisputeResponseComposer`'s call site.
      await submitDisputeResponseWorkflow({
        jobId: job.id,
        statement: trimmed,
        session: undefined,
      })
      setDraft('')
      onSubmitted?.()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Stellungnahme konnte nicht abgegeben werden.'
      setError(message)
      logError('reconciliation.statement.submit_failed', err, {
        disputeId: view.disputeId,
        jobId: job.id,
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (showAlreadySubmittedNotice) {
    return (
      <section
        className={
          compact
            ? 'rounded-card bg-surface ring-1 ring-edge p-4'
            : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
        }
      >
        <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
          § Deine Stellungnahme
        </h3>
        <p className="mt-2 text-[14px] leading-snug text-ink-sub">
          Bereits abgegeben. Eine Stellungnahme kann nicht bearbeitet werden — du kannst
          jedoch jederzeit weitere Beweise nachreichen, solange das Verfahren offen ist.
        </p>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-ok">
          <CheckCircle2 className="w-4 h-4" />
          <span>Eingegangen bei der Klärungsstelle</span>
        </div>
      </section>
    )
  }

  const deadlineDate = view.deadline ? new Date(view.deadline.dueAt) : null
  const deadlineLabel = deadlineDate ? formatResponseDeadlineLabel(deadlineDate) : null
  const deadlineUrgent = deadlineDate ? isDisputeResponseDeadlineUrgent(deadlineDate) : false

  return (
    <section
      className={
        compact
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Deine Stellungnahme
      </h3>
      <p className="mt-2 mb-3 text-[15px] font-semibold leading-snug text-ink">
        Was möchtest du der Klärungsstelle mitteilen?
      </p>
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value.slice(0, MAX_STATEMENT_CHARS))
          if (error) setError(null)
        }}
        disabled={submitting}
        rows={6}
        placeholder="Beschreibe in eigenen Worten, was unvollständig ist. Ein bis zwei Absätze reichen."
        className="w-full rounded-card border border-edge bg-canvas px-3 py-3 text-[15px] leading-relaxed text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
      />
      <div className="mt-2 flex items-start gap-2 text-[12px] text-ink-muted">
        <Info className="w-4 h-4 flex-shrink-0 mt-[1px]" />
        <span>
          Konkrete Beobachtungen helfen mehr als Vermutungen. Der Anbieter sieht den Text
          neutral aufbereitet — Kontaktdaten werden automatisch entfernt.
        </span>
      </div>
      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-card bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-[1px]" />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] text-ink-muted font-mono tabular-nums">
          {trimmed.length} / {MAX_STATEMENT_CHARS}
        </span>
        <div className="flex items-center gap-3">
          {deadlineLabel ? (
            <span
              className={`text-[12px] font-semibold ${
                deadlineUrgent ? 'text-danger' : 'text-ink-sub'
              }`}
            >
              Frist {deadlineLabel}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 rounded-container bg-brand px-4 py-2 text-[14px] font-semibold text-white shadow-elevated disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Wird abgegeben …' : 'Stellungnahme abgeben'}
          </button>
        </div>
      </div>
    </section>
  )
}
