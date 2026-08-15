/**
 * Provider-Pre-Sales-Spatial · Supabase Repository (V1.5 · Phase B-P1)
 *
 * Production target. All RLS enforcement is server-side; this adapter is a
 * pure mapper between camelCase TS types and snake_case DB columns.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  PresalesProject,
  PresalesProjectStatus,
} from '../../../domain/presales/presalesProjectTypes'
import type {
  CreatePresalesProjectInput,
  ListPresalesProjectsFilter,
  PresalesProjectRepository,
  UpdatePresalesProjectInput,
} from './PresalesProjectRepository'

interface PresalesProjectRow {
  id: string
  provider_org_id: string
  created_by_user_id: string
  title: string
  location_hint: string | null
  customer_name_draft: string | null
  customer_email_draft: string | null
  customer_phone_draft: string | null
  notes: string | null
  status: PresalesProjectStatus
  scanned_at: string | null
  quoted_at: string | null
  converted_at: string | null
  converted_to_job_id: string | null
  created_at: string
  updated_at: string
}

function fromRow(row: PresalesProjectRow): PresalesProject {
  return {
    id: row.id,
    providerOrgId: row.provider_org_id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    locationHint: row.location_hint,
    customerNameDraft: row.customer_name_draft,
    customerEmailDraft: row.customer_email_draft,
    customerPhoneDraft: row.customer_phone_draft,
    notes: row.notes,
    status: row.status,
    scannedAt: row.scanned_at,
    quotedAt: row.quoted_at,
    convertedAt: row.converted_at,
    convertedToJobId: row.converted_to_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SupabasePresalesProjectRepository implements PresalesProjectRepository {
  private readonly client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async create(input: CreatePresalesProjectInput): Promise<PresalesProject> {
    const { data, error } = await this.client
      .from('provider_presales_projects')
      .insert({
        provider_org_id: input.providerOrgId,
        created_by_user_id: input.createdByUserId,
        title: input.title,
        location_hint: input.locationHint ?? null,
        customer_name_draft: input.customerNameDraft ?? null,
        customer_email_draft: input.customerEmailDraft ?? null,
        customer_phone_draft: input.customerPhoneDraft ?? null,
        notes: input.notes ?? null,
      })
      .select('*')
      .single<PresalesProjectRow>()

    if (error) throw error
    return fromRow(data)
  }

  async findById(id: string): Promise<PresalesProject | null> {
    const { data, error } = await this.client
      .from('provider_presales_projects')
      .select('*')
      .eq('id', id)
      .maybeSingle<PresalesProjectRow>()

    if (error) throw error
    return data ? fromRow(data) : null
  }

  async update(id: string, patch: UpdatePresalesProjectInput): Promise<PresalesProject> {
    const dbPatch: Partial<PresalesProjectRow> = {}
    if (patch.title !== undefined) dbPatch.title = patch.title
    if (patch.locationHint !== undefined) dbPatch.location_hint = patch.locationHint
    if (patch.customerNameDraft !== undefined) dbPatch.customer_name_draft = patch.customerNameDraft
    if (patch.customerEmailDraft !== undefined) dbPatch.customer_email_draft = patch.customerEmailDraft
    if (patch.customerPhoneDraft !== undefined) dbPatch.customer_phone_draft = patch.customerPhoneDraft
    if (patch.notes !== undefined) dbPatch.notes = patch.notes
    if (patch.status !== undefined) dbPatch.status = patch.status
    if (patch.scannedAt !== undefined) dbPatch.scanned_at = patch.scannedAt
    if (patch.quotedAt !== undefined) dbPatch.quoted_at = patch.quotedAt
    if (patch.convertedAt !== undefined) dbPatch.converted_at = patch.convertedAt
    if (patch.convertedToJobId !== undefined) dbPatch.converted_to_job_id = patch.convertedToJobId

    const { data, error } = await this.client
      .from('provider_presales_projects')
      .update(dbPatch)
      .eq('id', id)
      .select('*')
      .single<PresalesProjectRow>()

    if (error) throw error
    return fromRow(data)
  }

  async list(filter: ListPresalesProjectsFilter): Promise<PresalesProject[]> {
    let query = this.client
      .from('provider_presales_projects')
      .select('*')
      .eq('provider_org_id', filter.providerOrgId)

    if (filter.status !== undefined) {
      if (Array.isArray(filter.status)) {
        query = query.in('status', filter.status)
      } else {
        query = query.eq('status', filter.status)
      }
    }
    if (filter.excludeArchived) {
      query = query.neq('status', 'archived')
    }

    const { data, error } = await query.order('created_at', { ascending: false })
    if (error) throw error
    return (data as PresalesProjectRow[]).map(fromRow)
  }

  async remove(id: string): Promise<void> {
    const { error } = await this.client
      .from('provider_presales_projects')
      .delete()
      .eq('id', id)

    if (error) throw error
  }
}
