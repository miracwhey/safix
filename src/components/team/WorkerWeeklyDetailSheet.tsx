import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Pencil, X } from 'lucide-react'

import Spinner from '../system/Spinner'
import { rejectTimeEntryWorkflow } from '../../lib/workflow/timeEntryWorkflow'
import { computeElapsedMinutes } from '../../lib/team/timeEntrySelectors'
import type { TimeEntry } from '../../lib/team/timeEntryTypes'

type Props = {
  open: boolean
  memberName: string
  /** Raw weekly target in hours (not multiplied) — needed for edit round-trip. */
  weeklyTargetHours: number | null
  entries: TimeEntry[]
  weekLabel: string
  istMinutes: number
  sollMinutes: number | null
  onClose: () => void
  onUpdateSoll?: (hours: number | null) => Promise<{ ok: boolean; error?: string }>
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

function formatTime(iso: string | null): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

function formatHoursMinutes(totalMinutes: number): string {
  const safe = Math.max(0, Math.floor(totalMinutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${h}:${m.toString().padStart(2, '0')}`
}

export default function WorkerWeeklyDetailSheet(props: Props): ReactNode {
  if (!props.open) return null
  return <SheetBody {...props} />
}

function SheetBody({
  memberName,
  weeklyTargetHours,
  entries,
  weekLabel,
  istMinutes,
  sollMinutes,
  onClose,
  onUpdateSoll,
}: Omit<Props, 'open'>) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reasonInputId, setReasonInputId] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  const mountedRef = useRef(true)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  const [editingSoll, setEditingSoll] = useState(false)
  const [sollInputStr, setSollInputStr] = useState('')
  const [sollSaving, setSollSaving] = useState(false)
  const [sollSaveError, setSollSaveError] = useState<string | null>(null)

  function startSollEdit(): void {
    setSollInputStr(weeklyTargetHours != null ? String(weeklyTargetHours) : '')
    setSollSaveError(null)
    setEditingSoll(true)
  }

  function cancelSollEdit(): void {
    setEditingSoll(false)
    setSollSaveError(null)
  }

  async function saveSoll(): Promise<void> {
    if (!onUpdateSoll) return
    const trimmed = sollInputStr.trim()
    const hours = trimmed === '' ? null : Number(trimmed)
    if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 168)) {
      setSollSaveError('Ungültig (0–168 h)')
      return
    }
    setSollSaving(true)
    setSollSaveError(null)
    const result = await onUpdateSoll(hours)
    if (!mountedRef.current) return
    setSollSaving(false)
    if (result.ok) {
      setEditingSoll(false)
    } else {
      setSollSaveError(result.error ?? 'Speichern fehlgeschlagen.')
    }
  }

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // ESC closes the sheet (modal a11y), but only when no in-flight reject is
  // running — premature close could orphan the worker's confirmation step.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (pendingId) return
      if (editingSoll) {
        setEditingSoll(false)
        setSollSaveError(null)
        return
      }
      if (reasonInputId) {
        setReasonInputId(null)
        setReasonText('')
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pendingId, reasonInputId, editingSoll])

  // Focus the close-button on open so screen readers land inside the dialog
  // and TAB cycles within the panel naturally.
  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  function startReject(entryId: string): void {
    setReasonInputId(entryId)
    setReasonText('')
    setError(null)
  }

  function cancelReject(): void {
    setReasonInputId(null)
    setReasonText('')
  }

  async function confirmReject(entryId: string): Promise<void> {
    const trimmed = reasonText.trim()
    if (!trimmed) {
      setError('Bitte einen Grund angeben.')
      return
    }
    if (trimmed.length > 200) {
      setError('Begründung zu lang (max. 200 Zeichen).')
      return
    }
    setPendingId(entryId)
    setError(null)
    try {
      await rejectTimeEntryWorkflow(entryId, trimmed)
      if (mountedRef.current) {
        setReasonInputId(null)
        setReasonText('')
      }
    } catch {
      if (mountedRef.current) setError('Eintrag konnte nicht abgelehnt werden.')
    } finally {
      if (mountedRef.current) setPendingId(null)
    }
  }

  // Sort entries: latest first, day before job
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.startedAt === b.startedAt) return a.kind === 'day' ? -1 : 1
    return a.startedAt > b.startedAt ? -1 : 1
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-weekly-detail-title"
      data-testid="worker-weekly-detail-sheet"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="max-h-[90dvh] w-full max-w-[480px] overflow-y-auto rounded-t-3xl bg-white p-5 shadow-[0_-12px_32px_-12px_rgba(2,6,23,0.18)] sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="worker-weekly-detail-title" className="text-[18px] font-semibold text-slate-900">
              {memberName}
            </h2>
            <p className="mt-0.5 text-[13px] text-slate-500">{weekLabel}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-slate-50 p-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Ist</div>
            <div className="mt-0.5 text-[18px] font-semibold tabular-nums text-slate-900">
              {formatHoursMinutes(istMinutes)} h
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Soll</span>
              {onUpdateSoll && !editingSoll && (
                <button
                  type="button"
                  onClick={startSollEdit}
                  aria-label="Soll bearbeiten"
                  className="rounded p-0.5 text-slate-400 hover:text-slate-600 active:scale-95"
                >
                  <Pencil size={11} aria-hidden />
                </button>
              )}
            </div>
            {editingSoll ? (
              <div className="mt-1 space-y-1">
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    step={1}
                    value={sollInputStr}
                    onChange={(e) => setSollInputStr(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveSoll()
                      if (e.key === 'Escape') cancelSollEdit()
                    }}
                    aria-label="Wochenstunden Soll"
                    className="w-14 rounded-lg bg-white px-2 py-1 text-[15px] font-semibold tabular-nums text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <span className="text-[13px] text-slate-500">h</span>
                  <button
                    type="button"
                    onClick={() => void saveSoll()}
                    disabled={sollSaving}
                    aria-label="Speichern"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-50"
                  >
                    {sollSaving
                      ? <Spinner size="sm" tone="current" inButton />
                      : <Check size={11} aria-hidden />}
                  </button>
                  <button
                    type="button"
                    onClick={cancelSollEdit}
                    disabled={sollSaving}
                    aria-label="Abbrechen"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-600 disabled:opacity-50"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </div>
                {sollSaveError && (
                  <p className="text-[11px] text-rose-600">{sollSaveError}</p>
                )}
              </div>
            ) : (
              <div className="mt-0.5 text-[18px] font-semibold tabular-nums text-slate-900">
                {sollMinutes != null ? `${formatHoursMinutes(sollMinutes)} h` : '–'}
              </div>
            )}
          </div>
        </div>

        {error ? (
          <p className="mt-3 rounded-2xl bg-rose-50 px-3 py-2 text-[13px] text-rose-700 ring-1 ring-rose-100">
            {error}
          </p>
        ) : null}

        <div className="mt-4">
          {sortedEntries.length === 0 ? (
            <p className="text-[13px] text-slate-500">Keine Einträge in dieser Woche.</p>
          ) : (
            <ul className="space-y-2">
              {sortedEntries.map((entry) => {
                const isJob = entry.kind === 'job'
                const isReason = reasonInputId === entry.id
                const isPending = pendingId === entry.id
                const minutesDisplayed =
                  entry.durationMinutes ?? computeElapsedMinutes(entry.startedAt, new Date())
                const statusBadge =
                  entry.status === 'rejected'
                    ? { label: 'abgelehnt', cls: 'bg-rose-50 text-rose-700 ring-rose-100' }
                    : entry.status === 'closed'
                      ? { label: 'geschlossen', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }
                      : { label: 'aktiv', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-100' }
                return (
                  <li
                    key={entry.id}
                    className="rounded-2xl bg-white p-3 ring-1 ring-slate-200/70 shadow-[0_4px_16px_-12px_rgba(2,6,23,0.18)]"
                    data-testid={`weekly-detail-entry-${entry.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-slate-900">
                            {isJob ? 'Auftrag' : 'Tag'}
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusBadge.cls}`}
                          >
                            {statusBadge.label}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[12px] text-slate-500">
                          {formatDate(entry.startedAt)} · {formatTime(entry.startedAt)}–
                          {formatTime(entry.endedAt)}
                        </div>
                        {entry.note ? (
                          <p className="mt-1 text-[12px] text-slate-600">„{entry.note}"</p>
                        ) : null}
                        {entry.rejectedReason ? (
                          <p className="mt-1 rounded-md bg-rose-50 px-2 py-1 text-[12px] text-rose-700">
                            Begründung: {entry.rejectedReason}
                          </p>
                        ) : null}
                      </div>
                      <div className="text-right">
                        <div className="text-[14px] font-semibold tabular-nums text-slate-900">
                          {formatHoursMinutes(minutesDisplayed)} h
                        </div>
                      </div>
                    </div>

                    {entry.status === 'closed' && !isReason ? (
                      <button
                        type="button"
                        onClick={() => startReject(entry.id)}
                        className="mt-2 inline-flex rounded-full bg-rose-50 px-3 py-1 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-100"
                        data-testid={`weekly-detail-reject-${entry.id}`}
                      >
                        Ablehnen
                      </button>
                    ) : null}

                    {isReason ? (
                      <div className="mt-3 space-y-2">
                        <textarea
                          value={reasonText}
                          onChange={(e) => setReasonText(e.target.value)}
                          rows={2}
                          maxLength={200}
                          placeholder="Grund — z.B. Pause vergessen"
                          className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[13px] ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-rose-300"
                          data-testid={`weekly-detail-reason-input-${entry.id}`}
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={cancelReject}
                            disabled={isPending}
                            className="rounded-full bg-slate-100 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                          >
                            Abbrechen
                          </button>
                          <button
                            type="button"
                            onClick={() => confirmReject(entry.id)}
                            disabled={isPending}
                            data-testid={`weekly-detail-confirm-reject-${entry.id}`}
                            className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                          >
                            {isPending ? (
                              <Spinner size="sm" tone="current" inButton />
                            ) : null}
                            {isPending ? 'Lehne ab…' : 'Ablehnen'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
