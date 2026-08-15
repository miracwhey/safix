/**
 * Presales · Hook · useProviderPresalesProjects (V1.5 · Phase B-P2)
 *
 * Loads all `provider_presales_projects` rows for the caller's org.
 * Returns a model suitable for both the FirstLoginEmpty replacement
 * (presales-only listing) and the Hub-Section "Meine 3D-Projekte".
 *
 * No realtime subscription in V1.5 — list refreshes on mount + manual
 * `refresh()`. The conversion-modal and the create-scan-hook can call
 * `refresh()` after their writes to immediately surface the new row.
 */

import { useCallback, useEffect, useState } from 'react'
import { useProviderOrgId } from '../../spatial/canonical/workflow/resolveProviderOrg'
import { logError } from '../../observability'
import { getPresalesProjectRepository } from '../repository/registry'
import type { PresalesProject } from '../../../domain/presales/presalesProjectTypes'

export interface ProviderPresalesProjectsState {
  loading: boolean
  error: string | null
  /** All non-archived presales projects, newest first. */
  projects: PresalesProject[]
  refresh: () => Promise<void>
}

export function useProviderPresalesProjects(): ProviderPresalesProjectsState {
  const { orgId, resolving, failed } = useProviderOrgId()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<PresalesProject[]>([])

  const fetchProjects = useCallback(async (providerOrgId: string) => {
    setLoading(true)
    setError(null)
    try {
      const repo = getPresalesProjectRepository()
      const rows = await repo.list({
        providerOrgId,
        excludeArchived: true,
      })
      setProjects(rows)
    } catch (err) {
      logError('presales.list_failed', err, { providerOrgId })
      setError('Aufmaße konnten nicht geladen werden.')
      setProjects([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (resolving) {
      setLoading(true)
      return
    }
    if (failed) {
      setLoading(false)
      setError('Konnte Betrieb nicht laden — bitte erneut versuchen.')
      return
    }
    if (!orgId) {
      setLoading(false)
      setProjects([])
      return
    }
    void fetchProjects(orgId)
  }, [orgId, resolving, failed, fetchProjects])

  const refresh = useCallback(async () => {
    if (orgId) await fetchProjects(orgId)
  }, [orgId, fetchProjects])

  return { loading, error, projects, refresh }
}
