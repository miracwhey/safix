import type { Dispute, DisputeEvidence, SplitProposal } from '../types'

export interface DisputeRepository {
  initialize(): Promise<void>

  /**
   * Returns `true` once the repository has completed its initial data load
   * (i.e. `initialize()` has resolved at least once).
   *
   * Used by guards that need to distinguish between "dispute data not loaded yet"
   * and "no dispute genuinely exists for this job" without resorting to a timeout.
   *
   * For InMemoryDisputeRepository this is always `true` (data is available at
   * construction time).
   * For SupabaseDisputeRepository this becomes `true` after the first
   * `initialize()` call completes.
   */
  isHydrated(): boolean

  getAll(): Dispute[]
  getById(disputeId: string): Dispute | undefined
  getByJobId(jobId: string): Dispute | undefined
  /** Returns all disputes ever opened for a job (including historical / resolved ones) */
  getDisputesByJob(jobId: string): Dispute[]
  add(dispute: Dispute): Promise<void>
  update(disputeId: string, updater: (dispute: Dispute) => Dispute): Promise<void>
  subscribe(listener: () => void): () => void

  /**
   * Applies a dispute that was committed to the database by an atomic RPC call
   * directly into the local in-memory cache — without issuing a second INSERT.
   *
   * Use this when `open_dispute_atomic` RPC already persisted the dispute row.
   * Prevents the duplicate-key error that `add()` would cause (the RPC already
   * owns the DB write; this call only updates the reactive local cache).
   *
   * Idempotent: if the dispute is already present in the cache it is replaced.
   */
  applyFromRpc(dispute: Dispute): void

  /**
   * Atomically opens a dispute.
   *
   * For SupabaseDisputeRepository: calls the `open_dispute_atomic` RPC which
   * locks the payment row, validates state, inserts the dispute, and updates
   * payment + job in a single transaction. Applies to local cache on success.
   * On 23505 (concurrent duplicate): returns the winning dispute from cache or DB.
   *
   * For InMemoryDisputeRepository: inserts into local state (no RPC).
   *
   * Idempotent: returns existing dispute if one is already present for the job.
   */
  openDisputeAtomic(dispute: Dispute): Promise<Dispute>

  /**
   * Party-Statement-Submit (H24): appends a description-evidence to
   * disputes.metadata.evidence AND transitions *_waiting → under_review
   * atomically.
   *
   * SupabaseDisputeRepository: calls the SECURITY DEFINER RPC
   * `party_submit_dispute_statement` which re-verifies the caller is the
   * responding party (customer @ customer_waiting, provider OWNER @
   * provider_waiting), arms a transaction-local sentinel GUC so the
   * disputes_status_change_guard trigger admits exactly this transition,
   * writes dispute_status_history (source='client') and mirrors
   * jobs.dispute_status. Direct `update()` with a status change would be
   * rejected by the trigger with 42501.
   *
   * InMemoryDisputeRepository: same domain mutation locally.
   * Throws when the dispute is missing or not in customer_waiting /
   * provider_waiting (Submit flips the status — no second submit).
   */
  partySubmitStatement(disputeId: string, evidence: DisputeEvidence): Promise<Dispute>

  /**
   * Operator-only state transitions. Each method drives one step of the
   * dispute state machine that may only be performed by a profile carrying
   * `is_operator = true`.
   *
   * SupabaseDisputeRepository routes every call through a SECURITY DEFINER
   * RPC that re-verifies the operator flag, validates the from-status, applies
   * the update, writes dispute_status_history, and mirrors the lifecycle
   * status onto jobs.dispute_status. The returned dispute reflects the row as
   * persisted in the DB.
   *
   * InMemoryDisputeRepository performs the same state-machine transition
   * locally so unit tests can exercise the workflow without Supabase.
   *
   * Throws on:
   *   - unauthenticated / non-operator caller (Supabase only — surfaces 42501)
   *   - invalid from-status for the requested transition
   *   - missing dispute for the supplied jobId
   * Idempotent when the dispute is already in the target status.
   */
  operatorRequestCustomerEvidence(jobId: string): Promise<Dispute>
  operatorRequestProviderEvidence(jobId: string): Promise<Dispute>
  operatorMarkUnderReview(jobId: string): Promise<Dispute>
  operatorResolveRelease(jobId: string): Promise<Dispute>
  operatorResolveRefund(jobId: string): Promise<Dispute>
  operatorResolveSplit(jobId: string, splitRatio: number): Promise<Dispute>
  operatorReject(jobId: string): Promise<Dispute>

  /**
   * P4 Teil B — consensus-split proposal flow. Lets the two dispute parties
   * agree a split ratio between themselves, without an operator decision.
   *
   * SupabaseDisputeRepository routes the three mutating methods through the
   * SECURITY DEFINER RPCs (`propose_split_atomic`, `confirm_split_proposal`,
   * `reject_split_proposal`). Each RPC re-verifies — in the database, against
   * `auth.uid()` — that the caller is a party of the dispute, that a proposer
   * cannot confirm their own proposal, that the ratio is in bounds, and that
   * the dispute is not already resolved, then performs the write with the
   * status-guard trigger bypassed via a transaction-local sentinel GUC.
   * Direct table writes are blocked by RLS.
   *
   * InMemoryDisputeRepository mirrors the same state transitions locally
   * (auth is enforced server-side; the in-memory layer is caller-agnostic) so
   * unit tests can exercise the flow without Supabase.
   */

  /**
   * Creates a new pending split proposal for the dispute. Supersedes any prior
   * pending proposal (round = previous max + 1). Returns the inserted row.
   */
  proposeSplit(disputeId: string, ratio: number): Promise<SplitProposal>

  /**
   * Confirms a pending split proposal. On success the dispute is resolved with
   * `decision='split'`, `splitRatio` = the proposal's ratio and
   * `settlementStatus='pending'`. Returns the resolved dispute row.
   */
  confirmSplitProposal(proposalId: string): Promise<Dispute>

  /**
   * Settles a consensus-resolved split dispute — flips `settlementStatus`
   * `pending` → `settled` after the money leg (release + refund + bridge) has
   * fully succeeded. The consensus-path sibling of `settleDispute()`.
   *
   * SupabaseDisputeRepository calls the SECURITY DEFINER RPC
   * `settle_consensus_split(p_dispute_id)`. The RPC re-verifies — against
   * `auth.uid()` — that the caller is a party of the dispute, arms a
   * settle-scoped transaction-local sentinel GUC so the
   * `disputes_status_change_guard` trigger admits the settlement write, and
   * flips `settlement_status`. It is idempotent: an already-settled dispute is
   * returned unchanged. This RPC is required because the plain PostgREST UPDATE
   * `settleDispute()` issues is BLOCKED for a dispute PARTY by the guard trigger
   * (SQLSTATE 42501) — only operators pass the trigger's operator branch.
   * The returned row is mapped (same `rowToDispute` mapper as
   * `confirmSplitProposal`) and applied to the local cache via `applyFromRpc`.
   *
   * InMemoryDisputeRepository flips `settlementStatus='settled'` on the cached
   * dispute locally (idempotent; authz is server-side only). Throws when the
   * dispute is missing.
   */
  settleSplitConsensus(disputeId: string): Promise<Dispute>

  /** Rejects a pending split proposal. Returns the rejected proposal row. */
  rejectSplitProposal(proposalId: string): Promise<SplitProposal>

  /**
   * Returns the dispute's currently-pending split proposal, or `undefined`
   * when none is pending. RLS restricts the underlying SELECT to a party of
   * the dispute (or an operator).
   */
  getActiveProposal(disputeId: string): Promise<SplitProposal | undefined>

  /**
   * Maps a split proposal to its parent dispute WITHOUT mutating anything.
   *
   * Read-only recovery helper for confirmSplitWorkflow's retry path: once
   * `confirm_split_proposal` has consumed the proposal it is no longer
   * 'pending', so a second confirm raises P0002 (the RPC is NOT idempotent).
   * To re-drive the money leg the workflow still needs the resolved dispute —
   * this resolves it by reading `dispute_split_proposals` → `dispute_id`
   * (RLS `dsp_select_own` admits a party) and returning that dispute. Performs
   * no write and never re-calls the non-idempotent confirm RPC.
   *
   * Returns `undefined` when the proposal or its dispute cannot be found.
   */
  getDisputeForProposal(proposalId: string): Promise<Dispute | undefined>
}
