import { useCallback, useEffect, useState } from 'react'
import { getOpenReports, resolveReport, enforceReport } from '../../lib/moderation/operatorModerationService'
import type { UserReport, ReportStatus, ModerationActionType } from '../../lib/moderation/types'

const ENFORCE_ACTIONS: { action: ModerationActionType; label: string; style: string }[] = [
  { action: 'warn', label: 'Verwarnen', style: 'bg-amber-50 text-amber-700 ring-amber-200' },
  { action: 'suspend', label: 'Sperren (Zeit)', style: 'bg-orange-50 text-orange-700 ring-orange-200' },
  { action: 'ban', label: 'Bannen', style: 'bg-red-50 text-red-700 ring-red-200' },
  { action: 'dismiss', label: 'Verwerfen', style: 'bg-slate-50 text-slate-500 ring-slate-200' },
]

const STATUS_LABELS: Record<ReportStatus, string> = {
  pending: 'Offen',
  reviewed: 'In Prüfung',
  resolved: 'Gelöst',
  dismissed: 'Abgelehnt',
  actioned: 'Maßnahme ergriffen',
}

const STATUS_STYLES: Record<ReportStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 ring-amber-200',
  reviewed: 'bg-blue-100 text-blue-700 ring-blue-200',
  resolved: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  dismissed: 'bg-slate-100 text-slate-500 ring-slate-200',
  actioned: 'bg-rose-100 text-rose-700 ring-rose-200',
}

const REASON_LABELS: Record<string, string> = {
  harassment: 'Belästigung',
  spam: 'Spam',
  fraud: 'Betrug',
  inappropriate: 'Unangemessen',
  other: 'Sonstiges',
}

export default function OperatorReportsPanel() {
  const [reports, setReports] = useState<UserReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [suspendHours, setSuspendHours] = useState('24')
  const [pendingAction, setPendingAction] = useState<ModerationActionType | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const loadReports = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await getOpenReports()
      setReports(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Laden der Meldungen.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadReports()
  }, [loadReports])

  async function handleResolve(reportId: string, status: ReportStatus) {
    try {
      await resolveReport(reportId, status, notes || undefined)
      setActionId(null)
      setNotes('')
      await loadReports()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
    }
  }

  async function handleEnforce(report: UserReport, action: ModerationActionType) {
    setError(null)
    setSuccess(null)
    setPendingAction(action)
    try {
      const hours =
        action === 'suspend' ? Math.max(1, Math.floor(Number(suspendHours) || 0)) : undefined
      const result = await enforceReport({
        action,
        reportId: report.id,
        targetUserId: report.reportedUserId,
        notes: notes || undefined,
        suspendHours: hours,
        targetMessageId: action === 'hide_content' ? report.contextId : undefined,
      })
      const label =
        ENFORCE_ACTIONS.find((a) => a.action === action)?.label ?? action
      setSuccess(
        result.expiresAt
          ? `${label} ausgeführt — bis ${new Date(result.expiresAt).toLocaleString('de-DE')}.`
          : `${label} ausgeführt.`,
      )
      setActionId(null)
      setNotes('')
      await loadReports()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
    } finally {
      setPendingAction(null)
    }
  }

  if (loading) {
    return (
      <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-sm">
        <h2 className="text-[16px] font-semibold text-slate-900">Nutzermeldungen</h2>
        <p className="mt-3 text-[13px] text-slate-400">Lade Meldungen…</p>
      </div>
    )
  }

  return (
    <div className="rounded-[24px] bg-white p-5 ring-1 ring-slate-200/70 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold text-slate-900">
          Nutzermeldungen
        </h2>
        {reports.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200">
            {reports.length} offen
          </span>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 ring-1 ring-red-200">
          <p className="text-[12px] text-red-600">{error}</p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => void loadReports()}
              className="text-[11px] font-semibold text-red-600 underline"
              aria-label="Erneut laden"
            >
              Erneut
            </button>
            <button
              onClick={() => setError(null)}
              className="text-[15px] font-bold leading-none text-red-400 hover:text-red-600"
              aria-label="Fehler schließen"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {success && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-xl bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200">
          <p className="text-[12px] text-emerald-700">{success}</p>
          <button
            onClick={() => setSuccess(null)}
            className="shrink-0 text-[15px] font-bold leading-none text-emerald-400 hover:text-emerald-600"
            aria-label="Hinweis schließen"
          >
            ×
          </button>
        </div>
      )}

      {reports.length === 0 && !error && (
        <p className="mt-3 text-[13px] text-slate-400">
          Keine offenen Meldungen.
        </p>
      )}

      <div className="mt-3 space-y-3">
        {reports.map((report) => (
          <div
            key={report.id}
            className="rounded-[16px] bg-slate-50 p-4 ring-1 ring-slate-200/50"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-[13px] font-semibold text-slate-800">
                  {REASON_LABELS[report.reason] ?? report.reason}
                </span>
                <span
                  className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ring-1 ${STATUS_STYLES[report.status]}`}
                >
                  {STATUS_LABELS[report.status]}
                </span>
              </div>
              <span className="shrink-0 text-[11px] text-slate-400">
                {new Date(report.createdAt).toLocaleDateString('de-DE')}
              </span>
            </div>

            {report.context && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-slate-600">
                {report.context}
              </p>
            )}

            <div className="mt-2 flex gap-2 text-[11px] text-slate-400">
              <span>Melder: {report.reporterId.slice(0, 8)}…</span>
              <span>Gemeldet: {report.reportedUserId.slice(0, 8)}…</span>
            </div>

            {/* Action area */}
            {actionId === report.id ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Interne Notizen (optional)…"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => handleResolve(report.id, 'reviewed')}
                    className="rounded-lg bg-blue-50 px-3 py-1.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-200"
                  >
                    In Prüfung
                  </button>
                  <button
                    onClick={() => handleResolve(report.id, 'resolved')}
                    className="rounded-lg bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
                  >
                    Gelöst
                  </button>
                  <button
                    onClick={() => handleResolve(report.id, 'dismissed')}
                    className="rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200"
                  >
                    Abgelehnt
                  </button>
                  <button
                    onClick={() => { setActionId(null); setNotes('') }}
                    className="ml-auto text-[11px] text-slate-400"
                  >
                    Abbrechen
                  </button>
                </div>

                {/* Enforcement actions — operator_enforce_report RPC */}
                <div className="border-t border-slate-200/70 pt-2">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Maßnahme gegen Nutzer
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {ENFORCE_ACTIONS.map(({ action, label, style }) => (
                      <span key={action} className="inline-flex items-center gap-1">
                        {action === 'suspend' && (
                          <input
                            type="number"
                            min={1}
                            value={suspendHours}
                            onChange={(e) => setSuspendHours(e.target.value)}
                            aria-label="Sperrdauer in Stunden"
                            className="w-14 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-300"
                          />
                        )}
                        <button
                          onClick={() => void handleEnforce(report, action)}
                          disabled={pendingAction !== null}
                          className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold ring-1 disabled:opacity-50 ${style}`}
                        >
                          {pendingAction === action ? '…' : label}
                          {action === 'suspend' ? ' Std.' : ''}
                        </button>
                      </span>
                    ))}
                    {report.contextType === 'message' && report.contextId && (
                      <button
                        onClick={() => void handleEnforce(report, 'hide_content')}
                        disabled={pendingAction !== null}
                        className="rounded-lg bg-rose-50 px-3 py-1.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200 disabled:opacity-50"
                      >
                        {pendingAction === 'hide_content' ? '…' : 'Nachricht ausblenden'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setActionId(report.id)}
                className="mt-2 text-[11px] font-medium text-blue-600"
              >
                Bearbeiten →
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
