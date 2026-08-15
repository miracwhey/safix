/**
 * Owner-Notes Realtime · Block FU.5
 *
 * Subscribe-first/fetch-second pattern — mirror von jobReportsLive.ts.
 */

import { supabase } from '../supabase'
import { logBreadcrumb, logError, logInfo } from '../observability'
import {
  SupabaseOwnerNoteRepository,
  type OwnerNoteRepository,
} from './repository/OwnerNoteRepository'
import type { OwnerNote } from './types'

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

export interface SubscribeOwnerNotesOptions {
  repository?: OwnerNoteRepository
  channelFactory?: (name: string) => ReturnType<typeof supabase.channel>
}

export type OwnerNotesListener = (notes: OwnerNote[]) => void

export function subscribeOwnerNotesForJob(
  jobId: string,
  listener: OwnerNotesListener,
  options: SubscribeOwnerNotesOptions = {},
): () => void {
  const repo = options.repository ?? new SupabaseOwnerNoteRepository()
  let cancelled = false
  let current: OwnerNote[] = []

  function emit(): void {
    if (cancelled) return
    listener([...current])
  }

  function applyInsert(row: OwnerNoteRow): void {
    const note = rowToNote(row)
    if (current.some((n) => n.id === note.id)) return
    current = [note, ...current]
    emit()
  }

  function applyUpdate(row: OwnerNoteRow): void {
    const note = rowToNote(row)
    const idx = current.findIndex((n) => n.id === note.id)
    if (idx < 0) {
      current = [note, ...current]
    } else {
      current = current.map((n) => (n.id === note.id ? note : n))
    }
    emit()
  }

  function applyDelete(id: string): void {
    if (!current.some((n) => n.id === id)) return
    current = current.filter((n) => n.id !== id)
    emit()
  }

  const channelName = `owner-notes-job-${jobId}`
  const channel = (options.channelFactory ?? ((n) => supabase.channel(n)))(channelName)
  channel
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'owner_notes', filter: `job_id=eq.${jobId}` },
      (payload: { new: OwnerNoteRow }) => {
        if (cancelled) return
        applyInsert(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'owner_notes', filter: `job_id=eq.${jobId}` },
      (payload: { new: OwnerNoteRow }) => {
        if (cancelled) return
        applyUpdate(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'owner_notes', filter: `job_id=eq.${jobId}` },
      (payload: { old: { id?: string } }) => {
        if (cancelled) return
        const id = typeof payload.old?.id === 'string' ? payload.old.id : null
        if (id) applyDelete(id)
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logInfo('owner.notes.realtime_connected', { jobId })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logBreadcrumb('owner.notes.realtime_error', 'warning', { jobId, status })
      }
    })

  void (async () => {
    try {
      const initial = await repo.listForJob(jobId)
      if (cancelled) return
      const ids = new Set(current.map((n) => n.id))
      const merged = [...current, ...initial.filter((n) => !ids.has(n.id))]
      merged.sort((a, b) => b.createdAt - a.createdAt)
      current = merged
      emit()
    } catch (err) {
      logError(
        'owner.notes.initial_fetch_failed',
        err instanceof Error ? err : undefined,
        { jobId },
      )
    }
  })()

  return () => {
    cancelled = true
    void supabase.removeChannel(channel)
  }
}
