import { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/AppShell'
import ActiveExecutionCard from '../components/calendar/ActiveExecutionCard'
import TodayScheduleOverviewCard from '../components/calendar/TodayScheduleOverviewCard'
import TodayScheduleSection from '../components/calendar/TodayScheduleSection'
import UpcomingScheduleSection from '../components/calendar/UpcomingScheduleSection'
import WorkerAssignedJobsSection from '../components/worker/WorkerAssignedJobsSection'
import WorkerQuickActionsCard from '../components/worker/WorkerQuickActionsCard'
import WorkerTimeTrackingHero from '../components/worker/WorkerTimeTrackingHero'
import {
  getCalendarEntries,
  subscribeCalendar,
  type CalendarEntry,
} from '../lib/calendar'
import { getEntriesForUser } from '../lib/calendar/calendarSelectors'
import {
  getActiveAssignedJobsForUser,
  getJobs,
  getTeamMembers,
  subscribeJobs,
  deriveWorkerLinkageDiagnostic,
} from '../lib/jobs'
import {
  getAbsences,
  getTimeEntries,
  isAbsencesHydrated,
  isTimeEntriesHydrated,
  subscribeAbsences,
  subscribeTeamMembers,
  subscribeTimeEntries,
} from '../lib/team'
import { deriveActiveSickToday } from '../lib/team/absenceSelectors'
import { WorkerSickReportSheet } from '../components/team/WorkerSickReportSheet'
import { WorkerSickStatusCard } from '../components/team/WorkerSickStatusCard'
import {
  markWorkCompleteWorkflow,
  startJobWorkflow,
} from '../lib/workflow'
import { useSession } from '../hooks/useSession'

const TODAY_LABEL = 'Heute'
const YESTERDAY_LABEL = 'Gestern'

function isToday(entry: CalendarEntry) {
  return entry.dateLabel === TODAY_LABEL
}

function isFuture(entry: CalendarEntry) {
  return entry.dateLabel !== TODAY_LABEL && entry.dateLabel !== YESTERDAY_LABEL
}

export default function WorkerHomeScreen() {
  const { user } = useSession()
  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [allJobs, setAllJobs] = useState(getJobs)
  const [timeEntries, setTimeEntries] = useState(getTimeEntries)
  const [timeEntriesHydrated, setTimeEntriesHydrated] = useState(isTimeEntriesHydrated)
  const [absences, setAbsences] = useState(getAbsences)
  const [absencesHydrated, setAbsencesHydrated] = useState(isAbsencesHydrated)
  const [sickSheetOpen, setSickSheetOpen] = useState(false)

  useEffect(() => {
    const unsubscribeCalendar = subscribeCalendar(() => {
      setAllEntries(getCalendarEntries())
    })
    const unsubscribeJobs = subscribeJobs(() => {
      setAllEntries(getCalendarEntries())
      setAllJobs(getJobs())
    })
    const unsubscribeTeamMembers = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers())
    })
    const unsubscribeTimeEntries = subscribeTimeEntries(() => {
      setTimeEntries(getTimeEntries())
      setTimeEntriesHydrated(isTimeEntriesHydrated())
    })
    const unsubscribeAbsences = subscribeAbsences(() => {
      setAbsences(getAbsences())
      setAbsencesHydrated(isAbsencesHydrated())
    })
    return () => {
      unsubscribeCalendar()
      unsubscribeJobs()
      unsubscribeTeamMembers()
      unsubscribeTimeEntries()
      unsubscribeAbsences()
    }
  }, [])

  const entries = useMemo(
    () => (user ? getEntriesForUser(allEntries, teamMembers, user.id) : []),
    [allEntries, teamMembers, user]
  )

  const assignedJobs = useMemo(
    () =>
      user
        ? getActiveAssignedJobsForUser(allJobs, teamMembers, user.id)
        : [],
    [allJobs, teamMembers, user]
  )

  const todayEntries = useMemo(() => entries.filter(isToday), [entries])

  const activeEntries = useMemo(
    () => todayEntries.filter((e) => e.status === 'in_progress'),
    [todayEntries]
  )

  const upcomingTodayEntries = useMemo(
    () => todayEntries.filter((e) => e.status === 'scheduled'),
    [todayEntries]
  )

  const completedTodayEntries = useMemo(
    () => todayEntries.filter((e) => e.status === 'completed'),
    [todayEntries]
  )

  const futureEntries = useMemo(() => entries.filter(isFuture), [entries])

  const primaryEntry = activeEntries[0] ?? upcomingTodayEntries[0] ?? null

  const handleStartJob = () => {
    if (!primaryEntry || primaryEntry.status !== 'scheduled' || !primaryEntry.jobId) return
    void startJobWorkflow(primaryEntry.jobId)
  }

  const handleMarkComplete = () => {
    if (!primaryEntry || primaryEntry.status !== 'in_progress' || !primaryEntry.jobId) return
    void markWorkCompleteWorkflow(primaryEntry.jobId)
  }


  const hasCalendarContent = todayEntries.length > 0 || futureEntries.length > 0

  // Worker linkage diagnostic — detects if this user has no team member record
  const linkageDiagnostic = useMemo(
    () => deriveWorkerLinkageDiagnostic(user?.id, teamMembers),
    [user, teamMembers]
  )

  // Time-tracking hero inputs — only renderable when the worker is linked to
  // a team_members row with an explicit providerId. Without providerId we
  // cannot satisfy the time_entries.provider_id NOT NULL constraint.
  const currentMember = useMemo(
    () => (user ? teamMembers.find((m) => m.userId === user.id) ?? null : null),
    [teamMembers, user]
  )
  const todayKey = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])
  const activeSick = useMemo(() => {
    if (!currentMember) return null
    const sickMap = deriveActiveSickToday(absences, todayKey)
    const entry = sickMap.get(currentMember.id)
    return entry
      ? {
          absenceId: entry.absenceId,
          dayCount: entry.dayCount,
          sickNoteRequested: entry.sickNoteRequested,
          sickNoteUrl: entry.sickNoteUrl,
        }
      : null
  }, [absences, currentMember, todayKey])

  const todayAssignedJobs = useMemo(() => {
    if (todayEntries.length === 0) return []
    const todayJobIds = new Set(
      todayEntries.map((e) => e.jobId).filter((id): id is string => Boolean(id))
    )
    return assignedJobs.filter((job) => todayJobIds.has(job.id))
  }, [assignedJobs, todayEntries])

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <div className="px-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Mitarbeiter
            </p>
            <h1 className="mt-1 text-[22px] font-semibold text-slate-900">
              Mein Arbeitstag
            </h1>
          </div>

          {currentMember && currentMember.providerId ? (
            timeEntriesHydrated ? (
              <>
                <WorkerTimeTrackingHero
                  member={currentMember}
                  providerId={currentMember.providerId}
                  activeEntries={timeEntries}
                  todayAssignedJobs={todayAssignedJobs}
                />
                {absencesHydrated && (
                  <WorkerSickStatusCard
                    activeSick={activeSick}
                    onReportClick={() => setSickSheetOpen(true)}
                  />
                )}
              </>
            ) : (
              <div
                aria-busy="true"
                aria-live="polite"
                className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_32px_-20px_rgba(2,6,23,0.35)]"
              >
                <div className="h-5 w-24 animate-pulse rounded bg-slate-100" />
                <div className="mt-3 h-12 w-full animate-pulse rounded-2xl bg-slate-100" />
              </div>
            )
          ) : null}

          {currentMember && currentMember.providerId && (
            <WorkerSickReportSheet
              open={sickSheetOpen}
              memberId={currentMember.id}
              providerId={currentMember.providerId}
              todayKey={todayKey}
              onClose={() => setSickSheetOpen(false)}
              onReported={() => undefined}
            />
          )}

          <TodayScheduleOverviewCard
            activeCount={activeEntries.length}
            upcomingTodayCount={upcomingTodayEntries.length}
            completedTodayCount={completedTodayEntries.length}
            nextCount={futureEntries.length}
          />

          {activeEntries.length > 0 && (
            <ActiveExecutionCard entry={activeEntries[0]} />
          )}

          {hasCalendarContent ? (
            <>
              <TodayScheduleSection
                activeEntries={activeEntries}
                upcomingEntries={upcomingTodayEntries}
                completedEntries={completedTodayEntries}
              />
              <UpcomingScheduleSection entries={futureEntries} />
            </>
          ) : (
            <div className="rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_32px_-20px_rgba(2,6,23,0.35)]">
              <p className="text-[15px] font-semibold text-slate-900">
                Kein Einsatz heute
              </p>
              <p className="mt-1 text-[14px] text-slate-500">
                Für heute sind keine Einsätze geplant. Deine zugewiesenen Jobs findest du unten.
              </p>
            </div>
          )}

          {/* Worker linkage diagnostic — only shown when no jobs and linkage gap detected */}
          {assignedJobs.length === 0 && linkageDiagnostic.hasLinkageGap && (
            <div className="rounded-[22px] bg-amber-50 p-4 ring-1 ring-amber-200/70">
              <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-amber-600">
                Mögliches Datenproblem
              </div>
              <div className="mt-1 text-[14px] font-semibold text-amber-900">
                Kein Mitarbeiterprofil verknüpft
              </div>
              <p className="mt-1.5 text-[13px] text-amber-700">
                Dein Benutzerkonto ist noch nicht mit einem Mitarbeiterdatensatz verbunden. Zugewiesene Jobs
                können daher nicht angezeigt werden.
              </p>
              <div className="mt-2 text-[12px] font-medium text-amber-600">
                → Bitte den Betriebsinhaber, dein Konto im Team-Bereich zu verknüpfen.
              </div>
            </div>
          )}

          <WorkerQuickActionsCard
            activeEntry={primaryEntry}
            onStartJob={handleStartJob}
            onMarkComplete={handleMarkComplete}

          />

          <WorkerAssignedJobsSection jobs={assignedJobs} />
        </div>
      </section>
    </AppShell>
  )
}

