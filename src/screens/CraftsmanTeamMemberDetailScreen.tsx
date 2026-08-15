import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, UserMinus, UserCheck } from 'lucide-react'
import AppShell from '../components/AppShell'
import { useSession } from '../hooks/useSession'
import {
  deactivateTeamMember,
  getTeamMemberAuditLog,
  getTeamMemberDetail,
  reactivateTeamMember,
  updateTeamMember,
  type TeamMemberAuditEntry,
  type TeamMemberDetail,
  type TeamMemberMutationResult,
} from '../lib/team/ownerActions'
import { useSmartBack } from '../hooks/useSmartBack'

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('de-DE', {
    day:    '2-digit',
    month:  '2-digit',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  })
}

function actionLabel(action: TeamMemberAuditEntry['action']): string {
  switch (action) {
    case 'update':     return 'Daten geändert'
    case 'deactivate': return 'Deaktiviert'
    case 'reactivate': return 'Reaktiviert'
  }
}

export default function CraftsmanTeamMemberDetailScreen() {
  const { memberId } = useParams<{ memberId: string }>()
  const goBack = useSmartBack('/craftsman/team')
  const { user } = useSession()

  const [detail, setDetail] = useState<TeamMemberDetail | null>(null)
  const [audit, setAudit] = useState<TeamMemberAuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Form state
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [weeklyHours, setWeeklyHours] = useState('')
  const [dailyHours, setDailyHours] = useState('')
  const [savePending, setSavePending] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Status action state
  const [statusPending, setStatusPending] = useState(false)
  const [statusConfirm, setStatusConfirm] = useState<'deactivate' | 'reactivate' | null>(null)

  const refresh = useCallback(async () => {
    if (!memberId) return
    setLoading(true)
    setLoadError(null)
    try {
      const [d, a] = await Promise.all([
        getTeamMemberDetail(memberId),
        getTeamMemberAuditLog(memberId),
      ])
      if (!d) {
        setLoadError('Mitarbeiter nicht gefunden oder kein Zugriff.')
        setDetail(null)
        setAudit([])
        return
      }
      setDetail(d)
      setAudit(a)
      setFullName(d.fullName)
      setRole(d.role)
      setPhone(d.phone ?? '')
      setEmail(d.email ?? '')
      setWeeklyHours(d.weeklyTargetHours != null ? String(d.weeklyTargetHours) : '')
      setDailyHours(d.dailyTargetHours != null ? String(d.dailyTargetHours) : '')
    } catch {
      setLoadError('Laden fehlgeschlagen.')
    } finally {
      setLoading(false)
    }
  }, [memberId])

  useEffect(() => { void refresh() }, [refresh])

  const isSelf = Boolean(detail && user && detail.profileId === user.id)
  const isOwnerRow = detail?.role === 'owner'
  const isStub = Boolean(detail && !detail.profileId)
  const editLocked = !detail || isSelf || isOwnerRow

  const parsedWeekly = useMemo(() => {
    const t = weeklyHours.trim().replace(',', '.')
    if (t === '') return { ok: true, value: null as number | null }
    const n = Number(t)
    return Number.isFinite(n) && n >= 0 && n <= 168
      ? { ok: true, value: n }
      : { ok: false, value: null }
  }, [weeklyHours])

  const parsedDaily = useMemo(() => {
    const t = dailyHours.trim().replace(',', '.')
    if (t === '') return { ok: true, value: null as number | null }
    const n = Number(t)
    return Number.isFinite(n) && n >= 0 && n <= 24
      ? { ok: true, value: n }
      : { ok: false, value: null }
  }, [dailyHours])

  const hoursValid = parsedWeekly.ok && parsedDaily.ok

  const dirty = useMemo(() => {
    if (!detail) return false
    return (
      fullName.trim() !== detail.fullName ||
      role.trim() !== detail.role ||
      (phone.trim() || null) !== (detail.phone ?? null) ||
      (email.trim().toLowerCase() || null) !== (detail.email ?? null) ||
      parsedWeekly.value !== detail.weeklyTargetHours ||
      parsedDaily.value !== detail.dailyTargetHours
    )
  }, [detail, fullName, role, phone, email, parsedWeekly.value, parsedDaily.value])

  function showFeedback(result: TeamMemberMutationResult, successText: string): void {
    if (result.ok) {
      setFeedback({ kind: 'success', text: successText })
    } else {
      setFeedback({ kind: 'error', text: result.error })
    }
  }

  async function handleSave(): Promise<void> {
    if (!memberId || editLocked || !dirty || !hoursValid) return
    setSavePending(true)
    setFeedback(null)
    try {
      const result = await updateTeamMember(memberId, {
        fullName: fullName.trim(),
        role:     role.trim(),
        phone:    phone.trim() || null,
        email:    email.trim().toLowerCase() || null,
        weeklyTargetHours: parsedWeekly.value,
        dailyTargetHours:  parsedDaily.value,
      })
      showFeedback(result, 'Daten gespeichert.')
      if (result.ok) await refresh()
    } catch {
      setFeedback({ kind: 'error', text: 'Speichern fehlgeschlagen.' })
    } finally {
      setSavePending(false)
    }
  }

  async function handleStatusConfirm(): Promise<void> {
    if (!memberId || !statusConfirm) return
    setStatusPending(true)
    setFeedback(null)
    try {
      const result =
        statusConfirm === 'deactivate'
          ? await deactivateTeamMember(memberId)
          : await reactivateTeamMember(memberId)
      showFeedback(
        result,
        statusConfirm === 'deactivate' ? 'Mitarbeiter deaktiviert.' : 'Mitarbeiter reaktiviert.',
      )
      if (result.ok) await refresh()
    } catch {
      setFeedback({ kind: 'error', text: 'Aktion fehlgeschlagen.' })
    } finally {
      setStatusPending(false)
      setStatusConfirm(null)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[480px] space-y-5">
          <header>
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-500"
            >
              <ArrowLeft size={14} aria-hidden /> Zurück
            </button>
            <h1 className="mt-2 text-[22px] font-semibold text-slate-900">
              Mitarbeiter
            </h1>
          </header>

          {loading ? (
            <div className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 text-[13px] text-slate-500">
              Lade Daten…
            </div>
          ) : loadError || !detail ? (
            <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 text-[13px] text-amber-900">
              {loadError ?? 'Keine Daten.'}
            </div>
          ) : (
            <>
              {/* Identity card */}
              <div className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[14px] font-bold text-white">
                    {detail.fullName.slice(0, 2).toUpperCase() || '–'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-slate-900">
                      {detail.fullName || 'Ohne Name'}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                        {detail.role || '–'}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                          detail.isActive
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        {detail.isActive ? 'Aktiv' : 'Deaktiviert'}
                      </span>
                      {isOwnerRow && (
                        <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                          Inhaber
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 text-[12px] text-slate-500">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Mitglied seit
                    </div>
                    <div className="mt-0.5 text-slate-700">{formatDate(detail.createdAt)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Zuletzt geändert
                    </div>
                    <div className="mt-0.5 text-slate-700">{formatDate(detail.updatedAt)}</div>
                  </div>
                </div>

                {isStub && (
                  <p className="mt-4 rounded-xl bg-blue-50 px-3 py-2 text-[12px] text-blue-700 ring-1 ring-blue-100">
                    Vorbereitete Mitgliedschaft (kein verknüpftes Konto). Sobald sich der
                    Mitarbeiter mit dieser E-Mail per Beitritts-Code registriert, wird der
                    Eintrag automatisch verlinkt.
                  </p>
                )}
              </div>

              {/* Edit form */}
              <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
                <h2 className="text-[16px] font-semibold text-slate-900">Daten bearbeiten</h2>

                {(isSelf || isOwnerRow) && (
                  <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">
                    {isSelf
                      ? 'Eigene Daten können hier nicht geändert werden.'
                      : 'Inhaber-Datensatz ist gesperrt.'}
                  </p>
                )}

                <div className="mt-4 space-y-3">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Name
                    </span>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={editLocked || savePending}
                      className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Rolle / Gewerk
                    </span>
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      disabled={editLocked || savePending}
                      placeholder="z. B. Elektriker, Polier, Lehrling"
                      className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                    />
                    <span className="mt-1 block text-[11px] text-slate-400">
                      Frei wählbar. „owner“ kann hier nicht gesetzt werden.
                    </span>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                        Telefon
                      </span>
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        disabled={editLocked || savePending}
                        placeholder="+49 …"
                        className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                        E-Mail
                      </span>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={editLocked || savePending}
                        placeholder="kollege@firma.de"
                        className="mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                      />
                    </label>
                  </div>

                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                      Stundenziele
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Soll-Stunden für Auslastung. Lohn wird hier nicht hinterlegt.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <label className="block">
                        <span className="text-[11px] font-medium text-slate-500">
                          Wochenstunden
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={weeklyHours}
                          onChange={(e) => setWeeklyHours(e.target.value)}
                          disabled={editLocked || savePending}
                          placeholder="40"
                          className={`mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 focus:outline-none focus:ring-2 disabled:opacity-50 ${
                            parsedWeekly.ok
                              ? 'ring-slate-200 focus:ring-blue-400'
                              : 'ring-rose-300 focus:ring-rose-400'
                          }`}
                        />
                      </label>
                      <label className="block">
                        <span className="text-[11px] font-medium text-slate-500">
                          Tagesstunden
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={dailyHours}
                          onChange={(e) => setDailyHours(e.target.value)}
                          disabled={editLocked || savePending}
                          placeholder="8"
                          className={`mt-1 block w-full rounded-2xl bg-slate-50 px-3 py-2.5 text-[14px] text-slate-900 ring-1 focus:outline-none focus:ring-2 disabled:opacity-50 ${
                            parsedDaily.ok
                              ? 'ring-slate-200 focus:ring-blue-400'
                              : 'ring-rose-300 focus:ring-rose-400'
                          }`}
                        />
                      </label>
                    </div>
                    {!hoursValid && (
                      <p className="mt-1 text-[11px] text-rose-600">
                        Ungültiger Wert. Wochen 0–168, Tag 0–24.
                      </p>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => { void handleSave() }}
                  disabled={editLocked || savePending || !dirty || !hoursValid || fullName.trim().length === 0 || role.trim().length === 0}
                  data-testid="member-save"
                  className="mt-4 w-full rounded-full bg-slate-900 py-3 text-[14px] font-semibold text-white disabled:bg-slate-300"
                >
                  {savePending ? 'Speichere…' : 'Speichern'}
                </button>

                {feedback && (
                  <p
                    className={`mt-3 text-[13px] ${
                      feedback.kind === 'error' ? 'text-rose-600' : 'text-emerald-700'
                    }`}
                  >
                    {feedback.text}
                  </p>
                )}
              </section>

              {/* Status action */}
              {!isOwnerRow && !isSelf && (
                <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
                  <h2 className="text-[16px] font-semibold text-slate-900">Status</h2>
                  <p className="mt-1 text-[13px] text-slate-500 leading-relaxed">
                    {detail.isActive
                      ? 'Deaktivierte Mitarbeiter verlieren den Zugriff auf neue Aufträge. Vorhandene Einträge und Historie bleiben erhalten.'
                      : 'Reaktiviere, um den Mitarbeiter wieder im Team aktiv zu setzen.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setStatusConfirm(detail.isActive ? 'deactivate' : 'reactivate')}
                    disabled={statusPending}
                    data-testid="member-status-toggle"
                    className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full py-3 text-[14px] font-semibold disabled:bg-slate-300 ${
                      detail.isActive
                        ? 'bg-rose-600 text-white'
                        : 'bg-emerald-600 text-white'
                    }`}
                  >
                    {detail.isActive ? (
                      <>
                        <UserMinus size={16} aria-hidden /> Deaktivieren
                      </>
                    ) : (
                      <>
                        <UserCheck size={16} aria-hidden /> Reaktivieren
                      </>
                    )}
                  </button>
                </section>
              )}

              {/* Audit log */}
              <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
                <h2 className="text-[16px] font-semibold text-slate-900">Verlauf</h2>
                {audit.length === 0 ? (
                  <p className="mt-2 text-[13px] text-slate-500">
                    Noch keine Änderungen aufgezeichnet.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {audit.map((entry) => (
                      <li
                        key={entry.id}
                        className="rounded-2xl bg-slate-50 px-3 py-2 text-[13px] text-slate-700"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">{actionLabel(entry.action)}</span>
                          <span className="text-[11px] text-slate-500">
                            {formatDate(entry.createdAt)}
                          </span>
                        </div>
                        {entry.action === 'update' && entry.oldValues && entry.newValues && (
                          <div className="mt-1 text-[12px] text-slate-500 space-y-0.5">
                            {Object.keys(entry.newValues).map((key) => (
                              <div key={key}>
                                <span className="font-medium text-slate-600">{key}:</span>{' '}
                                <span className="line-through text-slate-400">
                                  {String(entry.oldValues?.[key] ?? '–')}
                                </span>{' '}
                                → {String(entry.newValues?.[key] ?? '–')}
                              </div>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </section>

      {statusConfirm && detail && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-[420px] rounded-[28px] bg-white p-5 shadow-2xl">
            <h2 className="text-[18px] font-semibold text-slate-900">
              {statusConfirm === 'deactivate'
                ? `${detail.fullName} deaktivieren?`
                : `${detail.fullName} reaktivieren?`}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
              {statusConfirm === 'deactivate'
                ? 'Mitarbeiter verliert sofort Zugriff auf neue Aufträge. Bestehende Einträge bleiben erhalten. Du kannst den Status jederzeit wieder umkehren.'
                : 'Mitarbeiter wird wieder als aktives Mitglied im Team geführt und kann zugewiesen werden.'}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { if (!statusPending) setStatusConfirm(null) }}
                disabled={statusPending}
                className="rounded-full bg-slate-100 py-3 text-[14px] font-semibold text-slate-700 disabled:opacity-50"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => { void handleStatusConfirm() }}
                disabled={statusPending}
                className={`rounded-full py-3 text-[14px] font-semibold text-white disabled:bg-slate-300 ${
                  statusConfirm === 'deactivate' ? 'bg-rose-600' : 'bg-emerald-600'
                }`}
              >
                {statusPending
                  ? 'Wird ausgeführt…'
                  : statusConfirm === 'deactivate'
                    ? 'Deaktivieren'
                    : 'Reaktivieren'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  )
}
