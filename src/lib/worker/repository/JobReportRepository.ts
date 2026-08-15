/**
 * JobReportRepository · Block C.2
 *
 * Analog zu JobPhotoRepository für die `job_reports`-Tabelle (Migration
 * `20260508000003_job_reports.sql`). Read-on-demand, kein Optimistic-
 * Cache. Insert läuft direkt durch RLS; UPDATE/DELETE haben in C.2 noch
 * keine UI-Bindung — wir exposen sie aber für C.3 (Worker-Edit-Window).
 */

import { supabase } from '../../supabase'
import { logError } from '../../observability'
import type { JobReport } from '../dokuTypes'

interface JobReportRow {
  id: string
  job_id: string
  provider_id: string
  authored_by: string
  body: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function rowToReport(row: JobReportRow): JobReport {
  return {
    id: row.id,
    jobId: row.job_id,
    providerId: row.provider_id,
    authoredBy: row.authored_by,
    body: row.body,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

export interface AddJobReportInput {
  jobId: string
  providerId: string
  authoredBy: string
  body: string
  metadata?: Record<string, unknown>
}

export interface UpdateJobReportInput {
  reportId: string
  body?: string
  metadata?: Record<string, unknown>
}

export interface JobReportRepository {
  listForJob(jobId: string): Promise<JobReport[]>
  add(input: AddJobReportInput): Promise<JobReport>
  update(input: UpdateJobReportInput): Promise<JobReport>
  delete(reportId: string): Promise<void>
}

export class SupabaseJobReportRepository implements JobReportRepository {
  async listForJob(jobId: string): Promise<JobReport[]> {
    const { data, error } = await supabase
      .from('job_reports')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    if (error) {
      logError('worker.job_reports.list_failed', error, { jobId })
      throw error
    }
    return ((data ?? []) as JobReportRow[]).map(rowToReport)
  }

  async add(input: AddJobReportInput): Promise<JobReport> {
    const insertRow = {
      job_id: input.jobId,
      provider_id: input.providerId,
      authored_by: input.authoredBy,
      body: input.body,
      metadata: input.metadata ?? {},
    }
    const { data, error } = await supabase
      .from('job_reports')
      .insert(insertRow)
      .select('*')
      .single()
    if (error) {
      logError('worker.job_reports.add_failed', error, {
        jobId: input.jobId,
      })
      throw error
    }
    return rowToReport(data as JobReportRow)
  }

  async update(input: UpdateJobReportInput): Promise<JobReport> {
    const patch: Record<string, unknown> = {}
    if (input.body !== undefined) patch.body = input.body
    if (input.metadata !== undefined) patch.metadata = input.metadata
    const { data, error } = await supabase
      .from('job_reports')
      .update(patch)
      .eq('id', input.reportId)
      .select('*')
      .single()
    if (error) {
      logError('worker.job_reports.update_failed', error, {
        reportId: input.reportId,
      })
      throw error
    }
    return rowToReport(data as JobReportRow)
  }

  async delete(reportId: string): Promise<void> {
    const { error } = await supabase
      .from('job_reports')
      .delete()
      .eq('id', reportId)
    if (error) {
      logError('worker.job_reports.delete_failed', error, { reportId })
      throw error
    }
  }
}
