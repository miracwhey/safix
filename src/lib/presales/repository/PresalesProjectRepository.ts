/**
 * Provider-Pre-Sales-Spatial · Repository Contract (V1.5 · Phase B-P1)
 *
 * Persistence contract for `provider_presales_projects`. Mirrors the canonical
 * SpatialSceneRepository pattern: DB uses snake_case, TS uses camelCase, all
 * timestamps as ISO-8601 strings.
 *
 * Two implementations:
 *   - {@link InMemoryPresalesProjectRepository} — single-process testing.
 *   - {@link SupabasePresalesProjectRepository} — production target.
 *
 * Repository handles header-row CRUD only. Linked scans + scenes are owned
 * by their own repositories.
 */

import type {
  PresalesProject,
  PresalesProjectStatus,
} from '../../../domain/presales/presalesProjectTypes'

export interface CreatePresalesProjectInput {
  providerOrgId: string
  createdByUserId: string
  title: string
  locationHint?: string | null
  customerNameDraft?: string | null
  customerEmailDraft?: string | null
  customerPhoneDraft?: string | null
  notes?: string | null
}

export interface UpdatePresalesProjectInput {
  title?: string
  locationHint?: string | null
  customerNameDraft?: string | null
  customerEmailDraft?: string | null
  customerPhoneDraft?: string | null
  notes?: string | null
  status?: PresalesProjectStatus
  scannedAt?: string | null
  quotedAt?: string | null
  convertedAt?: string | null
  convertedToJobId?: string | null
}

export interface ListPresalesProjectsFilter {
  providerOrgId: string
  status?: PresalesProjectStatus | PresalesProjectStatus[]
  excludeArchived?: boolean
}

export interface PresalesProjectRepository {
  create(input: CreatePresalesProjectInput): Promise<PresalesProject>
  findById(id: string): Promise<PresalesProject | null>
  update(id: string, patch: UpdatePresalesProjectInput): Promise<PresalesProject>
  list(filter: ListPresalesProjectsFilter): Promise<PresalesProject[]>
  remove(id: string): Promise<void>
}
