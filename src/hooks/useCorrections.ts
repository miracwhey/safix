/**
 * Hook: useCorrections
 *
 * Subscribes to the CorrectionRepository and returns the current list.
 * Used by both worker and owner/admin surfaces.
 *
 * RLS at the DB level enforces visibility:
 *   - Workers see only their own requests
 *   - Owners see all requests for their company
 *
 * In in-memory mode, filtering is done client-side:
 *   - Workers: filter by workerTeamMemberId === DEMO_MEMBER_ID
 *   - Owners: see all mock data
 */

import { useEffect, useState } from 'react'
import {
  getCorrectionRepository,
  type CorrectionRequest,
} from '../lib/corrections'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'
const DEMO_MEMBER_ID = 'tm-1'

export function useCorrections(): {
  requests: CorrectionRequest[]
  isHydrated: boolean
} {
  const repo = getCorrectionRepository()
  const [requests, setRequests] = useState<CorrectionRequest[]>(repo.getAll())
  const [isHydrated, setIsHydrated] = useState(repo.isHydrated())

  useEffect(() => {
    return repo.subscribe(() => {
      setRequests(repo.getAll())
      setIsHydrated(repo.isHydrated())
    })
  }, [repo])

  return { requests, isHydrated }
}

/**
 * Returns corrections for the current worker.
 * In supabase mode: RLS already filters to own requests.
 * In in-memory mode: filters by DEMO_MEMBER_ID.
 */
export function useWorkerCorrections(): {
  requests: CorrectionRequest[]
  isHydrated: boolean
} {
  const { requests, isHydrated } = useCorrections()

  if (IS_IN_MEMORY) {
    return {
      requests: requests.filter((r) => r.workerTeamMemberId === DEMO_MEMBER_ID),
      isHydrated,
    }
  }

  return { requests, isHydrated }
}
