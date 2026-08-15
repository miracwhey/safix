import { useState } from 'react'
import { usePersistenceErrors } from '../../hooks/usePersistenceErrors'
import { useRecoveryStatus } from '../../hooks/useRecoveryStatus'
import {
  hasPersistenceFailures,
  getPendingMutationsSnapshot,
  clearPersistenceFailures,
  markRecoveryStarted,
  describeError,
} from '../../lib/persistence'
import { resyncRepositories } from '../../lib/bootstrap'
import { flushPendingMutations } from '../../lib/persistence/flushPendingMutations'
import { retryFailedUploads } from '../../lib/media/outboxRunner'
import { logInfo, logError } from '../../lib/observability'

export default function SyncStatusBar() {
  const { hasEscalatedErrors, escalatedFailures, failures } = usePersistenceErrors()
  const isRecovering = useRecoveryStatus()
  const [syncing, setSyncing] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  // Disclosure for the production-safe diagnostic dump. Hidden by default;
  // user must explicitly tap "Technische Details" to reveal — keeps the
  // sheet visually clean for end users while giving real-device testers a
  // way to read the actual reject reason without Safari Web Inspector.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  // Suppress the passive failure banner while a resume-driven recovery
  // cycle is active.  Without this guard the banner can flash on iOS
  // resume: a stale optimistic failure is briefly re-incremented by the
  // first flush attempt before the resync wave clears it.  The
  // user-initiated retry (`syncing`) bypasses suppression so an explicit
  // tap on "Erneut versuchen" stays visible.  The recovery flag is
  // hard-capped at 10 s by handleAppResume — even a hung wave cannot
  // suppress real persistent failures indefinitely.
  if (isRecovering && !syncing) return null
  if (!hasEscalatedErrors && !syncing) return null

  const handleResync = async () => {
    setDetailOpen(false)
    setSyncing(true)
    // Mark this retry as a recovery cycle.  Two reasons:
    //   1. handleAppResume already wraps its work in markRecoveryStarted —
    //      the explicit retry must use the same primitive so a concurrent
    //      resume cannot race against the user's tap.
    //   2. The recovery flag is the single signal queued-domain producers
    //      (notably calendarStore.syncCalendarEntriesForJobs) can read to
    //      decide whether they're inside a recovery wave; it future-proofs
    //      the suppression contract without scattering retry-specific
    //      branches across the codebase.
    const finishRecovery = markRecoveryStarted()
    // Snapshot what is queued + escalated at click time so a stuck retry on
    // a real device can be diagnosed via Sentry breadcrumbs without a
    // visible debug marker in the release bundle.
    logInfo('sync_status_bar.retry.start', {
      escalatedCount: escalatedFailures.length,
      escalatedDomains: [...new Set(escalatedFailures.map((f) => f.domain))],
      pending: getPendingMutationsSnapshot(),
    })
    try {
      // Clear the failure store at the START of the retry.  This makes the
      // user's tap genuinely "do something" — without it, a permanent-kind
      // failure (RLS deny / NOT NULL / 23505 / 42501) was being recorded
      // again by syncCalendarEntriesForJobs subscribers DURING resync, then
      // resyncRepositories' own clearPersistenceFailures wiped state in a
      // race the post-resync subscriber-driven failure record won.  By
      // clearing first we hand the retry a clean slate; if the underlying
      // error is permanent the failure store re-fills naturally during
      // flush + resync and the banner re-shows with up-to-date counts.
      // If the error was transient, the banner clears for real.
      // calendarStore.syncCalendarEntriesForJobs guards on
      // hasPersistenceFailureForEntity so the firehose loop (which kept
      // re-recording the same failure during resync) cannot fire here.
      clearPersistenceFailures()

      // Step 1: replay pending mutations — the real recovery path for queued writes.
      // Successful replays are removed from the queue.  Stale orphans are
      // pruned inside `flushPendingMutations` and counted into `dropped`.
      const { flushed, remaining, dropped } = await flushPendingMutations()

      // Step 1b: re-arm failed media uploads. The media outbox is a separate
      // durable queue from the pendingMutation store; without this the retry
      // button would silently ignore exhausted photo/video uploads that
      // escalated their own permanent failure into this same banner.
      await retryFailedUploads()

      // Step 2: always run a full DB reconciliation on user-initiated retry —
      // even when the queue drained cleanly the user expects a deterministic
      // "I tried" outcome, and resyncRepositories' calendar drain is what
      // surfaces any subscriber-driven write failure that fired during the
      // initialize cascade.  Skipping resync here would let a stale local
      // cache continue to disagree with the DB invisibly.
      await resyncRepositories()
      logInfo('sync_status_bar.retry.end', {
        flushed,
        remaining,
        dropped,
        ranResync: true,
        residualPending: getPendingMutationsSnapshot().length,
        residualFailures: hasPersistenceFailures(),
      })
    } catch (err) {
      // Failures retained — bar stays visible for the next retry attempt.
      logError('sync_status_bar.retry.error', err as Error, {
        residualPending: getPendingMutationsSnapshot().length,
      })
    } finally {
      finishRecovery()
      setSyncing(false)
    }
  }

  const domains = [...new Set(escalatedFailures.map((f) => f.domain))]
  const count = escalatedFailures.length

  // Sit above BottomNav: nav content ≈ 3.5rem + safe-area padding
  const barBottom = 'calc(max(6px, env(safe-area-inset-bottom)) + 4rem)'

  return (
    <>
      <div
        className="fixed inset-x-0 z-40 flex justify-center px-4"
        style={{ bottom: barBottom }}
      >
        {syncing ? (
          <div className="flex w-full max-w-[430px] items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2.5 shadow-sm">
            <span className="text-[13px] font-medium text-blue-700">
              Synchronisierung läuft…
            </span>
          </div>
        ) : (
          <button
            onClick={() => setDetailOpen(true)}
            className="flex w-full max-w-[430px] items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 shadow-sm active:opacity-80"
          >
            <span className="min-w-0 flex-1 text-left text-[13px] font-medium text-red-700">
              {count === 1
                ? '1 Änderung wartet auf Synchronisierung'
                : `${count} Änderungen warten auf Synchronisierung`}
            </span>
            <span className="shrink-0 text-[12px] font-semibold text-red-600">
              Details
            </span>
          </button>
        )}
      </div>

      {detailOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/40"
          onClick={() => setDetailOpen(false)}
        >
          <div
            className="w-full rounded-t-3xl bg-white px-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 h-1 w-10 rounded-full bg-slate-200 mx-auto" />

            <h2 className="mt-4 text-[16px] font-semibold text-slate-900">
              {count === 1
                ? '1 Änderung konnte nicht synchronisiert werden'
                : `${count} Änderungen konnten nicht synchronisiert werden`}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
              Die Änderungen sind lokal gespeichert. Mit einem erneuten Versuch
              werden sie in die Cloud übertragen.
            </p>

            {domains.length > 0 && (
              <div className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4">
                {domains.map((domain) => {
                  const n = escalatedFailures.filter((f) => f.domain === domain).length
                  return (
                    <div
                      key={domain}
                      className="flex items-center justify-between text-[13px]"
                    >
                      <span className="capitalize text-slate-700">{domain}</span>
                      <span className="text-slate-400">
                        {n} {n === 1 ? 'Änderung' : 'Änderungen'}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            <button
              onClick={handleResync}
              className="mt-5 w-full rounded-2xl bg-slate-900 py-3.5 text-[14px] font-semibold text-white active:opacity-80"
            >
              Erneut versuchen
            </button>

            {/* Production-safe diagnostic disclosure.  Renders only fields
                already considered telemetry-safe: domain, entityId,
                operation, kind, permanent flag, error.code/status/name,
                truncated error.message, plus the pending-queue snapshot
                (no payload).  Lets a real-device tester surface the actual
                reject reason without Safari Web Inspector. */}
            <button
              onClick={() => setDiagnosticsOpen((o) => !o)}
              className="mt-3 w-full text-center text-[12px] text-slate-500 underline active:opacity-60"
            >
              {diagnosticsOpen ? 'Technische Details ausblenden' : 'Technische Details anzeigen'}
            </button>
            {diagnosticsOpen && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] leading-snug text-slate-700">
                <div className="font-semibold text-slate-900">
                  Failures ({failures.length})
                </div>
                {failures.length === 0 && (
                  <div className="text-slate-400">— keine Failure-Records —</div>
                )}
                {failures.map((f, i) => {
                  const e = describeError(f.error)
                  return (
                    <div key={`${f.domain}-${f.entityId}-${i}`} className="mt-1.5 break-all">
                      <div>· {f.domain}/{f.operation} {f.entityId}</div>
                      <div>
                        &nbsp;&nbsp;kind: {f.kind}
                        {f.permanent ? ' · permanent' : ''}
                        {f.autoRecoveryAttempts !== undefined && f.autoRecoveryAttempts > 0
                          ? ` · attempts: ${f.autoRecoveryAttempts}`
                          : ''}
                      </div>
                      {e.code && <div>&nbsp;&nbsp;code: {e.code}</div>}
                      {e.status !== undefined && <div>&nbsp;&nbsp;status: {e.status}</div>}
                      {e.name && <div>&nbsp;&nbsp;name: {e.name}</div>}
                      {e.message && <div>&nbsp;&nbsp;msg: {e.message}</div>}
                    </div>
                  )
                })}
                {(() => {
                  const queue = getPendingMutationsSnapshot()
                  return (
                    <>
                      <div className="mt-3 font-semibold text-slate-900">
                        Pending Queue ({queue.length})
                      </div>
                      {queue.length === 0 && (
                        <div className="text-slate-400">— Queue leer —</div>
                      )}
                      {queue.map((p, i) => (
                        <div key={`q-${p.entityId}-${i}`} className="mt-1 break-all">
                          · {p.domain}/{p.operation} {p.entityId}
                          <div>
                            &nbsp;&nbsp;retries: {p.retryCount} · age:{' '}
                            {Math.round(p.ageMs / 1000)}s
                            {p.userId ? ` · uid: ${p.userId.slice(0, 8)}…` : ''}
                          </div>
                        </div>
                      ))}
                    </>
                  )
                })()}
              </div>
            )}

            <button
              onClick={() => setDetailOpen(false)}
              className="mt-3 w-full rounded-2xl py-2.5 text-[13px] text-slate-400 active:opacity-60"
            >
              Schließen
            </button>
          </div>
        </div>
      )}
    </>
  )
}
