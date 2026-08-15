import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Search, UserPlus } from 'lucide-react'
import AppShell from '../components/AppShell'
import RotateCodeConfirmDialog from '../components/team/RotateCodeConfirmDialog'
import WelcomeCodeSheet from '../components/team/WelcomeCodeSheet'
import { useSession } from '../hooks/useSession'
import { getMyProviderProfile } from '../lib/providers'
import { getMyCompanyJoinCode } from '../lib/company/joinCode'
import {
  getCodeAuditLog,
  sendCodeByEmail,
  type CodeAuditEntry,
} from '../lib/company/codeRotation'
import { rotateCompanyCodeWorkflow } from '../lib/workflow/companyCodeWorkflow'
import { deriveRotationDisabledReason } from '../lib/company/codeRotationSelectors'
import { getTeamMembers, subscribeTeamMembers } from '../lib/team'
import { useSmartBack } from '../hooks/useSmartBack'
import type { TeamMember } from '../lib/jobs/types'

function formatRotatedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function CraftsmanTeamSettingsScreen() {
  const goBack = useSmartBack('/craftsman/team')
  const { user } = useSession()

  const [providerId, setProviderId] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [audit, setAudit] = useState<CodeAuditEntry[]>([])
  const [members, setMembers] = useState<TeamMember[]>(
    getTeamMembers().filter((m) => m.role !== 'owner'),
  )
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(true)
  const memberCount = members.filter((m) => m.isActive !== false).length
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'error' | null>(null)

  useEffect(() => {
    const update = (): void => {
      setMembers(getTeamMembers().filter((m) => m.role !== 'owner'))
    }
    const unsubscribe = subscribeTeamMembers(update)
    update()
    return unsubscribe
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!user) return
      const profile = await getMyProviderProfile()
      if (cancelled || !profile) return
      setProviderId(profile.id)
      const codeResult = await getMyCompanyJoinCode(user.id)
      if (cancelled) return
      setCode(codeResult?.code ?? null)
      const auditList = await getCodeAuditLog(profile.id)
      if (cancelled) return
      setAudit(auditList)
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  const rateLimitReached = deriveRotationDisabledReason(audit) === 'rate_limit'

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return members
      .filter((m) => (showInactive ? true : m.isActive !== false))
      .filter((m) => {
        if (q.length === 0) return true
        const haystack = [m.name, m.role, m.email, m.phone]
          .filter((v): v is string => Boolean(v))
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => {
        // Active first, then alphabetical by name.
        const aActive = a.isActive !== false ? 0 : 1
        const bActive = b.isActive !== false ? 0 : 1
        if (aActive !== bActive) return aActive - bActive
        return a.name.localeCompare(b.name, 'de')
      })
  }, [members, search, showInactive])

  const inactiveCount = members.filter((m) => m.isActive === false).length
  const stubCount = members.filter((m) => !m.userId && m.isActive !== false).length

  async function handleConfirm(): Promise<void> {
    if (!providerId) return
    setPending(true)
    setFeedback(null)
    setFeedbackKind(null)
    try {
      const result = await rotateCompanyCodeWorkflow(providerId, undefined)
      if (result.ok) {
        setCode(result.newCode)
        const refreshed = await getCodeAuditLog(providerId)
        setAudit(refreshed)
        setFeedback('Neuer Code aktiv. Der alte ist sofort ungültig.')
        setFeedbackKind('success')
        setDialogOpen(false)
      } else {
        setFeedback(result.error)
        setFeedbackKind('error')
      }
    } catch {
      setFeedback('Rotation fehlgeschlagen.')
      setFeedbackKind('error')
    } finally {
      setPending(false)
    }
  }

  return (
    <AppShell>
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[480px] space-y-6">
          <header>
            <button
              type="button"
              onClick={goBack}
              className="text-[13px] font-medium text-slate-500"
            >
              ← Zurück
            </button>
            <h1 className="mt-2 text-[22px] font-semibold text-slate-900">
              Team-Einstellungen
            </h1>
            <p className="mt-1 text-[13px] text-slate-500">
              Verwalte deinen Beitritts-Code und sieh, wann er zuletzt erneuert wurde.
            </p>
          </header>

          {code ? (
            <WelcomeCodeSheet code={code} onSendEmail={sendCodeByEmail} />
          ) : (
            <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 text-[13px] text-amber-900">
              Kein aktiver Code gefunden. Lade die Seite neu oder kontaktiere den Support.
            </div>
          )}

          <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-semibold text-slate-900">Mitarbeiter</h2>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {memberCount} aktiv
                  {stubCount > 0 ? ` · ${stubCount} vorbereitet` : ''}
                  {inactiveCount > 0 ? ` · ${inactiveCount} deaktiviert` : ''}
                </p>
              </div>
              <Link
                to="/craftsman/team/new"
                data-testid="member-create-link"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-slate-900 px-3 py-2 text-[12px] font-semibold text-white"
              >
                <UserPlus size={14} aria-hidden /> Anlegen
              </Link>
            </div>

            {members.length === 0 ? (
              <p className="mt-3 text-[13px] text-slate-500">
                Noch keine Mitarbeiter. Lege jetzt einen ersten Eintrag an oder teile den Code
                oben, damit Mitarbeiter selbst beitreten.
              </p>
            ) : (
              <>
                <div className="mt-3 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search
                      size={14}
                      aria-hidden
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                    />
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Suchen — Name, Gewerk, E-Mail…"
                      className="w-full rounded-2xl bg-slate-50 py-2 pl-7 pr-3 text-[13px] text-slate-900 ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                  {inactiveCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowInactive((v) => !v)}
                      className={`shrink-0 rounded-full px-3 py-2 text-[12px] font-semibold ring-1 transition ${
                        showInactive
                          ? 'bg-slate-100 text-slate-700 ring-slate-200'
                          : 'bg-white text-slate-500 ring-slate-200'
                      }`}
                    >
                      {showInactive ? 'Inaktive aus' : 'Inaktive ein'}
                    </button>
                  )}
                </div>

                {filteredMembers.length === 0 ? (
                  <p className="mt-3 text-[13px] text-slate-500">
                    Keine Treffer.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-1.5" data-testid="member-list">
                    {filteredMembers.map((m) => {
                      const inactive = m.isActive === false
                      const isStub = !m.userId
                      return (
                        <li key={m.id}>
                          <Link
                            to={`/craftsman/team/${m.id}`}
                            className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100 transition active:scale-[0.99]"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[12px] font-bold text-slate-600">
                                {m.name.slice(0, 2).toUpperCase() || '–'}
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-[14px] font-semibold text-slate-900">
                                  {m.name || 'Ohne Name'}
                                </div>
                                <div className="text-[11px] text-slate-500 truncate">
                                  {m.role || '–'}
                                  {m.email ? ` · ${m.email}` : ''}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {inactive ? (
                                <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                  Inaktiv
                                </span>
                              ) : isStub ? (
                                <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                                  Vorbereitet
                                </span>
                              ) : null}
                              <ChevronRight size={14} className="text-slate-400" aria-hidden />
                            </div>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
            <h2 className="text-[16px] font-semibold text-slate-900">Code rotieren</h2>
            <p className="mt-1 text-[13px] text-slate-500 leading-relaxed">
              Erstellt einen neuen Beitritts-Code. Der alte wird sofort ungültig.
              Bestehende Mitarbeiter bleiben im Team.
            </p>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={!providerId || pending || rateLimitReached}
              data-testid="rotate-code-trigger"
              className="mt-4 w-full rounded-full bg-rose-600 py-3 text-[14px] font-semibold text-white disabled:bg-slate-300"
            >
              {rateLimitReached ? 'Tageslimit erreicht' : 'Code rotieren'}
            </button>
            {feedback ? (
              <p
                data-testid="rotate-code-feedback"
                className={`mt-3 text-[13px] ${
                  feedbackKind === 'error' ? 'text-rose-600' : 'text-emerald-700'
                }`}
              >
                {feedback}
              </p>
            ) : null}
          </section>

          <section className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
            <h2 className="text-[16px] font-semibold text-slate-900">Verlauf</h2>
            {audit.length === 0 ? (
              <p className="mt-2 text-[13px] text-slate-500">
                Noch keine Rotationen aufgezeichnet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2" data-testid="rotate-code-audit-list">
                {audit.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2 text-[13px] text-slate-700"
                  >
                    <span>{formatRotatedAt(entry.rotatedAt)}</span>
                    {entry.reason ? (
                      <span className="text-[12px] text-slate-500">{entry.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </section>

      <RotateCodeConfirmDialog
        open={dialogOpen}
        activeMemberCount={memberCount}
        rateLimitReached={rateLimitReached}
        pending={pending}
        onConfirm={handleConfirm}
        onCancel={() => setDialogOpen(false)}
      />
    </AppShell>
  )
}
