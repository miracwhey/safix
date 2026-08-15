/**
 * Provider-Pre-Sales-Spatial · In-Memory Repository (V1.5 · Phase B-P1)
 *
 * Single-process testing implementation. Mirrors RLS semantics minimally:
 * caller scoping happens at the workflow layer, not here.
 */

import type {
  PresalesProject,
  PresalesProjectStatus,
} from '../../../domain/presales/presalesProjectTypes'
import { canTransition } from '../../../domain/presales/presalesProjectTypes'
import type {
  CreatePresalesProjectInput,
  ListPresalesProjectsFilter,
  PresalesProjectRepository,
  UpdatePresalesProjectInput,
} from './PresalesProjectRepository'

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `psp_${Math.random().toString(36).slice(2)}_${Date.now()}`
}

export class InMemoryPresalesProjectRepository implements PresalesProjectRepository {
  private readonly rows = new Map<string, PresalesProject>()

  async create(input: CreatePresalesProjectInput): Promise<PresalesProject> {
    const now = new Date().toISOString()
    const row: PresalesProject = {
      id: uuid(),
      providerOrgId: input.providerOrgId,
      createdByUserId: input.createdByUserId,
      title: input.title,
      locationHint: input.locationHint ?? null,
      customerNameDraft: input.customerNameDraft ?? null,
      customerEmailDraft: input.customerEmailDraft ?? null,
      customerPhoneDraft: input.customerPhoneDraft ?? null,
      notes: input.notes ?? null,
      status: 'draft',
      scannedAt: null,
      quotedAt: null,
      convertedAt: null,
      convertedToJobId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.rows.set(row.id, row)
    return row
  }

  async findById(id: string): Promise<PresalesProject | null> {
    return this.rows.get(id) ?? null
  }

  async update(id: string, patch: UpdatePresalesProjectInput): Promise<PresalesProject> {
    const existing = this.rows.get(id)
    if (!existing) throw new Error(`PresalesProject not found: ${id}`)

    if (patch.status && patch.status !== existing.status) {
      if (!canTransition(existing.status, patch.status)) {
        throw new Error(
          `PresalesProject status transition not allowed: ${existing.status} → ${patch.status}`,
        )
      }
    }

    const next: PresalesProject = {
      ...existing,
      title: patch.title ?? existing.title,
      locationHint: patch.locationHint ?? existing.locationHint,
      customerNameDraft: patch.customerNameDraft ?? existing.customerNameDraft,
      customerEmailDraft: patch.customerEmailDraft ?? existing.customerEmailDraft,
      customerPhoneDraft: patch.customerPhoneDraft ?? existing.customerPhoneDraft,
      notes: patch.notes ?? existing.notes,
      status: patch.status ?? existing.status,
      scannedAt: patch.scannedAt ?? existing.scannedAt,
      quotedAt: patch.quotedAt ?? existing.quotedAt,
      convertedAt: patch.convertedAt ?? existing.convertedAt,
      convertedToJobId: patch.convertedToJobId ?? existing.convertedToJobId,
      updatedAt: new Date().toISOString(),
    }
    this.rows.set(id, next)
    return next
  }

  async list(filter: ListPresalesProjectsFilter): Promise<PresalesProject[]> {
    const statusSet =
      filter.status === undefined
        ? null
        : new Set<PresalesProjectStatus>(
            Array.isArray(filter.status) ? filter.status : [filter.status],
          )

    const result: PresalesProject[] = []
    for (const row of this.rows.values()) {
      if (row.providerOrgId !== filter.providerOrgId) continue
      if (filter.excludeArchived && row.status === 'archived') continue
      if (statusSet && !statusSet.has(row.status)) continue
      result.push(row)
    }
    return result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id)
  }

  /** Test-only reset for vitest setup hooks. */
  __reset__(): void {
    this.rows.clear()
  }
}
