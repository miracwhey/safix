import { supabase } from '../../supabase'
import { logError } from '../../observability'
import type { OwnerNote } from '../types'

interface OwnerNoteRow {
  id: string
  job_id: string
  authored_by: string
  body: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function rowToNote(row: OwnerNoteRow): OwnerNote {
  return {
    id: row.id,
    jobId: row.job_id,
    authoredBy: row.authored_by,
    body: row.body,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

export interface AddOwnerNoteInput {
  jobId: string
  authoredBy: string
  body: string
  metadata?: Record<string, unknown>
}

export interface UpdateOwnerNoteInput {
  noteId: string
  body?: string
  metadata?: Record<string, unknown>
}

export interface OwnerNoteRepository {
  listForJob(jobId: string): Promise<OwnerNote[]>
  countsByJobIds(jobIds: string[]): Promise<Map<string, number>>
  add(input: AddOwnerNoteInput): Promise<OwnerNote>
  update(input: UpdateOwnerNoteInput): Promise<OwnerNote>
  delete(noteId: string): Promise<void>
}

export class SupabaseOwnerNoteRepository implements OwnerNoteRepository {
  async listForJob(jobId: string): Promise<OwnerNote[]> {
    const { data, error } = await supabase
      .from('owner_notes')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    if (error) {
      logError('owner.notes.list_failed', error, { jobId })
      throw error
    }
    return ((data ?? []) as OwnerNoteRow[]).map(rowToNote)
  }

  async countsByJobIds(jobIds: string[]): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map()
    const { data, error } = await supabase
      .from('owner_notes')
      .select('job_id')
      .in('job_id', jobIds)
    if (error) {
      logError('owner.notes.count_failed', error, { count: jobIds.length })
      return new Map()
    }
    const counts = new Map<string, number>()
    for (const row of (data ?? []) as { job_id: string }[]) {
      counts.set(row.job_id, (counts.get(row.job_id) ?? 0) + 1)
    }
    return counts
  }

  async add(input: AddOwnerNoteInput): Promise<OwnerNote> {
    const { data, error } = await supabase
      .from('owner_notes')
      .insert({
        job_id: input.jobId,
        authored_by: input.authoredBy,
        body: input.body,
        metadata: input.metadata ?? {},
      })
      .select('*')
      .single()
    if (error) {
      logError('owner.notes.add_failed', error, { jobId: input.jobId })
      throw error
    }
    return rowToNote(data as OwnerNoteRow)
  }

  async update(input: UpdateOwnerNoteInput): Promise<OwnerNote> {
    const patch: Record<string, unknown> = {}
    if (input.body !== undefined) patch.body = input.body
    if (input.metadata !== undefined) patch.metadata = input.metadata
    const { data, error } = await supabase
      .from('owner_notes')
      .update(patch)
      .eq('id', input.noteId)
      .select('*')
      .single()
    if (error) {
      logError('owner.notes.update_failed', error, { noteId: input.noteId })
      throw error
    }
    return rowToNote(data as OwnerNoteRow)
  }

  async delete(noteId: string): Promise<void> {
    const { error } = await supabase
      .from('owner_notes')
      .delete()
      .eq('id', noteId)
    if (error) {
      logError('owner.notes.delete_failed', error, { noteId })
      throw error
    }
  }
}

export class InMemoryOwnerNoteRepository implements OwnerNoteRepository {
  private notes: OwnerNote[] = []

  async listForJob(jobId: string): Promise<OwnerNote[]> {
    return this.notes
      .filter((n) => n.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async countsByJobIds(jobIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const jobId of jobIds) {
      const n = this.notes.filter((note) => note.jobId === jobId).length
      if (n > 0) counts.set(jobId, n)
    }
    return counts
  }

  async add(input: AddOwnerNoteInput): Promise<OwnerNote> {
    const now = Date.now()
    const note: OwnerNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 8)}`,
      jobId: input.jobId,
      authoredBy: input.authoredBy,
      body: input.body,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.notes = [note, ...this.notes]
    return note
  }

  async update(input: UpdateOwnerNoteInput): Promise<OwnerNote> {
    const idx = this.notes.findIndex((n) => n.id === input.noteId)
    if (idx < 0) throw new Error(`OwnerNote ${input.noteId} not found`)
    const existing = this.notes[idx]!
    const updated: OwnerNote = {
      ...existing,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      updatedAt: Date.now(),
    }
    this.notes = this.notes.map((n) => (n.id === input.noteId ? updated : n))
    return updated
  }

  async delete(noteId: string): Promise<void> {
    this.notes = this.notes.filter((n) => n.id !== noteId)
  }

  _seed(notes: OwnerNote[]): void {
    this.notes = [...notes]
  }
}
