import type { Invoice, InvoiceStatus } from '../types'

/**
 * FSM rank of the invoice status lifecycle. The realtime / by-id cache-merge
 * guard ranks by this instead of wall-clock updatedAt.
 *
 * R3: invoices have TWO writers — the provider client (device wall-clock
 * updatedAt, set in invoiceEngine.transitionInvoiceStatus) and the server settle
 * trigger (DB epoch_ms updatedAt). A pure updatedAt compare could drop a server
 * 'paid' echo whose DB clock lands below an ahead device 'sent'. Ranking by FSM
 * status is clock-agnostic: a forward status transition always wins; only
 * same-status field echoes (sent_at / snapshot refresh) fall back to the
 * updatedAt tiebreak.
 *
 * 'cancelled'=4 deliberately ranks above 'sent': an issued+ invoice can only
 * reach 'cancelled' via a separate INSERT (correction doc), never via an UPDATE
 * of the same row, so a paid-vs-cancelled ordering on a single row is
 * unreachable in practice (the only live cancelled transition is draft→cancelled).
 */
export const INVOICE_FSM_RANK: Record<InvoiceStatus, number> = {
  draft: 0,
  issued: 1,
  sent: 2,
  paid: 3,
  cancelled: 4,
}

/**
 * Decides whether a freshly fetched/echoed invoice should replace the cached
 * one. Drops it only on a genuine staleness:
 *   - a strict FSM-status regression (fresh ranks below cached), or
 *   - a same-status row with an older updatedAt (field-echo tiebreak).
 * A forward status transition always wins regardless of clock — this is what
 * lets a server 'paid' echo survive against an ahead device-clock 'sent'.
 */
export function shouldReplaceCached(fresh: Invoice, cached: Invoice): boolean {
  const freshRank = INVOICE_FSM_RANK[fresh.status]
  const cachedRank = INVOICE_FSM_RANK[cached.status]
  if (freshRank < cachedRank) return false
  if (freshRank === cachedRank && fresh.updatedAt < cached.updatedAt) return false
  return true
}
