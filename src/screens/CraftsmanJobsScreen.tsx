import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Calendar, CalendarPlus, CheckCircle2, Hammer, Zap, type LucideIcon } from 'lucide-react'
import AppShell from '../components/AppShell'
import { ScreenHeader, Icon } from '../components/primitives'
import ActionQueueJobCard from '../components/dashboard/ActionQueueJobCard'
import CraftsmanJobListItem from '../components/CraftsmanJobListItem'
import AssignmentIntegrityWarningBanner from '../components/jobs/AssignmentIntegrityWarningBanner'
import { deriveActionQueue } from '../lib/dashboard/actionQueueSelectors'
import {
  deriveJobsScreenSectionContent,
  deriveJobsScreenSectionStats,
  resolveJobsScreenActiveTab,
  resolveJobsScreenSection,
  type JobsScreenSection,
  type JobsScreenSectionStats,
} from '../lib/dashboard/jobsScreenSelectors'
import {
  deriveAssignmentIntegrityWarning,
  deriveIntakeReadiness,
  getJobs,
  getTeamMembers,
  isCompletedJob,
  isJobRepositoryHydrated,
  subscribeJobs,
  toggleAssignedMember,
  type Job,
  type TeamMember,
} from '../lib/jobs'
import { getUnassignedJobs } from '../lib/jobs/teamWorkloadSelectors'
import { getDisputes, subscribeDisputes, type Dispute } from '../lib/disputes'
import { getSession } from '../lib/session'
import { isTeamMembersHydrated, subscribeTeamMembers } from '../lib/team'
import { performCanonicalScheduleSave } from '../lib/scheduling'
import { getSchedules, subscribeOperations, type JobSchedule } from '../lib/operations'
import { getCalendarEntries, subscribeCalendar, type CalendarEntry } from '../lib/calendar'

// ─── Section chip strip ──────────────────────────────────────────────────────

type SectionChip = {
  id: JobsScreenSection
  label: string
  count: number
  urgent?: boolean
}

function SectionChipStrip({
  sections,
  active,
  onSelect,
}: {
  sections: SectionChip[]
  active: JobsScreenSection
  onSelect: (next: JobsScreenSection) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Aufträge filtern"
      className="-mx-1 flex snap-x items-center gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {sections.map((section) => {
        const isActive = section.id === active
        const showUrgent = section.urgent && section.count > 0 && !isActive
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(section.id)}
            data-testid={`jobs-chip-${section.id}`}
            className={[
              'inline-flex shrink-0 snap-start items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 transition active:scale-[0.97]',
              isActive
                ? 'bg-slate-900 text-white ring-slate-900'
                : showUrgent
                  ? 'bg-warn/10 text-warn ring-warn/30'
                  : 'bg-white text-slate-600 ring-slate-200',
            ].join(' ')}
          >
            {section.label}
            <span
              className={[
                'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-bold',
                isActive
                  ? 'bg-white/20 text-white'
                  : showUrgent
                    ? 'bg-warn/20 text-warn'
                    : 'bg-slate-100 text-slate-500',
              ].join(' ')}
            >
              {section.count}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ─── Group heading inside a section ─────────────────────────────────────────

function GroupHeading({
  icon: HeadingIcon,
  label,
  count,
  urgent,
}: {
  icon: LucideIcon
  label: string
  count: number
  urgent?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <Icon icon={HeadingIcon} size="sm" className={urgent ? 'text-warn' : 'text-ink-muted'} />
      <span
        className={`text-[12px] font-bold uppercase tracking-wide ${
          urgent ? 'text-warn' : 'text-ink-muted'
        }`}
      >
        {label}
      </span>
      {count > 0 && (
        <span
          className={`ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip px-1 text-[10px] font-bold ${
            urgent ? 'bg-warn/10 text-warn' : 'bg-canvas text-ink-sub'
          }`}
        >
          {count}
        </span>
      )}
    </div>
  )
}

// ─── Empty states ───────────────────────────────────────────────────────────

function HandlungsbedarfEmpty() {
  return (
    <div className="rounded-card bg-canvas px-4 py-5 text-center ring-1 ring-edge">
      <Icon icon={CheckCircle2} size="lg" className="mx-auto text-ok" />
      <p className="mt-1.5 text-[14px] font-semibold text-ink">Alles unter Kontrolle</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">Keine offenen Aufgaben.</p>
    </div>
  )
}

function AktivEmpty() {
  return (
    <div className="rounded-card bg-canvas px-4 py-5 text-center ring-1 ring-edge">
      <p className="text-[14px] text-ink-muted">Keine laufenden Aufträge.</p>
    </div>
  )
}

function GeplantEmpty() {
  return (
    <div className="rounded-card bg-canvas px-4 py-5 text-center ring-1 ring-edge">
      <Icon icon={Calendar} size="lg" className="mx-auto text-ink-muted" />
      <p className="mt-1.5 text-[14px] font-semibold text-ink">Keine geplanten Termine</p>
      <p className="mt-0.5 text-[12px] text-ink-muted">
        Termine entstehen, sobald du Aufträge planst.
      </p>
      <Link
        to="/craftsman/operations"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white transition active:scale-[0.97]"
      >
        <CalendarPlus size={14} aria-hidden />
        Zur Planung
      </Link>
    </div>
  )
}

function AlleEmpty() {
  return (
    <div className="rounded-card bg-canvas px-4 py-5 text-center ring-1 ring-edge">
      <p className="text-[14px] text-ink-muted">Noch keine Aufträge.</p>
    </div>
  )
}

// ─── Section helpers ─────────────────────────────────────────────────────────

const SECTION_LABEL: Record<JobsScreenSection, string> = {
  handlungsbedarf: 'Handlungsbedarf',
  aktiv: 'Aktiv',
  geplant: 'Geplant',
  alle: 'Alle',
}

function buildSectionChips(stats: JobsScreenSectionStats): SectionChip[] {
  return [
    { id: 'handlungsbedarf', label: SECTION_LABEL.handlungsbedarf, count: stats.handlungsbedarf, urgent: true },
    { id: 'aktiv', label: SECTION_LABEL.aktiv, count: stats.aktiv },
    { id: 'geplant', label: SECTION_LABEL.geplant, count: stats.geplant },
    { id: 'alle', label: SECTION_LABEL.alle, count: stats.alle },
  ]
}

// ─── Screen ──────────────────────────────────────────────────────────────────

/**
 * Unified owner work surface.
 *
 * Single screen for: jobs/orders, urgent next actions, scheduled/upcoming
 * work, and operational quick actions. Replaces the old split between
 * `CraftsmanActionQueueScreen` (priority queue) and the previous flat
 * `CraftsmanJobsScreen` status list.
 *
 * Sections (segmented chips):
 *   - Handlungsbedarf  needs_action items (disputes, unassigned, overdue, …)
 *   - Aktiv            in_progress + waiting (split via sub-headings)
 *   - Geplant          coming_up (booked/scheduled + assigned)
 *   - Alle             status-grouped full list incl. completed (browse mode)
 *
 * Section content is sourced from `deriveActionQueue` (canonical urgency SoT)
 * for the first three sections and from job-status filters for `alle`.
 *
 * Quick actions (assign worker, take job, schedule appointment) are inlined
 * for items in Handlungsbedarf and Geplant — preserved verbatim from the
 * legacy `CraftsmanActionQueueScreen`. All other taps deep-link to
 * `/craftsman/jobs/:jobId` (with the job-detail focus anchors intact).
 *
 * Bottom-nav tab affinity:
 *   `?focus=handlungsbedarf` → tab "home" (entry from Dashboard work-entry card)
 *   any other entry          → tab "verwaltung" (Backoffice → Aufträge)
 */
export default function CraftsmanJobsScreen() {
  const location = useLocation()
  const navigate = useNavigate()
  const focusParam = useMemo(
    () => new URLSearchParams(location.search).get('focus'),
    [location.search],
  )

  // ── Subscriptions ──────────────────────────────────────────────────────────
  const [jobs, setJobs] = useState<Job[]>(getJobs)
  const [disputes, setDisputes] = useState<Dispute[]>(getDisputes)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(getTeamMembers)
  const [schedules, setSchedules] = useState<JobSchedule[]>(() => getSchedules())
  const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>(() => getCalendarEntries())
  const [jobsHydrated, setJobsHydrated] = useState(isJobRepositoryHydrated)
  const [teamMembersHydrated, setTeamMembersHydrated] = useState(isTeamMembersHydrated)
  const [showAllCompleted, setShowAllCompleted] = useState(false)
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null)

  useEffect(() => {
    const unsubJobs = subscribeJobs(() => {
      setJobs(getJobs())
      setJobsHydrated(isJobRepositoryHydrated())
    })
    const unsubDisputes = subscribeDisputes(() => setDisputes(getDisputes()))
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
      setTeamMembersHydrated(isTeamMembersHydrated())
    })
    const unsubOperations = subscribeOperations(() => setSchedules(getSchedules()))
    const unsubCalendar = subscribeCalendar(() => setCalendarEntries(getCalendarEntries()))

    // Close render→subscribe race window
    setJobs(getJobs())
    setJobsHydrated(isJobRepositoryHydrated())
    setTeamMembers(getTeamMembers())
    setTeamMembersHydrated(isTeamMembersHydrated())

    return () => {
      unsubJobs()
      unsubDisputes()
      unsubTeam()
      unsubOperations()
      unsubCalendar()
    }
  }, [])

  // ── Queue derivation (same inputs as legacy ActionQueue) ──────────────────
  const unassignedJobs = useMemo(() => getUnassignedJobs(jobs), [jobs])

  const todayKey = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  const scheduledJobIds = useMemo(
    () =>
      new Set([
        ...schedules.map((s) => s.jobId),
        ...calendarEntries
          .filter((e) => e.status === 'scheduled' || e.status === 'in_progress')
          .map((e) => e.jobId)
          .filter((id): id is string => Boolean(id)),
      ]),
    [schedules, calendarEntries],
  )

  const futureScheduledJobIds = useMemo(
    () =>
      new Set<string>(
        calendarEntries
          .filter((e) => e.dateKey > todayKey && e.status === 'scheduled')
          .map((e) => e.jobId)
          .filter((id): id is string => Boolean(id)),
      ),
    [calendarEntries, todayKey],
  )

  const queue = useMemo(
    () => deriveActionQueue(jobs, disputes, unassignedJobs, scheduledJobIds, futureScheduledJobIds),
    [jobs, disputes, unassignedJobs, scheduledJobIds, futureScheduledJobIds],
  )

  // ── Section state ──────────────────────────────────────────────────────────
  const stats = useMemo(() => deriveJobsScreenSectionStats(queue, jobs), [queue, jobs])
  const initialSection = useMemo(
    () => resolveJobsScreenSection(focusParam, queue),
    [focusParam, queue],
  )
  const [activeSection, setActiveSection] = useState<JobsScreenSection>(initialSection)

  // Re-resolve section when the focus param changes (e.g. user navigates
  // between entry points without unmounting). The queue is read via ref so
  // data mutations do not retrigger this effect — the user's explicit chip
  // selection must not be overridden by background updates.
  const queueRef = useRef(queue)
  queueRef.current = queue

  useEffect(() => {
    setActiveSection(resolveJobsScreenSection(focusParam, queueRef.current))
    setExpandedCardId(null)
  }, [focusParam])

  const handleSelectSection = useCallback(
    (next: JobsScreenSection) => {
      setActiveSection(next)
      setExpandedCardId(null)
      // Mirror the selection into the URL so the back button + deep-link
      // round-trip work without changing the active bottom-nav tab.
      const search = new URLSearchParams(location.search)
      search.set('focus', next)
      navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
    },
    [location.pathname, location.search, navigate],
  )

  const content = useMemo(
    () => deriveJobsScreenSectionContent(activeSection, queue, jobs),
    [activeSection, queue, jobs],
  )

  // ── Quick actions (inline panel) ───────────────────────────────────────────
  const isDataHydrated = jobsHydrated && teamMembersHydrated

  const handleToggleExpand = useCallback((jobId: string) => {
    setExpandedCardId((prev) => (prev === jobId ? null : jobId))
  }, [])

  const handleAssignWorker = useCallback(
    (jobId: string, memberId: string) => {
      if (!isDataHydrated) return
      void toggleAssignedMember(jobId, memberId)
      setExpandedCardId(null)
    },
    [isDataHydrated],
  )

  const handleTakeJobMyself = useCallback(
    (jobId: string) => {
      if (!isDataHydrated) return
      const session = getSession()
      const userId = session.user?.id
      const selfMember = teamMembers.find((m) => m.userId === userId)
      const selfId = selfMember?.id ?? userId
      if (selfId) void toggleAssignedMember(jobId, selfId)
      setExpandedCardId(null)
    },
    [isDataHydrated, teamMembers],
  )

  const scheduleInFlight = useRef(false)
  const handleScheduleAppointment = useCallback(
    async (jobId: string, start: number, end: number) => {
      if (scheduleInFlight.current) return
      scheduleInFlight.current = true
      try {
        const result = await performCanonicalScheduleSave({
          jobId,
          scheduledStart: start,
          scheduledEnd: end,
        })
        if (!result.success) {
          throw new Error(result.error ?? 'Termin konnte nicht gespeichert werden.')
        }
        setExpandedCardId(null)
      } finally {
        scheduleInFlight.current = false
      }
    },
    [],
  )

  // ── Render helpers ─────────────────────────────────────────────────────────
  const assignmentWarning = useMemo(() => deriveAssignmentIntegrityWarning(jobs), [jobs])
  const showAssignmentWarning = activeSection === 'aktiv' || activeSection === 'alle'

  const completedCount = useMemo(() => jobs.filter(isCompletedJob).length, [jobs])

  const renderQueueItem = (item: typeof queue.needsAction[number]) => (
    <ActionQueueJobCard
      key={item.job.id}
      item={item}
      isExpanded={expandedCardId === item.job.id}
      onToggleExpand={handleToggleExpand}
      teamMembers={teamMembers}
      onAssignWorker={handleAssignWorker}
      onTakeJobMyself={handleTakeJobMyself}
      onScheduleAppointment={handleScheduleAppointment}
    />
  )

  const sections = buildSectionChips(stats)
  const activeTab = resolveJobsScreenActiveTab(focusParam)

  return (
    <AppShell active={activeTab}>
      <section className="px-4 py-5">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <ScreenHeader eyebrow="Verwaltung" title="Aufträge" />

          {/* Segmented chip strip */}
          <SectionChipStrip
            sections={sections}
            active={activeSection}
            onSelect={handleSelectSection}
          />

          {/* Skeleton while hydrating */}
          {!isDataHydrated && (
            <div className="animate-pulse space-y-2">
              <div className="h-16 rounded-card bg-canvas ring-1 ring-edge" />
              <div className="h-16 rounded-card bg-canvas ring-1 ring-edge" />
              <div className="h-16 rounded-card bg-canvas ring-1 ring-edge" />
            </div>
          )}

          {isDataHydrated && (
            <>
              {showAssignmentWarning && (
                <AssignmentIntegrityWarningBanner
                  warning={assignmentWarning}
                  teamMembers={teamMembers}
                  onAssignWorker={handleAssignWorker}
                  onTakeJobMyself={handleTakeJobMyself}
                />
              )}

              {/* Handlungsbedarf — flat queue */}
              {activeSection === 'handlungsbedarf' && content.kind === 'queue' && (
                content.items.length > 0 ? (
                  <div className="space-y-2">
                    <GroupHeading icon={Zap} label="Handlungsbedarf" count={content.items.length} urgent />
                    {content.items.map(renderQueueItem)}
                  </div>
                ) : (
                  <HandlungsbedarfEmpty />
                )
              )}

              {/* Aktiv — grouped queue (In Arbeit / Wartet) */}
              {activeSection === 'aktiv' && content.kind === 'queue-grouped' && (
                content.groups.length > 0 ? (
                  content.groups.map((group) => (
                    <div key={group.label} className="space-y-2">
                      <GroupHeading
                        icon={group.label === 'In Arbeit' ? Hammer : Calendar}
                        label={group.label}
                        count={group.items.length}
                      />
                      {group.items.map(renderQueueItem)}
                    </div>
                  ))
                ) : (
                  <AktivEmpty />
                )
              )}

              {/* Geplant — flat queue with proximity */}
              {activeSection === 'geplant' && content.kind === 'queue' && (
                content.items.length > 0 ? (
                  <div className="space-y-2">
                    <GroupHeading icon={Calendar} label="Geplant" count={content.items.length} />
                    {content.items.map(renderQueueItem)}
                  </div>
                ) : (
                  <GeplantEmpty />
                )
              )}

              {/* Alle — status-grouped raw jobs incl. completed */}
              {activeSection === 'alle' && content.kind === 'jobs-grouped' && (
                content.groups.length > 0 ? (
                  content.groups.map((group) => {
                    const isCompleted = group.label === 'Erledigt'
                    const visible = isCompleted && !showAllCompleted ? group.jobs.slice(0, 5) : group.jobs
                    const hidden = group.jobs.length - visible.length
                    return (
                      <div key={group.label} className="space-y-2">
                        <GroupHeading
                          icon={
                            group.label === 'Geplant'
                              ? Calendar
                              : group.label === 'Aktiv'
                                ? Hammer
                                : CheckCircle2
                          }
                          label={group.label}
                          count={group.jobs.length}
                          urgent={
                            group.label === 'Aktiv' &&
                            group.jobs.some((j) => j.status === 'waiting_payment')
                          }
                        />
                        <div className="space-y-2">
                          {visible.map((job) => (
                            <CraftsmanJobListItem
                              key={job.id}
                              id={job.id}
                              title={job.title}
                              customer={job.customer}
                              location={job.location}
                              dateLabel={job.dateLabel}
                              status={job.status}
                              amount={job.amount}
                              paymentState={job.paymentState}
                              intakeReadiness={
                                job.status === 'new' ? deriveIntakeReadiness(job).readiness : undefined
                              }
                              assigneeCount={job.assignedMemberIds.length}
                              job={job}
                              compact={isCompleted}
                            />
                          ))}
                          {isCompleted && hidden > 0 && (
                            <button
                              type="button"
                              onClick={() => setShowAllCompleted(true)}
                              className="w-full rounded-xl bg-slate-50 px-4 py-2.5 text-[12px] font-medium text-ink-sub ring-1 ring-slate-200/70 transition active:bg-slate-100"
                            >
                              Alle anzeigen ({hidden} weitere)
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                ) : (
                  <AlleEmpty />
                )
              )}

              {/* Footer hint when "Alle" view but no completed yet — gentle context line */}
              {activeSection === 'alle' && completedCount === 0 && content.kind === 'jobs-grouped' && content.groups.length > 0 && (
                <p className="px-1 text-[11px] text-ink-muted">
                  Abgeschlossene Aufträge erscheinen hier nach dem Abschluss.
                </p>
              )}
            </>
          )}
        </div>
      </section>
    </AppShell>
  )
}
