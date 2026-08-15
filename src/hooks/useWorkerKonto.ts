/**
 * Hook: useWorkerKonto
 *
 * Wires real domain state into the WorkerKonto view model.
 *
 * Data sources:
 *   - useWorkerMembership  → name, role, providerId
 *   - getProviderCompanyNameById → company name (async, supabase only)
 *   - subscribeCalendar + getEntriesForUser → this worker's entries
 *   - subscribeTeamMembers → needed for getEntriesForUser lookup
 *
 * In in-memory demo mode (VITE_DATA_SOURCE !== 'supabase'):
 *   - Company name fetch is skipped (no real DB)
 *   - Calendar entries fall back to tm-1 (matches WorkerHomeScreen pattern)
 */

import { useEffect, useMemo, useState } from 'react'
import {
  getCalendarEntries,
  subscribeCalendar,
  formatDateKey,
  type CalendarEntry,
} from '../lib/calendar'
import { getEntriesForUser } from '../lib/calendar/calendarSelectors'
import { getTeamMembers, subscribeTeamMembers } from '../lib/team'
import type { TeamMember } from '../lib/jobs/types'
import { useWorkerMembership, type WorkerMembershipState } from './useWorkerMembership'
import { getProviderCompanyNameById } from '../lib/providers'
import { signOut } from '../lib/auth'
import {
  deriveWorkerKontoViewModel,
  type WorkerKontoViewModel,
} from '../lib/worker/workerKontoProjection'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'

// Demo fallback: use tm-1 when there is no real auth→member link (in-memory mode).
const DEMO_MEMBER_ID = 'tm-1'

export function useWorkerKonto(
  userId: string | null,
  email: string | null,
): {
  membershipState: WorkerMembershipState
  vm: WorkerKontoViewModel
  handleSignOut: () => Promise<void>
} {
  const [membershipState, , membership] = useWorkerMembership(userId, !!userId)

  const [companyName, setCompanyName] = useState<string | null>(null)
  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>(getTeamMembers)

  // Subscribe to calendar + team member store changes
  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => setTeamMembers(getTeamMembers()))
    return () => {
      unsubCalendar()
      unsubTeam()
    }
  }, [])

  // Fetch company name once the membership resolves (supabase mode only)
  useEffect(() => {
    if (!membership?.providerId || IS_IN_MEMORY) return
    let cancelled = false
    getProviderCompanyNameById(membership.providerId)
      .then((name) => {
        if (!cancelled && name) setCompanyName(name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [membership?.providerId])

  // Filter entries to only this worker's assignments
  const workerEntries = useMemo<CalendarEntry[]>(() => {
    if (IS_IN_MEMORY) {
      // Demo mode: no real auth uid links to team members, use tm-1 as stand-in
      return allEntries.filter((e) => e.assignedMemberIds.includes(DEMO_MEMBER_ID))
    }
    if (!userId) return []
    return getEntriesForUser(allEntries, teamMembers, userId)
  }, [allEntries, teamMembers, userId])

  // Today key is stable across renders in the same session
  const todayKey = useMemo(() => formatDateKey(new Date()), [])

  const vm = useMemo<WorkerKontoViewModel>(
    () =>
      deriveWorkerKontoViewModel({
        membership,
        email,
        companyName,
        workerEntries,
        todayKey,
      }),
    [membership, email, companyName, workerEntries, todayKey],
  )

  const handleSignOut = async () => {
    await signOut()
  }

  return { membershipState, vm, handleSignOut }
}
