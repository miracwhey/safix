/**
 * One-shot loader for `dispute_status_history` rows (N13.2).
 *
 * The history table is append-only and written from two sides:
 *   - server-side via the operator RPCs (`source = 'admin' | 'system'`)
 *   - client-side via `SupabaseDisputeRepository.writeStatusHistory`
 *     (`source = 'client'`)
 *
 * There is no in-memory store / subscription for history rows. This loader
 * is intentionally a thin async fetch that selectors call on mount and
 * after a dispute mutation. RLS gates which rows the caller may see — the
 * loader does no additional authorisation.
 */

import { supabase } from '../../supabase'
import { logError } from '../../observability'
import type { DisputeStatus } from '../../disputes/types'
import type { ReconciliationHistoryRow } from '../types'

interface HistoryRowDTO {
  id: string
  dispute_id: string
  previous_status: string | null
  next_status: string
  source: string
  actor_user_id: string | null
  note: string | null
  created_at: string
}

const KNOWN_SOURCES = new Set(['client', 'admin', 'system'])

function isHistorySource(value: string): value is ReconciliationHistoryRow['source'] {
  return KNOWN_SOURCES.has(value)
}

const KNOWN_STATUSES = new Set<DisputeStatus>([
  'open',
  'under_review',
  'customer_waiting',
  'provider_waiting',
  'resolved',
  'closed',
  'cancelled',
])

function asDisputeStatus(value: string | null): DisputeStatus | null {
  if (value === null) return null
  return KNOWN_STATUSES.has(value as DisputeStatus) ? (value as DisputeStatus) : null
}

export async function loadDisputeHistory(
  disputeId: string,
): Promise<ReconciliationHistoryRow[]> {
  if (!disputeId) return []
  const { data, error } = await supabase
    .from('dispute_status_history')
    .select(
      'id, dispute_id, previous_status, next_status, source, actor_user_id, note, created_at',
    )
    .eq('dispute_id', disputeId)
    .order('created_at', { ascending: true })

  if (error) {
    logError('reconciliation.history.load_failed', error, { disputeId })
    return []
  }
  if (!Array.isArray(data)) return []

  const rows: ReconciliationHistoryRow[] = []
  for (const dto of data as HistoryRowDTO[]) {
    if (!isHistorySource(dto.source)) continue
    const next = asDisputeStatus(dto.next_status)
    if (!next) continue
    rows.push({
      id: dto.id,
      disputeId: dto.dispute_id,
      previousStatus: asDisputeStatus(dto.previous_status),
      nextStatus: next,
      source: dto.source,
      actorUserId: dto.actor_user_id ?? null,
      note: dto.note ?? null,
      createdAt: dto.created_at,
    })
  }
  return rows
}
