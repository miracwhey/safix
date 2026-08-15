import { useEffect, useMemo, useState } from 'react'
import {
  Inbox,
  MessageSquare,
  Package,
  TrendingUp,
  Receipt,
  User,
  Users,
  Bell,
  Briefcase,
  Box,
  SlidersHorizontal,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import { NavigationCard, ScreenHeader } from '../components/primitives'
import {
  filterSupersededJobs,
  getJobs,
  getUnassignedJobs,
  subscribeJobs,
  type Job,
} from '../lib/jobs'
import {
  getIncomingProjectRequests,
  type IncomingRequestItem,
} from '../lib/messages'
import {
  getChatRepository,
  isChatCutoverEnabled,
  useChatThreads,
} from '../lib/chat'
import { getIncomingProjectRequestsFromChat } from '../lib/chat/requestInboxSelectors'
import {
  getUnreadNotificationSignals,
  subscribeNotifications,
} from '../lib/notifications'
import {
  getUnreadInAppNotificationCount,
  subscribeInAppNotifications,
} from '../lib/inAppNotifications'
import { useCorrections } from '../hooks/useCorrections'
import { useCraftsmanOnboardingProgress } from '../hooks/useCraftsmanOnboardingProgress'
import { deriveBackofficeHubViewModel } from '../lib/backoffice'
import { getTeamMembers, subscribeTeamMembers } from '../lib/team'
import type { TeamMember } from '../lib/jobs/types'
import {
  deriveTeamHubActionItems,
  deriveTeamHubCounts,
} from '../lib/team/teamHubSelectors'

/**
 * Craftsman backoffice hub — "where do I manage the system?" surface.
 *
 * Home = "what should I do now?" | Backoffice = "where do I manage?"
 * This screen is the Verwaltung-tab destination in the bottom navigation.
 *
 * The hub is a NavigationCard list enriched with state-aware adornments
 * (counter badges, dynamic subtitles, contextual deep links) sourced from
 * canonical selectors. The hub never owns domain logic and never duplicates
 * Dashboard, Jobs, Operations, or Finance worklists.
 *
 * The 3-tab Operations screen (Planung/Team/Doku) lives at
 * /craftsman/operations as a dedicated sub-area, not as a replacement.
 */
export default function CraftsmanBackofficeScreen() {
  // Chat-Cutover Slice D: the request badge reads from the chat domain when
  // the craftsman cutover is active (flag only changes via reload).
  const chatCutover = isChatCutoverEnabled('craftsman')
  const [jobs, setJobs] = useState<Job[]>(getJobs())
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequestItem[]>(() =>
    chatCutover ? getIncomingProjectRequestsFromChat() : getIncomingProjectRequests(),
  )
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(
    () => getUnreadNotificationSignals().length + getUnreadInAppNotificationCount(),
  )
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(
    () => getTeamMembers().filter((m) => m.role !== 'owner'),
  )

  const chatOfficeThreads = useChatThreads('office')
  const chatTeamThreads = useChatThreads('team')

  const { requests: corrections } = useCorrections()
  const { progress: onboardingProgress } = useCraftsmanOnboardingProgress()

  useEffect(() => {
    const refreshNotifications = () =>
      setUnreadNotificationsCount(
        getUnreadNotificationSignals().length + getUnreadInAppNotificationCount(),
      )
    const refreshIncomingRequests = () =>
      setIncomingRequests(
        chatCutover ? getIncomingProjectRequestsFromChat() : getIncomingProjectRequests(),
      )
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    const unsubMessages = getChatRepository().subscribe(refreshIncomingRequests)
    const unsubNotifications = subscribeNotifications(refreshNotifications)
    const unsubInApp = subscribeInAppNotifications(refreshNotifications)
    const unsubTeam = subscribeTeamMembers(() => {
      setTeamMembers(getTeamMembers().filter((m) => m.role !== 'owner'))
    })

    return () => {
      unsubJobs()
      unsubMessages()
      unsubNotifications()
      unsubInApp()
      unsubTeam()
    }
  }, [chatCutover])

  const unassignedJobsCount = useMemo(
    () => getUnassignedJobs(filterSupersededJobs(jobs)).length,
    [jobs],
  )

  const openCorrectionsCount = useMemo(
    () =>
      corrections.filter(
        (c) => c.status === 'open' || c.status === 'in_review',
      ).length,
    [corrections],
  )

  const unreadInternalThreadsCount = useMemo(() => {
    let count = 0
    for (const t of chatOfficeThreads) if (t.unreadCount > 0) count++
    for (const t of chatTeamThreads) if (t.unreadCount > 0) count++
    return count
  }, [chatOfficeThreads, chatTeamThreads])

  const teamCounts = useMemo(() => deriveTeamHubCounts(teamMembers), [teamMembers])
  const teamHighLoadCount = useMemo(
    () => deriveTeamHubActionItems(teamMembers, [], jobs).highLoadMembers.length,
    [teamMembers, jobs],
  )

  const hub = useMemo(
    () =>
      deriveBackofficeHubViewModel({
        unassignedJobsCount,
        incomingRequestsCount: incomingRequests.length,
        openCorrectionsCount,
        unreadInternalThreadsCount,
        unreadNotificationsCount,
        onboardingProgress,
        teamActiveCount: teamCounts.activeCount,
        teamPendingStubCount: teamCounts.stubCount,
        teamHighLoadCount,
      }),
    [
      unassignedJobsCount,
      incomingRequests.length,
      openCorrectionsCount,
      unreadInternalThreadsCount,
      unreadNotificationsCount,
      onboardingProgress,
      teamCounts.activeCount,
      teamCounts.stubCount,
      teamHighLoadCount,
    ],
  )

  return (
    <AppShell active="verwaltung">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-5">
          <ScreenHeader eyebrow="Verwaltung" title="Übersicht" />

          <nav className="space-y-2" aria-label="Backoffice Module">
            <NavigationCard
              to={hub.betrieb.to}
              icon={Briefcase}
              title="Betrieb"
              subtitle={hub.betrieb.subtitle}
              badge={hub.betrieb.badge}
            />
            <NavigationCard
              to={hub.team.to}
              icon={Users}
              title="Team"
              subtitle={hub.team.subtitle}
              badge={hub.team.badge}
            />
            <NavigationCard
              to={hub.nachrichten.to}
              icon={MessageSquare}
              title="Team-Nachrichten"
              subtitle={hub.nachrichten.subtitle}
              badge={hub.nachrichten.badge}
            />
            <NavigationCard
              to={hub.korrekturen.to}
              icon={SlidersHorizontal}
              title="Korrekturen"
              subtitle={hub.korrekturen.subtitle}
              badge={hub.korrekturen.badge}
            />
            <NavigationCard
              to={hub.anfragen.to}
              icon={Inbox}
              title="Anfragen"
              subtitle={hub.anfragen.subtitle}
              badge={hub.anfragen.badge}
            />
            <NavigationCard
              to={hub.auftraege.to}
              icon={Package}
              title="Aufträge"
              subtitle={hub.auftraege.subtitle}
              badge={hub.auftraege.badge}
            />
            <NavigationCard
              to="/craftsman/spatial"
              icon={Box}
              title="Spatial Hub"
              subtitle="3D-Aufmaße, Annotationen & Angebote"
            />
            <NavigationCard
              to={hub.finanzen.to}
              icon={TrendingUp}
              title="Finanzen"
              subtitle={hub.finanzen.subtitle}
              badge={hub.finanzen.badge}
            />
            <NavigationCard
              to={hub.rechnungen.to}
              icon={Receipt}
              title="Rechnungen"
              subtitle={hub.rechnungen.subtitle}
              badge={hub.rechnungen.badge}
            />
            <NavigationCard
              to={hub.profil.to}
              icon={User}
              title="Profil"
              subtitle={hub.profil.subtitle}
              badge={hub.profil.badge}
            />
            <NavigationCard
              to={hub.benachrichtigungen.to}
              icon={Bell}
              title="Benachrichtigungen"
              subtitle={hub.benachrichtigungen.subtitle}
              badge={hub.benachrichtigungen.badge}
            />
          </nav>
        </div>
      </section>
    </AppShell>
  )
}
