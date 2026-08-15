import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  MessageSquare,
  Phone,
  RotateCw,
  Search,
  Stethoscope,
  TrendingDown,
  UserPlus,
  Users,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import { ScreenHeader } from '../components/primitives'
import RotateCodeConfirmDialog from '../components/team/RotateCodeConfirmDialog'
import WelcomeCodeSheet from '../components/team/WelcomeCodeSheet'
import WorkerWeeklyDetailSheet from '../components/team/WorkerWeeklyDetailSheet'
import { useSession } from '../hooks/useSession'
import { useCorrections } from '../hooks/useCorrections'
import { getMyProviderProfile } from '../lib/providers'
import { getMyCompanyJoinCode } from '../lib/company/joinCode'
import {
  getCodeAuditLog,
  sendCodeByEmail,
  type CodeAuditEntry,
} from '../lib/company/codeRotation'
import {
  rotateAndMailStubWorkflow,
  rotateCompanyCodeWorkflow,
} from '../lib/workflow/companyCodeWorkflow'
import { deriveRotationDisabledReason } from '../lib/company/codeRotationSelectors'
import {
  getAbsences,
  getTeamMembers,
  getTimeEntries,
  isTimeEntriesHydrated,
  subscribeAbsences,
  subscribeTeamMembers,
  subscribeTimeEntries,
} from '../lib/team'
import type { Absence } from '../lib/team/absenceTypes'
import { deriveActiveSickToday } from '../lib/team/absenceSelectors'
import { requestSickNoteWorkflow } from '../lib/workflow/absenceWorkflow'
import { supabase } from '../lib/supabase'
import { SpringerConfirmSheet } from '../components/team/SpringerConfirmSheet'
import {
  getCalendarEntries,
  subscribeCalendar,
} from '../lib/calendar'
import { formatDateKey } from '../lib/calendar/calendarEngine'
import {
  getJobs,
  subscribeJobs,
} from '../lib/jobs'
import {
  deriveFilteredMembers,
  deriveTeamHubActionItems,
  deriveTeamHubCounts,
  deriveTodayRoster,
  deriveWeeklyHoursSoll,
  type RosterStatus,
  type TodayRosterEntry,
} from '../lib/team/teamHubSelectors'
import { updateTeamMember } from '../lib/team/ownerActions'
import {
  buildIstMinutesIndex,
  deriveHoursBarData,
  deriveUnderTargetMembers,
  type HoursColor,
  type UnderTargetMember,
  type WeekRange,
} from '../lib/team/timeEntrySelectors'
import { listTeamHubAudit, type TeamHubAuditEntry } from '../lib/team/teamHubAudit'
import type { TeamMember } from '../lib/jobs/types'
import type { TimeEntry } from '../lib/team/timeEntryTypes'

// ─────────────────────────────────────────────────────────────────────────────

const STATUS_CHIP: Record<RosterStatus, { label: string; cls: string }> = {
  on_site:        { label: 'auf Baustelle', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-100' },
  scheduled_today:{ label: 'eingeplant',    cls: 'bg-sky-50 text-sky-700 ring-sky-100' },
  free_today:     { label: 'frei',          cls: 'bg-slate-100 text-slate-600 ring-slate-200' },
  overloaded:     { label: 'überlastet',    cls: 'bg-rose-50 text-rose-700 ring-rose-100' },
  sick:           { label: 'krank',         cls: 'bg-amber-100 text-amber-800 ring-amber-200' },
}

function formatRotatedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function formatHoursMinutes(totalMinutes: number): string {
  const safe = Math.max(0, Math.floor(totalMinutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${h}:${m.toString().padStart(2, '0')}`
}

const BAR_COLOR_CLS: Record<HoursColor, string> = {
  gray: 'bg-slate-300',
  amber: 'bg-amber-500',
  blue: 'bg-blue-600',
  red: 'bg-rose-600',
}

/**
 * Computes the current Mon–Mon week range using the browser's local TZ.
 * For owners viewing in Berlin this matches their working week. Owners
 * abroad see their local week, which is acceptable for the MVP — server-
 * side aggregation can layer on TZ-aware logic later.
 */
function computeLocalWeekRange(now: Date = new Date()): WeekRange {
  const local = new Date(now)
  const day = local.getDay() // 0 = Sun
  const daysSinceMonday = (day + 6) % 7 // Mon = 0
  const monday = new Date(local)
  monday.setDate(local.getDate() - daysSinceMonday)
  monday.setHours(0, 0, 0, 0)
  const nextMonday = new Date(monday)
  nextMonday.setDate(monday.getDate() + 7)
  return { startIso: monday.toISOString(), endIso: nextMonday.toISOString() }
}

function weekLabelFromRange(range: WeekRange): string {
  const start = new Date(range.startIso)
  if (Number.isNaN(start.getTime())) return ''
  const isoWeek = computeIsoWeek(start)
  const dayLabel = start.toLocaleDateString('de-DE', { day: '2-digit', month: 'short' })
  return `KW ${isoWeek} · ab ${dayLabel}`
}

function computeIsoWeek(d: Date): number {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const diff = target.getTime() - firstThursday.getTime()
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000))
}

function formatRelativeDays(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'heute'
  if (days === 1) return 'gestern'
  return `vor ${days} Tg.`
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

function SectionShell({
  title,
  trailing,
  children,
}: {
  title: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-slate-900">{title}</h2>
        {trailing}
      </header>
      {children}
    </section>
  )
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join('') || '?'
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
      />
    )
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[12px] font-bold text-white">
      {initials}
    </div>
  )
}

function TodayRosterSection({
  entries,
  onRequestSickNote,
}: {
  entries: TodayRosterEntry[]
  onRequestSickNote: (absenceId: string) => void
}) {
  if (entries.length === 0) return null

  const todayLabel = new Date().toLocaleDateString('de-DE', {
    weekday: 'short', day: '2-digit', month: 'short',
  })

  return (
    <SectionShell title={`Heute · ${todayLabel}`}>
      <ul className="divide-y divide-slate-100">
        {entries.map((entry) => {
          const chip = STATUS_CHIP[entry.status]
          const primary = entry.assignments[0]
          const isSick = entry.status === 'sick' && entry.sickInfo
          return (
            <li key={entry.memberId} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Avatar name={entry.displayName} url={entry.avatarUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-slate-900">
                    {entry.displayName}
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${chip.cls}`}>
                    {isSick ? `Tag ${entry.sickInfo!.dayCount}` : chip.label}
                  </span>
                </div>
                {isSick ? (
                  <>
                    <div className="mt-0.5 truncate text-[12px] text-amber-700">
                      krankgemeldet{entry.sickInfo!.reasonNote ? ` · ${entry.sickInfo!.reasonNote}` : ''}
                    </div>
                    {entry.sickInfo!.sickNoteUrl ? (
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 ring-1 ring-green-100">
                          Attest eingereicht
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            const { data } = await supabase.storage
                              .from('sick-notes')
                              .createSignedUrl(entry.sickInfo!.sickNoteUrl!, 3600)
                            if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
                          }}
                          className="text-[11px] font-medium text-slate-500 underline hover:text-slate-700"
                        >
                          Anzeigen
                        </button>
                      </div>
                    ) : !entry.sickInfo!.sickNoteRequested ? (
                      <button
                        type="button"
                        onClick={() => onRequestSickNote(entry.sickInfo!.absenceId)}
                        className="mt-1.5 inline-flex items-center gap-1 rounded-xl bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-700 ring-1 ring-amber-100"
                      >
                        Krankschein anfordern
                      </button>
                    ) : (
                      <span className="mt-1.5 inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        Attest angefordert
                      </span>
                    )}
                  </>
                ) : primary ? (
                  <div className="mt-0.5 truncate text-[12px] text-slate-500">
                    {[primary.title, primary.location, primary.timeLabel]
                      .filter((s) => s && s.length > 0)
                      .join(' · ')}
                  </div>
                ) : entry.status === 'overloaded' ? (
                  <div className="mt-0.5 text-[12px] text-rose-700">
                    {entry.totalActiveJobs} aktive Aufträge — Auslastung prüfen
                  </div>
                ) : (
                  <div className="mt-0.5 text-[12px] text-slate-500">heute frei eingeplant</div>
                )}
                {!isSick && entry.assignments.length > 1 ? (
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    +{entry.assignments.length - 1} weitere heute
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {entry.phone ? (
                  <a
                    href={`tel:${entry.phone}`}
                    aria-label={`${entry.displayName} anrufen`}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition active:scale-[0.95]"
                  >
                    <Phone size={16} aria-hidden />
                  </a>
                ) : null}
                <Link
                  to="/craftsman/nachrichten"
                  aria-label="Team-Nachrichten öffnen"
                  className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-700 transition active:scale-[0.95]"
                >
                  <MessageSquare size={16} aria-hidden />
                </Link>
              </div>
            </li>
          )
        })}
      </ul>
    </SectionShell>
  )
}

function ActionItemsSection({
  openCorrectionsCount,
  pendingStubs,
  highLoadMembers,
  underTarget,
  sickToday,
  onSelectMember,
  onOpenSpringer,
}: {
  openCorrectionsCount: number
  pendingStubs: TeamMember[]
  highLoadMembers: { memberId: string; displayName: string; activeJobCount: number }[]
  underTarget: UnderTargetMember[]
  sickToday: { memberId: string; displayName: string; affectedJobCount: number }[]
  onSelectMember: (memberId: string) => void
  onOpenSpringer: (memberId: string) => void
}) {
  const hasAny =
    openCorrectionsCount > 0 ||
    pendingStubs.length > 0 ||
    highLoadMembers.length > 0 ||
    underTarget.length > 0 ||
    sickToday.length > 0
  if (!hasAny) return null

  return (
    <SectionShell title="Handlungsbedarf">
      <ul className="divide-y divide-slate-100">
        {openCorrectionsCount > 0 ? (
          <li className="flex items-start gap-3 py-3 first:pt-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
              <Clock size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900">
                {openCorrectionsCount} {openCorrectionsCount === 1 ? 'Stunden-Korrektur' : 'Stunden-Korrekturen'} warten
              </div>
              <Link
                to="/craftsman/korrekturen"
                className="mt-2 inline-flex rounded-xl bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-100"
              >
                Prüfen
              </Link>
            </div>
          </li>
        ) : null}

        {sickToday.map((s) => (
          <li key={`sick-${s.memberId}`} className="flex items-start gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <Stethoscope size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900">
                {s.displayName} ist krank
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                {s.affectedJobCount === 0
                  ? 'Keine offenen Aufträge — kein Springer nötig'
                  : `${s.affectedJobCount} ${s.affectedJobCount === 1 ? 'Auftrag' : 'Aufträge'} betroffen`}
              </div>
              {s.affectedJobCount > 0 && (
                <button
                  type="button"
                  onClick={() => onOpenSpringer(s.memberId)}
                  className="mt-2 inline-flex rounded-xl bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-700 ring-1 ring-amber-100"
                >
                  Springer einsetzen
                </button>
              )}
            </div>
          </li>
        ))}

        {pendingStubs.map((stub) => (
          <li key={stub.id} className="flex items-start gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <UserPlus size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900">
                {stub.name || 'Mitarbeiter'} wartet auf Beitritt
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                {stub.email
                  ? `Code an ${stub.email} senden`
                  : 'Code teilen — Mitarbeiter tritt selbst bei'}
              </div>
              <Link
                to={`/craftsman/team/${stub.id}`}
                className="mt-2 inline-flex rounded-xl bg-blue-50 px-3 py-1.5 text-[12px] font-semibold text-blue-700 ring-1 ring-blue-100"
              >
                Öffnen
              </Link>
            </div>
          </li>
        ))}

        {highLoadMembers.map((m) => (
          <li key={m.memberId} className="flex items-start gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900">
                {m.displayName} · hohe Auslastung
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                {m.activeJobCount} aktive Aufträge parallel
              </div>
              <Link
                to={`/craftsman/team/${m.memberId}`}
                className="mt-2 inline-flex rounded-xl bg-rose-50 px-3 py-1.5 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-100"
              >
                Detail öffnen
              </Link>
            </div>
          </li>
        ))}

        {underTarget.map((u) => (
          <li key={u.memberId} className="flex items-start gap-3 py-3 last:pb-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
              <TrendingDown size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-slate-900">
                {u.displayName} · unter Soll
              </div>
              <div className="mt-0.5 text-[12px] text-slate-500">
                {formatHoursMinutes(u.istMinutes)} h von {formatHoursMinutes(u.sollMinutes)} h
                {' '}({Math.round(u.pct)} %)
              </div>
              <button
                type="button"
                onClick={() => onSelectMember(u.memberId)}
                className="mt-2 inline-flex rounded-xl bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-800 ring-1 ring-amber-100"
                data-testid={`under-target-open-${u.memberId}`}
              >
                Woche prüfen
              </button>
            </div>
          </li>
        ))}
      </ul>
    </SectionShell>
  )
}

function MembersListSection({
  members,
  filterQuery,
  onFilterQueryChange,
  showInactive,
  onShowInactiveChange,
  inactiveCount,
  totalSearchableCount,
}: {
  members: TeamMember[]
  filterQuery: string
  onFilterQueryChange: (q: string) => void
  showInactive: boolean
  onShowInactiveChange: (v: boolean) => void
  inactiveCount: number
  totalSearchableCount: number
}) {
  const hasAnyMember = totalSearchableCount > 0
  const isFilteringActive = filterQuery.trim().length > 0
  return (
    <SectionShell
      title={`Mitarbeiter${members.length > 0 ? ` · ${members.length}` : ''}`}
      trailing={
        <Link
          to="/craftsman/team/new"
          data-testid="member-create-link"
          className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white"
        >
          <UserPlus size={13} aria-hidden /> Anlegen
        </Link>
      }
    >
      {hasAnyMember ? (
        <div className="mb-3 space-y-2">
          <label className="relative block">
            <span className="sr-only">Mitarbeiter suchen</span>
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              type="search"
              value={filterQuery}
              onChange={(e) => onFilterQueryChange(e.target.value)}
              placeholder="Suchen — Name, E-Mail, Rolle"
              data-testid="member-filter-input"
              className="w-full rounded-xl bg-slate-100 py-2 pl-9 pr-3 text-[13px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          {inactiveCount > 0 ? (
            <label className="flex items-center gap-2 text-[12px] text-slate-600">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => onShowInactiveChange(e.target.checked)}
                data-testid="member-inactive-toggle"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500"
              />
              Inaktive anzeigen
              <span className="ml-1 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                {inactiveCount}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      {members.length === 0 ? (
        <p className="text-[13px] text-slate-500">
          {isFilteringActive
            ? `Keine Treffer für „${filterQuery.trim()}".`
            : !showInactive && inactiveCount > 0
              ? 'Keine aktiven Mitarbeiter — Inaktive einblenden, um sie zu sehen.'
              : 'Noch keine Mitarbeiter.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {members.map((m) => {
            const inactive = m.isActive === false
            const isStub = !m.userId && !inactive
            return (
              <li key={m.id}>
                <Link
                  to={`/craftsman/team/${m.id}`}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <Avatar name={m.name} url={m.avatarUrl ?? null} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-slate-900">
                      {m.name || 'Ohne Name'}
                    </div>
                    <div className="truncate text-[12px] text-slate-500">
                      {m.role || '–'}
                      {m.email ? ` · ${m.email}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {inactive ? (
                      <span className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                        Inaktiv
                      </span>
                    ) : isStub ? (
                      <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                        Wartet
                      </span>
                    ) : (
                      <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        Aktiv
                      </span>
                    )}
                    <ChevronRight size={14} className="text-slate-400" aria-hidden />
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </SectionShell>
  )
}

function WeeklyHoursSection({
  entries,
  istByMember,
  weekLabel,
  onSelectMember,
  hydrated,
}: {
  entries: { memberId: string; displayName: string; targetHours: number | null }[]
  istByMember: Map<string, number>
  weekLabel: string
  onSelectMember: (memberId: string) => void
  hydrated: boolean
}) {
  if (entries.length === 0) return null

  return (
    <SectionShell
      title="Stunden · diese Woche"
      trailing={<span className="text-[11px] font-medium text-slate-400">{weekLabel}</span>}
    >
      <ul className="space-y-3" aria-busy={!hydrated} aria-live="polite">
        {entries.map((e) => {
          const istMinutes = istByMember.get(e.memberId) ?? 0
          const sollMinutes = e.targetHours != null ? e.targetHours * 60 : null
          const bar = deriveHoursBarData(sollMinutes, istMinutes)
          return (
            <li key={e.memberId}>
              <button
                type="button"
                onClick={() => onSelectMember(e.memberId)}
                data-testid={`hours-row-${e.memberId}`}
                className="block w-full text-left"
              >
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate font-semibold text-slate-900">{e.displayName}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {!hydrated
                      ? sollMinutes != null
                        ? `–:– / ${e.targetHours} h`
                        : 'Lädt…'
                      : sollMinutes != null
                        ? `${formatHoursMinutes(istMinutes)} / ${e.targetHours} h`
                        : `${formatHoursMinutes(istMinutes)} h · kein Soll`}
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                  {hydrated ? (
                    <div
                      className={`h-full rounded-full ${BAR_COLOR_CLS[bar.color]}`}
                      style={{ width: `${bar.capPct}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/4 animate-pulse rounded-full bg-slate-200" />
                  )}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </SectionShell>
  )
}

function JoinCodeSection({
  code,
  audit,
  onRotate,
  rotateDisabled,
}: {
  code: string | null
  audit: CodeAuditEntry[]
  onRotate: () => void
  rotateDisabled: boolean
}) {
  const lastRotation = audit[0]
  return (
    <section className="space-y-3">
      {code ? (
        <WelcomeCodeSheet code={code} onSendEmail={sendCodeByEmail} />
      ) : (
        <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200 text-[13px] text-amber-900">
          Kein aktiver Code gefunden. Lade die Seite neu oder kontaktiere den Support.
        </div>
      )}

      <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)]">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
            <RotateCw size={18} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-slate-900">Code rotieren</div>
            <div className="mt-0.5 text-[12px] text-slate-500">
              {lastRotation
                ? `Zuletzt rotiert ${formatRelativeDays(lastRotation.rotatedAt)}`
                : 'Noch nicht rotiert'}
            </div>
            <button
              type="button"
              onClick={onRotate}
              disabled={rotateDisabled}
              data-testid="rotate-code-trigger"
              className="mt-3 inline-flex rounded-full bg-rose-600 px-4 py-2 text-[13px] font-semibold text-white disabled:bg-slate-300"
            >
              Rotieren
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function AuditSection({
  entries,
  memberNamesById,
}: {
  entries: TeamHubAuditEntry[]
  memberNamesById: Map<string, string>
}) {
  if (entries.length === 0) {
    return (
      <SectionShell title="Verlauf">
        <p className="text-[13px] text-slate-500">Noch keine Aktivität aufgezeichnet.</p>
      </SectionShell>
    )
  }
  return (
    <SectionShell title="Verlauf">
      <ul className="divide-y divide-slate-100">
        {entries.map((entry) => {
          const time = formatRotatedAt(entry.createdAt)
          if (entry.kind === 'code_rotation') {
            return (
              <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="text-[13px] text-slate-700">Code rotiert</span>
                <span className="shrink-0 text-[11px] text-slate-400">{time}</span>
              </li>
            )
          }
          const name = memberNamesById.get(entry.memberId) || 'Mitarbeiter'
          const verb =
            entry.action === 'deactivate'
              ? 'deaktiviert'
              : entry.action === 'reactivate'
                ? 'reaktiviert'
                : 'aktualisiert'
          return (
            <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <span className="text-[13px] text-slate-700">{name} {verb}</span>
              <span className="shrink-0 text-[11px] text-slate-400">{time}</span>
            </li>
          )
        })}
      </ul>
    </SectionShell>
  )
}

function EmptyHero({ code }: { code: string | null }) {
  return (
    <div className="space-y-3">
      <div className="rounded-3xl bg-gradient-to-br from-blue-700 to-indigo-900 p-6 text-white shadow-[0_18px_40px_-22px_rgba(30,58,138,0.55)]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20">
          <Users size={24} className="text-white" aria-hidden />
        </div>
        <h2 className="mt-3 text-[20px] font-semibold">Erster Mitarbeiter</h2>
        <p className="mt-1 text-[13px] text-white/85 leading-relaxed">
          Lege ihn an oder gib ihm den Beitritts-Code. Beim ersten Login verknüpft sich sein
          Konto automatisch.
        </p>
      </div>

      {code ? <WelcomeCodeSheet code={code} onSendEmail={sendCodeByEmail} /> : null}

      <Link
        to="/craftsman/team/new"
        className="flex items-center gap-3 rounded-3xl bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_24px_-16px_rgba(2,6,23,0.18)] transition active:scale-[0.99]"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
          <UserPlus size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-slate-900">Mitarbeiter manuell anlegen</div>
          <div className="text-[12px] text-slate-500">Wird automatisch verknüpft beim Beitritt</div>
        </div>
        <ChevronRight size={14} className="text-slate-400" aria-hidden />
      </Link>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function CraftsmanTeamHubScreen() {
  const { user } = useSession()

  const [providerId, setProviderId] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [codeAudit, setCodeAudit] = useState<CodeAuditEntry[]>([])
  const [hubAudit, setHubAudit] = useState<TeamHubAuditEntry[]>([])
  const [members, setMembers] = useState<TeamMember[]>(
    () => getTeamMembers().filter((m) => m.role !== 'owner'),
  )
  const [jobs, setJobs] = useState(getJobs)
  const [calendarEntries, setCalendarEntries] = useState(getCalendarEntries)
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>(getTimeEntries)
  const [timeEntriesHydrated, setTimeEntriesHydrated] = useState(isTimeEntriesHydrated)
  const [absences, setAbsences] = useState<Absence[]>(getAbsences)
  const { requests: corrections } = useCorrections()
  const [springerSheetMemberId, setSpringerSheetMemberId] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'error' | null>(null)

  const [filterQuery, setFilterQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [detailMemberId, setDetailMemberId] = useState<string | null>(null)

  // ── Live subscriptions ─────────────────────────────────────────────────────
  useEffect(() => {
    const update = () => setMembers(getTeamMembers().filter((m) => m.role !== 'owner'))
    const unsub = subscribeTeamMembers(update)
    update()
    return unsub
  }, [])

  useEffect(() => {
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubCalendar = subscribeCalendar(() => setCalendarEntries(getCalendarEntries()))
    const unsubTimeEntries = subscribeTimeEntries(() => {
      setTimeEntries(getTimeEntries())
      setTimeEntriesHydrated(isTimeEntriesHydrated())
    })
    const unsubAbsences = subscribeAbsences(() => setAbsences(getAbsences()))
    return () => {
      unsubJobs()
      unsubCalendar()
      unsubTimeEntries()
      unsubAbsences()
    }
  }, [])

  // ── Provider / code / audit (async) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!user) return
      const profile = await getMyProviderProfile()
      if (cancelled || !profile) return
      setProviderId(profile.id)
      const [codeResult, codeAuditList, hubAuditList] = await Promise.all([
        getMyCompanyJoinCode(user.id),
        getCodeAuditLog(profile.id),
        listTeamHubAudit(profile.id, 10),
      ])
      if (cancelled) return
      setCode(codeResult?.code ?? null)
      setCodeAudit(codeAuditList)
      setHubAudit(hubAuditList)
    })()
    return () => { cancelled = true }
  }, [user])

  const todayKey = useMemo(() => formatDateKey(new Date()), [])
  const roster = useMemo(
    () => deriveTodayRoster(members, calendarEntries, jobs, todayKey, absences),
    [members, calendarEntries, jobs, todayKey, absences],
  )
  const sickMap = useMemo(
    () => deriveActiveSickToday(absences, todayKey),
    [absences, todayKey],
  )
  const springerSickMember = useMemo(() => {
    if (!springerSheetMemberId) return null
    const m = members.find((x) => x.id === springerSheetMemberId)
    return m ? { memberId: m.id, displayName: m.name } : null
  }, [members, springerSheetMemberId])
  const springerAffectedJobs = useMemo(() => {
    if (!springerSheetMemberId) return []
    return jobs.filter(
      (j) =>
        j.assignedMemberIds.includes(springerSheetMemberId) &&
        (j.status === 'new' || j.status === 'scheduled' || j.status === 'in_progress'),
    )
  }, [jobs, springerSheetMemberId])
  const sickMemberIdSet = useMemo(() => new Set(sickMap.keys()), [sickMap])
  const actionItems = useMemo(
    () => deriveTeamHubActionItems(members, corrections, jobs),
    [members, corrections, jobs],
  )
  const counts = useMemo(() => deriveTeamHubCounts(members), [members])
  const weeklyHoursSoll = useMemo(() => deriveWeeklyHoursSoll(members), [members])
  const filteredMembers = useMemo(
    () => deriveFilteredMembers(members, filterQuery, showInactive),
    [members, filterQuery, showInactive],
  )
  const weekRange = useMemo(() => computeLocalWeekRange(), [])
  const weekLabel = useMemo(() => weekLabelFromRange(weekRange), [weekRange])
  const istByMember = useMemo(
    () => buildIstMinutesIndex(timeEntries, weekRange),
    [timeEntries, weekRange],
  )
  const underTargetMembers = useMemo(
    () => (timeEntriesHydrated ? deriveUnderTargetMembers(members, istByMember) : []),
    [members, istByMember, timeEntriesHydrated],
  )

  const subtitleParts: string[] = []
  if (counts.activeCount > 0) subtitleParts.push(`${counts.activeCount} aktiv`)
  if (counts.stubCount > 0) subtitleParts.push(`${counts.stubCount} ${counts.stubCount === 1 ? 'wartet' : 'warten'}`)
  if (code) subtitleParts.push(`Code ${code}`)
  const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : 'Noch keine Mitarbeiter'

  const hasAnyMember = members.length > 0
  const rateLimitReached = deriveRotationDisabledReason(codeAudit) === 'rate_limit'

  const memberNamesById = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of members) map.set(m.id, m.name)
    return map
  }, [members])

  const pendingStubLabel = (() => {
    const stubs = actionItems.pendingStubs
    if (stubs.length === 0) return null
    if (stubs.length === 1) return `${stubs[0]!.name || 'Ein Mitarbeiter'} wartet noch auf Beitritt`
    return `${stubs.length} Mitarbeiter warten noch auf Beitritt`
  })()

  // Combo-Mail target: enabled only when exactly one stub still waits AND has
  // an email on file. Multiple-stub case routes to the plain rotate flow —
  // the owner can then send individual mails afterwards from the team detail.
  const comboMailStub = (() => {
    const stubsWithEmail = actionItems.pendingStubs.filter(
      (s): s is TeamMember & { email: string } => Boolean(s.email && s.email.trim().length > 0),
    )
    if (stubsWithEmail.length !== 1) return null
    return stubsWithEmail[0]
  })()

  async function handleConfirm(): Promise<void> {
    if (!providerId) return
    setPending(true)
    setFeedback(null)
    setFeedbackKind(null)
    try {
      const result = await rotateCompanyCodeWorkflow(providerId, undefined)
      if (result.ok) {
        setCode(result.newCode)
        const [refreshedCode, refreshedHub] = await Promise.all([
          getCodeAuditLog(providerId),
          listTeamHubAudit(providerId, 10),
        ])
        setCodeAudit(refreshedCode)
        setHubAudit(refreshedHub)
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

  async function handleConfirmAndMail(): Promise<void> {
    if (!providerId) return
    // Re-derive at click time: between render and click a stub may have joined
    // (Realtime UPDATE on team_members), turning the combo-mail target stale.
    // Read current member state, not the stale closure value.
    const liveStubs = getTeamMembers().filter(
      (m) =>
        m.role !== 'owner' &&
        m.isActive !== false &&
        !m.userId &&
        Boolean(m.email && m.email.trim().length > 0),
    )
    if (liveStubs.length !== 1) {
      setFeedback('Empfänger nicht mehr eindeutig — bitte Dialog neu öffnen.')
      setFeedbackKind('error')
      return
    }
    const liveStub = liveStubs[0]!
    setPending(true)
    setFeedback(null)
    setFeedbackKind(null)
    try {
      const result = await rotateAndMailStubWorkflow(
        providerId,
        liveStub.email!,
        undefined,
      )
      if (!result.ok) {
        setFeedback(result.error)
        setFeedbackKind('error')
        return
      }
      setCode(result.newCode)
      const [refreshedCode, refreshedHub] = await Promise.all([
        getCodeAuditLog(providerId),
        listTeamHubAudit(providerId, 10),
      ])
      setCodeAudit(refreshedCode)
      setHubAudit(refreshedHub)
      if (result.mail.sent) {
        setFeedback(`Code rotiert. Mail an ${result.mail.maskedEmail} unterwegs.`)
        setFeedbackKind('success')
      } else {
        setFeedback(`Code rotiert. Mail-Versand fehlgeschlagen: ${result.mail.error}`)
        setFeedbackKind('error')
      }
      setDialogOpen(false)
    } catch {
      setFeedback('Rotation + Mail fehlgeschlagen.')
      setFeedbackKind('error')
    } finally {
      setPending(false)
    }
  }

  return (
    <AppShell active="verwaltung">
      <section
        className="px-4 py-5"
        style={{ background: 'linear-gradient(180deg, #FAFBFE 0%, #F4F5F8 40%)' }}
      >
        <div className="mx-auto w-full max-w-[480px] space-y-4">
          <ScreenHeader eyebrow="Verwaltung" title="Team" />
          <p className="-mt-1 text-[13px] text-slate-500">{subtitle}</p>

          {feedback ? (
            <p
              data-testid="rotate-code-feedback"
              className={`rounded-2xl px-3 py-2 text-[13px] ${
                feedbackKind === 'error'
                  ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-100'
                  : 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
              }`}
            >
              {feedback}
            </p>
          ) : null}

          {!hasAnyMember ? (
            <EmptyHero code={code} />
          ) : (
            <>
              <TodayRosterSection
                entries={roster}
                onRequestSickNote={(absenceId) => {
                  void requestSickNoteWorkflow(absenceId).catch(() => undefined)
                }}
              />
              <ActionItemsSection
                openCorrectionsCount={actionItems.openCorrectionsCount}
                pendingStubs={actionItems.pendingStubs}
                highLoadMembers={actionItems.highLoadMembers}
                underTarget={underTargetMembers}
                sickToday={Array.from(sickMap.entries())
                  .map(([memberId]) => {
                    const m = members.find((x) => x.id === memberId)
                    const affected = jobs.filter(
                      (j) =>
                        j.assignedMemberIds.includes(memberId) &&
                        (j.status === 'new' || j.status === 'scheduled' || j.status === 'in_progress'),
                    )
                    return {
                      memberId,
                      displayName: m?.name ?? 'Mitarbeiter',
                      affectedJobCount: affected.length,
                    }
                  })
                  .filter((s) => s.affectedJobCount > 0)}
                onSelectMember={setDetailMemberId}
                onOpenSpringer={(id) => setSpringerSheetMemberId(id)}
              />
              <MembersListSection
                members={filteredMembers}
                filterQuery={filterQuery}
                onFilterQueryChange={setFilterQuery}
                showInactive={showInactive}
                onShowInactiveChange={setShowInactive}
                inactiveCount={counts.inactiveCount}
                totalSearchableCount={members.length}
              />
              <WeeklyHoursSection
                entries={weeklyHoursSoll}
                istByMember={istByMember}
                weekLabel={weekLabel}
                onSelectMember={setDetailMemberId}
                hydrated={timeEntriesHydrated}
              />
              <JoinCodeSection
                code={code}
                audit={codeAudit}
                onRotate={() => setDialogOpen(true)}
                rotateDisabled={!providerId || pending || rateLimitReached}
              />
              <AuditSection entries={hubAudit} memberNamesById={memberNamesById} />
            </>
          )}
        </div>
      </section>

      <RotateCodeConfirmDialog
        open={dialogOpen}
        activeMemberCount={counts.activeCount}
        rateLimitReached={rateLimitReached}
        pending={pending}
        pendingStubLabel={pendingStubLabel}
        comboMailEmail={comboMailStub?.email ?? null}
        onConfirm={handleConfirm}
        onConfirmAndMail={comboMailStub ? handleConfirmAndMail : undefined}
        onCancel={() => setDialogOpen(false)}
      />

      {detailMemberId
        ? (() => {
            const detailMember = members.find((m) => m.id === detailMemberId)
            if (!detailMember) return null
            const memberEntries = timeEntries.filter(
              (e) =>
                e.memberId === detailMemberId &&
                new Date(e.startedAt).getTime() >= new Date(weekRange.startIso).getTime() &&
                new Date(e.startedAt).getTime() < new Date(weekRange.endIso).getTime(),
            )
            const istMinutes = istByMember.get(detailMemberId) ?? 0
            const sollMinutes =
              detailMember.weeklyTargetHours != null
                ? detailMember.weeklyTargetHours * 60
                : null
            return (
              <WorkerWeeklyDetailSheet
                open
                memberName={detailMember.name || 'Mitarbeiter'}
                weeklyTargetHours={detailMember.weeklyTargetHours ?? null}
                entries={memberEntries}
                weekLabel={weekLabel}
                istMinutes={istMinutes}
                sollMinutes={sollMinutes}
                onClose={() => setDetailMemberId(null)}
                onUpdateSoll={async (hours) => {
                  const result = await updateTeamMember(detailMember.id, {
                    fullName: detailMember.name,
                    role: detailMember.role,
                    phone: detailMember.phone ?? null,
                    email: detailMember.email ?? null,
                    weeklyTargetHours: hours,
                    dailyTargetHours: detailMember.dailyTargetHours ?? null,
                  })
                  return result.ok ? { ok: true } : { ok: false, error: result.error }
                }}
              />
            )
          })()
        : null}

      <SpringerConfirmSheet
        open={!!springerSheetMemberId}
        sickMember={springerSickMember}
        affectedJobs={springerAffectedJobs}
        members={members}
        excludeMemberIds={sickMemberIdSet}
        onClose={() => setSpringerSheetMemberId(null)}
        onReassigned={() => undefined}
      />
    </AppShell>
  )
}
