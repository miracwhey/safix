import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../components/AppShell'
import WorkEntryCard from '../components/dashboard/WorkEntryCard'
import SetupReminderCard from '../components/dashboard/SetupReminderCard'
import CompactDashboardStats from '../components/dashboard/CompactDashboardStats'
import BackofficeEntryCard from '../components/dashboard/BackofficeEntryCard'
import ProfileVisibilityBanner from '../components/dashboard/ProfileVisibilityBanner'
import SpatialEntryCard from '../components/dashboard/SpatialEntryCard'
import OwnerHomeHero from '../components/home/OwnerHomeHero'
import { useOwnerHomeState } from '../hooks/useHomeState'
import {
  getJobs,
  subscribeJobs,
  filterSupersededJobs,
  type Job,
  type JobConversation,
} from '../lib/jobs'
import { getUnassignedJobs } from '../lib/jobs/teamWorkloadSelectors'
import { getJobConversations } from '../lib/workflow'
import { getBackofficeKPIs } from '../lib/backoffice'
import {
  getDisputes,
  subscribeDisputes,
  type Dispute,
} from '../lib/disputes'
import { getChatRepository } from '../lib/chat'
import { useSession } from '../hooks/useSession'
import { useCraftsmanOnboardingProgress } from '../hooks/useCraftsmanOnboardingProgress'
import { deriveWorkEntrySummary, deriveSetupReminder } from '../lib/dashboard/workEntrySelectors'
import { deriveTodayBlock } from '../lib/dashboard/todayBlockSelectors'
import { getCalendarEntries, subscribeCalendar, syncCalendarEntriesForJobs } from '../lib/calendar'
import type { CalendarEntry } from '../lib/calendar'
import { getSchedules, subscribeOperations, type JobSchedule } from '../lib/operations'
import TodayBlock from '../components/dashboard/TodayBlock'

export default function CraftsmanDashboardScreen() {
  const session = useSession()

  const {
    progress: onboardingProgress,
    isLoaded: onboardingLoaded,
    displayName: profileDisplayName,
  } = useCraftsmanOnboardingProgress()

  // ── Owner Hero VM ─────────────────────────────────────────────────────────
  // Block 7.1F — surfaces priority alerts (dispute > payout_blocked >
  // payout_failed > release_overdue) on the craftsman dashboard. The hook
  // owns its subscriptions; no second source of truth is introduced here.
  const ownerHomeVm = useOwnerHomeState()

  // ── Job / dispute / message / calendar state ──────────────────────────────
  const [jobs, setJobs] = useState<Job[]>(getJobs())
  const [conversations, setConversations] = useState<JobConversation[]>(
    getJobConversations()
  )
  const [disputes, setDisputes] = useState<Dispute[]>(getDisputes())
  const [calendarEntries, setCalendarEntries] = useState<CalendarEntry[]>(getCalendarEntries())
  const [schedules, setSchedules] = useState<JobSchedule[]>(() => getSchedules())

  useEffect(() => {
    const unsubJobs = subscribeJobs(() => {
      const currentJobs = getJobs()
      setJobs(currentJobs)
      setConversations(getJobConversations())
      syncCalendarEntriesForJobs(currentJobs)
    })
    const unsubDisputes = subscribeDisputes(() => {
      setDisputes(getDisputes())
    })
    const onMessageEvent = () => setJobs(getJobs())
    const unsubMessages = getChatRepository().subscribe(onMessageEvent)
    const unsubCalendar = subscribeCalendar(() => {
      setCalendarEntries(getCalendarEntries())
    })
    const unsubOperations = subscribeOperations(() => {
      setSchedules(getSchedules())
    })

    syncCalendarEntriesForJobs(getJobs())

    return () => {
      unsubJobs()
      unsubDisputes()
      unsubMessages()
      unsubCalendar()
      unsubOperations()
    }
  }, [])

  // ── Derived data ─────────────────────────────────────────────────────────
  const kpis = useMemo(() => getBackofficeKPIs(jobs, conversations), [jobs, conversations])
  const operationalJobs = useMemo(() => filterSupersededJobs(jobs), [jobs])
  const unassignedJobs = useMemo(() => getUnassignedJobs(operationalJobs), [operationalJobs])

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

  const workEntry = useMemo(
    () => deriveWorkEntrySummary(operationalJobs, disputes, unassignedJobs, scheduledJobIds),
    [operationalJobs, disputes, unassignedJobs, scheduledJobIds],
  )

  const setupReminder = useMemo(
    () => deriveSetupReminder(onboardingProgress, onboardingLoaded),
    [onboardingProgress, onboardingLoaded],
  )

  const todayKey = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  const todayBlock = useMemo(
    () => deriveTodayBlock(calendarEntries, todayKey),
    [calendarEntries, todayKey],
  )

  const showOperatorLink = session.isOperator

  // Priority: OAuth full_name → OAuth name → craftsman business name first word
  const displayName = useMemo(() => {
    const meta = session.user?.user_metadata as Record<string, unknown> | undefined
    const fromMeta =
      (meta?.full_name as string | undefined)?.split(' ')[0]?.trim() ||
      (meta?.name as string | undefined)?.split(' ')[0]?.trim() ||
      null
    return fromMeta || profileDisplayName
  }, [session.user, profileDisplayName])

  const greetingDate = useMemo(() => {
    const d = new Date()
    return d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
  }, [])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <AppShell active="home">
      <section className="px-4 py-5">
        <div className="mx-auto w-full max-w-[420px] space-y-3">

          {/* ── 0. GREETING ── */}
          <div className="px-1 pb-1">
            <h1 className="text-[22px] font-semibold text-ink">
              Hallo{displayName ? `, ${displayName}` : ''}
            </h1>
            <p className="mt-0.5 text-[14px] text-ink-muted">
              {todayBlock.todayCount > 0
                ? todayBlock.todayCount === 1
                  ? '1 Termin heute geplant.'
                  : `${todayBlock.todayCount} Termine heute geplant.`
                : greetingDate}
            </p>
          </div>

          {/* ── 0.5 VISIBILITY ALERT (profile hidden from discovery → self-service republish) ── */}
          <ProfileVisibilityBanner />

          {/* ── 1. OWNER HERO (priority alerts: dispute / payout_blocked / payout_failed / release_overdue) ── */}
          <OwnerHomeHero vm={ownerHomeVm} />

          {/* ── 2. WORK ENTRY CARD (always present) ── */}
          <WorkEntryCard summary={workEntry} />

          {/* ── 3. SETUP / UNLOCK CARD (only when setup incomplete AND hero not already showing payout_blocked) ── */}
          {ownerHomeVm.priorityReason !== 'payout_blocked' && (
            <SetupReminderCard reminder={setupReminder} />
          )}

          {/* ── 4. COMPACT SITUATION OVERVIEW ── */}
          <CompactDashboardStats
            activeJobs={kpis.activeJobs}
            waitingPayment={kpis.waitingPayment}
            openChats={kpis.openChats}
            todayCount={todayBlock.todayCount}
          />

          {/* ── 5. TODAY / NEXT BLOCK (only when relevant) ── */}
          <TodayBlock summary={todayBlock} />

          {/* ── 6. SPATIAL QUICK-ACCESS (3D-Aufmaße — operativer Bereich bleibt Heim, 3D 1 Tap entfernt) ── */}
          <SpatialEntryCard />

          {/* ── 7. BACKOFFICE ENTRY ── */}
          <BackofficeEntryCard />

          {/* Operator link — visible only for users with operator flag */}
          {showOperatorLink && (
            <div className="flex justify-center pb-2">
              <Link
                to="/craftsman/operator"
                className="text-[11px] text-ink-muted hover:text-ink transition"
              >
                Operator Dashboard ›
              </Link>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  )
}
