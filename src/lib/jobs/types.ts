import type {
  JobStatus,
  PaymentState as CorePaymentState,
  UserRole,
} from '../shared/coreTypes'
import type { JobCommercialOrigin, AttributionStatus } from '../commercialAttribution/types'

export type PaymentState = CorePaymentState

/**
 * Tracks the dispute lifecycle for this job.
 * Mirrors the production `disputes.status` CHECK constraint exactly so the
 * job-side projection cannot drift from the dispute domain. Decision/booking
 * outcome live on the Dispute itself (`decision`, `resolutionType`).
 */
export type DisputeJobStatus =
  | 'open'
  | 'under_review'
  | 'customer_waiting'
  | 'provider_waiting'
  | 'resolved'
  | 'closed'
  | 'cancelled'

export type TeamMember = {
  id: string
  /**
   * Supabase user_id of the real user account this team member maps to.
   * When present, worker assignment resolution uses this field to match the
   * logged-in user to calendar entries.  Absent for legacy or un-linked members.
   */
  userId?: string
  /**
   * providers.id that owns this team membership.
   * Used to enforce company scope when resolving worker-visible calendar entries:
   * a worker can only see entries whose provider_id matches their own.
   * Absent for legacy seed members (tm-1…tm-4) that predate the company model.
   */
  providerId?: string
  name: string
  role: UserRole | string
  /**
   * Membership active flag from team_members.is_active.
   * Optional for backwards-compat — older repository implementations may
   * omit it. Owner-side admin surfaces (TeamSettings, member detail) treat
   * `undefined` as active to avoid misclassifying legacy rows.
   */
  isActive?: boolean
  /** Owner-managed contact + capacity fields. All optional. */
  phone?: string | null
  email?: string | null
  avatarUrl?: string | null
  weeklyTargetHours?: number | null
  dailyTargetHours?: number | null
}

/**
 * Records where and how the job was originally created.
 * 'inquiry_reel'     – customer contacted via an Explore reel
 * 'inquiry_profile'  – customer contacted via a craftsman profile page
 * 'inquiry_project'  – customer sent a structured builder project as inquiry
 * 'inquiry_category' – customer searched by service category
 * 'direct'           – job created directly without prior inquiry
 */
export type IntakeOrigin = 'inquiry_reel' | 'inquiry_profile' | 'inquiry_project' | 'inquiry_category' | 'direct'

/**
 * Preserves structured request context that was available at the time the job
 * was created, typically sourced from the originating inquiry conversation.
 * All fields are optional — the intake selectors use their presence/absence to
 * compute readiness.
 */
export type IntakeContext = {
  origin: IntakeOrigin
  /** Human-readable label for the intake origin (e.g. "Explore-Reel") */
  originLabel: string
  /** Free-text description of the work the customer is requesting */
  requestDescription?: string
  /** Location where the work is needed */
  requestLocation?: string
  /** Budget range as provided by the customer */
  requestBudget?: string
  /** Expected project duration as provided by the customer */
  requestDuration?: string
}

export type JobMessageSender = 'customer' | 'business'

export type JobMessage = {
  id: string
  sender: JobMessageSender
  text: string
  createdAtLabel: string
}

export type JobActivityType =
  | 'status'
  | 'payment'
  | 'note'
  | 'photo'
  | 'message'
  | 'system'

export type JobActivity = {
  id: string
  type: JobActivityType
  text: string
  createdAtLabel: string
}

export type Job = {
  id: string
  projectId: string
  title: string
  customer: string
  location: string
  dateLabel: string
  status: JobStatus
  amount: string
  description: string
  paymentState: PaymentState
  documentationStatus: string
  assignedMemberIds: string[]
  notes: string[]
  photoCount: number
  activities: JobActivity[]
  /**
   * The canonical `providers.id` (DB-generated UUID) that owns this job.
   * Written to the `provider_id` FK column on the `jobs` table.
   * Resolved from the craftsman's auth user ID via the `providers` table
   * during offer acceptance (or other job-creation flows).
   */
  providerId?: string
  /**
   * Supabase user_id of the craftsman who owns this job.
   * Populated at job creation time from the originating inquiry conversation.
   * Used to increment `completedJobsCount` on the craftsman profile when a job
   * is successfully completed via payment release.
   */
  craftsmanUserId?: string
  /**
   * Supabase user_id of the customer who originated this job.
   * Set at job creation time when a builder-origin project is converted via
   * `convertInquiryToProjectWorkflow` and a source project with
   * `customerUserId` is available.  Used as the canonical customer owner link
   * for RLS policies on jobs, payments, disputes, and job_feedback.
   * Absent for legacy jobs or inquiry-only jobs without a builder project.
   */
  customerUserId?: string
  /**
   * Structured request context captured at intake time.
   * Present on jobs created via inquiry conversion; absent on legacy/direct jobs.
   */
  intakeContext?: IntakeContext
  /**
   * Optional timing note written by the craftsman during proposal preparation.
   * Describes availability window, expected duration, or scheduling constraints
   * relevant to the proposal. Set via `prepareProposalDraftWorkflow`.
   */
  proposalTimingNote?: string
  /**
   * Unix timestamp (ms) of when a formal proposal/offer was sent to the customer.
   * Absent when no proposal has been submitted yet.
   * Set by `submitProposalWorkflow`.
   */
  proposalSentAt?: number
  /**
   * Unix timestamp (ms) of when the customer explicitly accepted the proposal.
   * Absent until the customer confirms acceptance.
   * Set by `acceptProposalWorkflow`.
   */
  proposalAcceptedAt?: number
  /**
   * Unix timestamp (ms) of when the craftsman marked the work as complete.
   *
   * @deprecated Co-existence alias for `workConfirmedCompleteAt`. Set by
   * `confirmJobCompletionWorkflow` (admin path) or by the solo-owner branch
   * of `markWorkCompleteWorkflow`. New consumers should read
   * `workConfirmedCompleteAt`. The cleanup block removes this field once all
   * consumers are migrated.
   */
  workCompletedAt?: number
  /**
   * Unix timestamp (ms) of when a worker (or the owner in solo mode) reported
   * the job as finished. The job stays in `in_progress`; no acceptance is
   * opened and no tranche becomes eligible until the owner confirms.
   * Set by `markWorkCompleteWorkflow`.
   */
  workMarkedCompleteAt?: number
  /**
   * Unix timestamp (ms) of when the owner confirmed the worker's
   * completion report. Triggers acceptance, tranche eligibility, the
   * status transition to `waiting_payment`, and the customer push.
   * Set by `confirmJobCompletionWorkflow`.
   */
  workConfirmedCompleteAt?: number
  /**
   * Unix timestamp (ms) of when the customer released the payment.
   * Absent until the customer confirms payment release.
   * Set by `customerReleasePaymentWorkflow`.
   */
  paymentReleasedAt?: number
  /**
   * Current dispute lifecycle status for this job.
   * Absent when no dispute has ever been opened.
   */
  disputeStatus?: DisputeJobStatus
  /**
   * ID of the conversation thread that originated this job.
   * Set by `convertInquiryToProjectWorkflow` for all inquiry-origin jobs.
   * Absent for direct / legacy jobs that were not created from a conversation.
   * Provides an explicit reverse link: given a job, find the originating thread.
   */
  sourceConversationId?: string
  /**
   * ID of the accepted offer/quote that created this job.
   * Set by `acceptOfferWorkflow` when a new job is created from an accepted offer.
   * Provides the reverse link job → offer for payment gating traceability.
   * The accepted quote is the contractual basis for payment readiness.
   */
  sourceOfferId?: string
  /**
   * The commercial origin of the customer↔craftsman relationship for this job.
   * Inherited from `customer_provider_relationships.commercial_origin` at job
   * creation time and stamped explicitly for auditability.
   *
   * merchant_brought  — craftsman brought this customer into SaFix (5% fee)
   * platform_acquired — SaFix acquired this customer organically (9% fee)
   *
   * Absent on legacy jobs created before this model was introduced.
   * Stripe/fee logic reads this field — never re-infers from mutable state.
   */
  commercialOrigin?: JobCommercialOrigin
  /**
   * Lifecycle state of attribution resolution for this job.
   *
   * pending   — attribution lookup failed at job-creation time; awaiting
   *             async resolution by the Attribution Finalizer worker.
   * retrying  — worker attempted but DB still unreachable; backoff in effect.
   * finalized — commercial_origin is confirmed and immutable.
   *
   * INVARIANT: payment creation (create-escrow, initiate-funding) requires
   * attributionStatus === 'finalized'. Absent on legacy jobs → treated as
   * finalized (backfilled by migration 20260410000002).
   */
  attributionStatus?: AttributionStatus

  /**
   * Commercial kind of this Job — derived from the documentType of the Offer
   * that created it (Paket 2).
   *
   * 'standard'                — Created by binding_offer acceptance.
   *                             Full payment/escrow/execution corridor active.
   * 'estimate_tracking'       — Created by estimate acceptance.
   *                             Tracking only — no payment, no escrow, no standard execution.
   * 'cost_estimate_tracking'  — Created by cost_estimate acknowledgement.
   *                             Tracking only — concrete scope acknowledged but no payment.
   * 'diagnosis'               — Created by diagnosis acceptance.
   *                             Own instant-payment path (5 % fee). No standard escrow.
   *
   * Absent on legacy jobs created before Paket 2 — treated as 'standard' for
   * backward compatibility (all pre-Paket-2 jobs were binding_offer origin).
   *
   * INVARIANT: execution entry points (requestFunding, startJob) MUST check
   * this field and refuse if jobKind does not allow the requested operation.
   * See `jobKindAllowsStandardExecution()` in commercialDocumentPolicy.
   */
  jobKind?: 'standard' | 'estimate_tracking' | 'cost_estimate_tracking' | 'diagnosis'
}

export type JobConversation = {
  jobId: string
  jobTitle: string
  customer: string
  status: JobStatus
  messages: JobMessage[]
  lastMessage: JobMessage | null
}
