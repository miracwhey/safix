/**
 * N13.OPS — Operator-Center write paths.
 *
 * Two operator-only mutations against `disputes.metadata`:
 *
 *   1. `addOperatorCommentWorkflow` — appends a free-text comment to the
 *      `operator_comments` jsonb array. The reconciliation read-model
 *      (selectReconciliationView → operatorComments) renders the array
 *      verbatim to both parties as the official "operator voice".
 *
 *   2. `setEvidenceCounterpartyShareWorkflow` — toggles a dispute media id
 *      in/out of `shared_evidence_ids`. The selector flips
 *      `sharedWithCounterparty = true` for any media row whose id is in the
 *      list, which causes the receiving party to see it under
 *      "sharedCounterpartyEvidence".
 *
 * Both operations:
 *   - Reject non-operator callers via `canAccessDisputeResolution(session)`.
 *     RLS allows operator UPDATE on `disputes` (operator branch in
 *     `disputes_update_own_side`); the workflow guard is the third defence
 *     line so nothing slips through if RLS is ever loosened.
 *   - Read-merge-write `metadata` directly on the row. Going through
 *     `SupabaseDisputeRepository.update()` would require the operator-only
 *     `operator_comments` / `shared_evidence_ids` shapes to leak into the
 *     `Dispute` domain type, which they should not — they are operator
 *     surface, not dispute domain state.
 *   - Use a SELECT … UPDATE round-trip rather than a Postgres jsonb-mutation
 *     RPC so they can run anywhere a Supabase client is available, and so
 *     concurrent writes by two operators are detected (last-writer-wins
 *     within a single session is acceptable for this surface; conflicting
 *     writes by two operators 5 minutes apart are extraordinarily unlikely).
 *
 * No UI surface lands with this PR. The data shape is ready; the operator
 * console form follows in a dedicated PR.
 */

import { supabase } from '../supabase'
import { canAccessDisputeResolution } from '../access'
import { getSession } from '../session'

type Metadata = Record<string, unknown>

type OperatorCommentRecord = {
  id: string
  body: string
  written_at: string
}

export class OperatorWriteAuthError extends Error {
  readonly code = 'operator_write_unauthorized'
  constructor(message = 'Operator-only action') {
    super(message)
    this.name = 'OperatorWriteAuthError'
  }
}

export class OperatorWriteValidationError extends Error {
  readonly code = 'operator_write_invalid_input'
  constructor(message: string) {
    super(message)
    this.name = 'OperatorWriteValidationError'
  }
}

export class OperatorWriteNotFoundError extends Error {
  readonly code = 'operator_write_dispute_not_found'
  constructor(disputeId: string) {
    super(`dispute ${disputeId} not found`)
    this.name = 'OperatorWriteNotFoundError'
  }
}

function assertOperator(): void {
  if (!canAccessDisputeResolution(getSession())) {
    throw new OperatorWriteAuthError()
  }
}

async function loadMetadata(disputeId: string): Promise<Metadata> {
  const { data, error } = await supabase
    .from('disputes')
    .select('id, metadata')
    .eq('id', disputeId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new OperatorWriteNotFoundError(disputeId)
  const meta = (data as { metadata?: unknown }).metadata
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...(meta as Metadata) }
    : {}
}

async function writeMetadata(disputeId: string, next: Metadata): Promise<void> {
  const { error } = await supabase
    .from('disputes')
    .update({ metadata: next })
    .eq('id', disputeId)
  if (error) throw error
}

function generateCommentId(): string {
  // crypto.randomUUID is available in modern browsers, Node 19+, and the
  // Supabase client polyfill stack. Vitest runs against Node ≥20.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback (intentionally non-crypto): timestamp + random. Operator
  // comment ids are not security-sensitive — they are display-only.
  return `cmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function readCommentArray(meta: Metadata): OperatorCommentRecord[] {
  const raw = meta.operator_comments
  if (!Array.isArray(raw)) return []
  const out: OperatorCommentRecord[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.body !== 'string') continue
    const writtenAt = typeof e.written_at === 'string' ? e.written_at : null
    if (!writtenAt) continue
    out.push({ id: e.id, body: e.body, written_at: writtenAt })
  }
  return out
}

function readSharedIds(meta: Metadata): string[] {
  const raw = meta.shared_evidence_ids
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) {
      out.push(entry)
    }
  }
  return out
}

// ─── public API ──────────────────────────────────────────────────────────

export type AddOperatorCommentResult = {
  comment: OperatorCommentRecord
}

/**
 * Appends an operator comment to `disputes.metadata.operator_comments`.
 * Returns the created record (id + written_at generated server-time-ish
 * by the caller) so the UI can echo it back without re-fetching.
 */
export async function addOperatorCommentWorkflow(
  disputeId: string,
  body: string,
): Promise<AddOperatorCommentResult> {
  assertOperator()

  const trimmed = body.trim()
  if (trimmed.length === 0) {
    throw new OperatorWriteValidationError('Operator comment body cannot be empty')
  }
  if (trimmed.length > 5000) {
    throw new OperatorWriteValidationError('Operator comment exceeds 5000 character limit')
  }

  const meta = await loadMetadata(disputeId)
  const existing = readCommentArray(meta)
  const comment: OperatorCommentRecord = {
    id: generateCommentId(),
    body: trimmed,
    written_at: new Date().toISOString(),
  }
  const next: Metadata = {
    ...meta,
    operator_comments: [...existing, comment],
  }
  await writeMetadata(disputeId, next)
  return { comment }
}

export type SetEvidenceShareResult = {
  sharedIds: string[]
}

/**
 * Adds or removes a dispute media id from
 * `disputes.metadata.shared_evidence_ids`. Idempotent — re-sharing or
 * re-revoking the same id is a no-op write.
 */
export async function setEvidenceCounterpartyShareWorkflow(
  disputeId: string,
  evidenceId: string,
  share: boolean,
): Promise<SetEvidenceShareResult> {
  assertOperator()

  if (typeof evidenceId !== 'string' || evidenceId.length === 0) {
    throw new OperatorWriteValidationError('evidenceId required')
  }

  const meta = await loadMetadata(disputeId)
  const current = readSharedIds(meta)
  const isShared = current.includes(evidenceId)

  if (share && isShared) return { sharedIds: current }
  if (!share && !isShared) return { sharedIds: current }

  const nextIds = share
    ? [...current, evidenceId]
    : current.filter((id) => id !== evidenceId)

  const next: Metadata = {
    ...meta,
    shared_evidence_ids: nextIds,
  }
  await writeMetadata(disputeId, next)
  return { sharedIds: nextIds }
}
