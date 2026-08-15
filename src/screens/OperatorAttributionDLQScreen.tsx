/**
 * OperatorAttributionDLQScreen — minimal operator surface for resolving
 * attribution-DLQ jobs.
 *
 * Lists every `jobs` row stuck at `attribution_status = 'dlq'` and surfaces
 * three mandatory actions per row:
 *   1. Resolve as merchant_brought   (5 % fee, status → finalized)
 *   2. Resolve as platform_acquired  (9 % fee, status → finalized)
 *   3. Keep-frozen / re-affirm       (status stays dlq, operator note
 *                                     overwrites attribution_dlq_reason,
 *                                     audit row written)
 *
 * Data fetch:
 *   DLQ jobs are loaded through /api/operator/list-dlq-attribution.  The
 *   jobs-table RLS policy (`jobs_select_own`) scopes reads to participants
 *   (customer / craftsman).  Operators are usually not participants on the
 *   jobs they review, so a direct Supabase select would hide most of the
 *   queue.  Routing the list through a service-role endpoint with an explicit
 *   is_operator gate keeps the jobs-RLS surface untouched while giving the
 *   operator a real queue view.
 *
 * Mutations:
 *   Every action routes through /api/operator/resolve-attribution → the
 *   SECURITY DEFINER RPC writes attribution_audit_log atomically with the
 *   state transition.  No client-side mutation of jobs.attribution_status.
 *
 * Gate stack:
 *   1. Route-level: OwnerRouteGate (craftsman owner).
 *   2. Screen-level: session.isOperator must be TRUE.
 *   3. Server-level list + resolve endpoints re-verify is_operator.
 *   4. DB-level: operator_resolve_attribution RPC re-verifies is_operator.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ArrowLeft, AlertTriangle, CheckCircle2, Pause } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useSession } from '../hooks/useSession'
import { useSmartBack } from '../hooks/useSmartBack'
import { canAccessOperatorTools } from '../lib/access'
import { supabase } from '../lib/supabase'
import { apiUrl } from '../lib/api/baseUrl'
import { logError, logInfo } from '../lib/observability'

// ── Types ────────────────────────────────────────────────────────────────────

type DlqJob = {
  id: string
  customer_user_id: string | null
  craftsman_user_id: string | null
  attribution_status: string
  attribution_dlq_reason: string | null
  attribution_retry_count: number | null
  attribution_last_retry_at: string | null
  commercial_origin: string | null
  created_at: string | null
}

type ResolveMode = 'resolve-merchant' | 'resolve-platform' | 'reject'

type DialogState =
  | { kind: 'idle' }
  | { kind: 'acting'; jobId: string; mode: ResolveMode }

// ── Screen ───────────────────────────────────────────────────────────────────

export default function OperatorAttributionDLQScreen() {
  const session = useSession()
  const goBack = useSmartBack('/craftsman/operator')

  const hasAccess = canAccessOperatorTools(session) && session.isOperator === true

  const [jobs, setJobs] = useState<DlqJob[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState>({ kind: 'idle' })
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  async function resolveAccessToken(): Promise<string | null> {
    const sessionResult = await supabase.auth.getSession()
    return sessionResult.data.session?.access_token ?? null
  }

  const loadJobs = useCallback(async (): Promise<void> => {
    setLoading(true)
    setFetchError(null)

    const accessToken = await resolveAccessToken()
    if (!accessToken) {
      setFetchError('Sitzung abgelaufen. Bitte neu anmelden.')
      setLoading(false)
      return
    }

    const endpoint = apiUrl('/api/operator/list-dlq-attribution')

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      const body = (await response.json().catch(() => ({}))) as {
        jobs?: DlqJob[]
        error?: string
        message?: string
      }

      if (!response.ok) {
        setFetchError(body.message ?? body.error ?? `HTTP ${response.status}`)
        logError(
          'screen.operator_dlq.fetch_failed',
          new Error(body.error ?? 'unknown'),
          { status: response.status },
        )
        setLoading(false)
        return
      }

      setJobs(body.jobs ?? [])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setFetchError(message)
      logError(
        'screen.operator_dlq.fetch_exception',
        err instanceof Error ? err : new Error(message),
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasAccess) return
    void loadJobs()
  }, [hasAccess, loadJobs])

  // useMemo must run unconditionally — keep before the early returns
  // (rules-of-hooks: hook order must be stable across renders).
  const sortedJobs = useMemo(() => jobs, [jobs])

  if (!session.user || !session.sessionValidated) {
    return null
  }
  if (!hasAccess) {
    return <Navigate to="/craftsman" replace />
  }

  // ── Action handlers ──────────────────────────────────────────────────────

  function beginAction(jobId: string, mode: ResolveMode): void {
    setReason('')
    setSubmitError(null)
    setSuccessMessage(null)
    setDialog({ kind: 'acting', jobId, mode })
  }

  function cancelAction(): void {
    setDialog({ kind: 'idle' })
    setReason('')
    setSubmitError(null)
  }

  async function submitAction(): Promise<void> {
    if (dialog.kind !== 'acting') return
    const trimmed = reason.trim()
    if (trimmed.length === 0) {
      setSubmitError('Eine Begründung ist Pflicht.')
      return
    }

    const payload: {
      jobId: string
      mode: 'resolve' | 'reclassify' | 'reject'
      toOrigin?: 'merchant_brought' | 'platform_acquired'
      reason: string
    } = (() => {
      if (dialog.mode === 'resolve-merchant') {
        return { jobId: dialog.jobId, mode: 'resolve', toOrigin: 'merchant_brought', reason: trimmed }
      }
      if (dialog.mode === 'resolve-platform') {
        return { jobId: dialog.jobId, mode: 'resolve', toOrigin: 'platform_acquired', reason: trimmed }
      }
      return { jobId: dialog.jobId, mode: 'reject', reason: trimmed }
    })()

    setSubmitting(true)
    setSubmitError(null)

    const endpoint = apiUrl('/api/operator/resolve-attribution')

    const accessToken = await resolveAccessToken()
    if (!accessToken) {
      setSubmitting(false)
      setSubmitError('Sitzung abgelaufen. Bitte neu anmelden.')
      return
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      })

      const body = (await response.json().catch(() => ({}))) as {
        outcome?: string
        error?: string
        message?: string
      }

      if (!response.ok) {
        setSubmitError(body.message ?? body.error ?? `HTTP ${response.status}`)
        logError(
          'screen.operator_dlq.resolve_failed',
          new Error(body.error ?? 'unknown'),
          { jobId: dialog.jobId, mode: dialog.mode, status: response.status },
        )
        return
      }

      logInfo('screen.operator_dlq.resolve_success', {
        jobId: dialog.jobId,
        mode: dialog.mode,
      })

      setSuccessMessage(
        dialog.mode === 'reject'
          ? 'DLQ-Hinweis festgehalten — Job bleibt in der Queue.'
          : `Job finalisiert als ${payload.toOrigin}.`,
      )
      setDialog({ kind: 'idle' })
      setReason('')
      await loadJobs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSubmitError(message)
      logError(
        'screen.operator_dlq.resolve_exception',
        err instanceof Error ? err : new Error(message),
        { jobId: dialog.jobId, mode: dialog.mode },
      )
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900"
          >
            <ArrowLeft size={16} />
            Operator-Dashboard
          </button>
        </div>

        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-neutral-900">Attribution DLQ</h1>
          <p className="text-sm text-neutral-600">
            Jobs, bei denen der Finalizer die Provisions-Zuordnung nicht selbst auflösen konnte.
            Jede Aktion wird mit Operator-ID und Begründung auditiert.
          </p>
        </header>

        {successMessage ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {successMessage}
          </div>
        ) : null}

        {loading ? (
          <p className="text-sm text-neutral-500">Lade DLQ-Liste…</p>
        ) : fetchError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            Fehler beim Laden: {fetchError}
          </div>
        ) : sortedJobs.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white px-4 py-6 text-sm text-neutral-500">
            Keine DLQ-Einträge.
          </div>
        ) : (
          <ul className="space-y-3">
            {sortedJobs.map((job) => (
              <li
                key={job.id}
                className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-center gap-2 text-amber-700">
                  <AlertTriangle size={16} />
                  <span className="text-xs font-medium uppercase tracking-wide">
                    DLQ — {job.attribution_dlq_reason ?? '—'}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600">
                  <span>Job</span>
                  <span className="font-mono text-neutral-900">{job.id}</span>
                  <span>Customer</span>
                  <span className="font-mono text-neutral-900">{job.customer_user_id ?? '—'}</span>
                  <span>Craftsman</span>
                  <span className="font-mono text-neutral-900">{job.craftsman_user_id ?? '—'}</span>
                  <span>Retry-Count</span>
                  <span className="font-mono text-neutral-900">{job.attribution_retry_count ?? 0}</span>
                  <span>Letzter Versuch</span>
                  <span className="font-mono text-neutral-900">
                    {job.attribution_last_retry_at ?? '—'}
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => beginAction(job.id, 'resolve-merchant')}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                  >
                    <CheckCircle2 size={14} />
                    merchant_brought (5 %)
                  </button>
                  <button
                    type="button"
                    onClick={() => beginAction(job.id, 'resolve-platform')}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-800 hover:bg-sky-100"
                  >
                    <CheckCircle2 size={14} />
                    platform_acquired (9 %)
                  </button>
                  <button
                    type="button"
                    onClick={() => beginAction(job.id, 'reject')}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
                  >
                    <Pause size={14} />
                    Hinweis festhalten (in DLQ lassen)
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {dialog.kind === 'acting' ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
              <h2 className="text-lg font-semibold text-neutral-900">
                {dialog.mode === 'reject'
                  ? 'DLQ-Hinweis festhalten'
                  : 'Attribution finalisieren'}
              </h2>
              <p className="mt-1 text-xs text-neutral-600">
                Job: <span className="font-mono">{dialog.jobId}</span>
              </p>
              {dialog.mode === 'reject' ? (
                <p className="mt-2 text-xs text-neutral-600">
                  Status bleibt <span className="font-mono">dlq</span>. Der Hinweis überschreibt
                  den aktuellen DLQ-Reason und wird im Audit-Log mit Operator-ID festgehalten.
                </p>
              ) : null}
              <label className="mt-4 block text-sm font-medium text-neutral-800">
                Begründung (Pflicht)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-md border border-neutral-300 p-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none"
                placeholder={
                  dialog.mode === 'reject'
                    ? 'Warum bleibt dieser Job in DLQ? Was muss als Nächstes passieren?'
                    : 'Kurz beschreiben, warum diese Auflösung korrekt ist.'
                }
              />
              {submitError ? (
                <p className="mt-2 text-xs text-rose-700">{submitError}</p>
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelAction}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
                  disabled={submitting}
                >
                  Abbrechen
                </button>
                <button
                  type="button"
                  onClick={() => void submitAction()}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60"
                  disabled={submitting}
                >
                  {submitting ? 'Sende…' : 'Bestätigen'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  )
}
