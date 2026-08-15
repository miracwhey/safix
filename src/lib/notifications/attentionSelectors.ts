import type { Job } from '../jobs/types'
import type { Dispute } from '../disputes/types'
import type { PaymentState } from '../shared/coreTypes'
import { deriveIntakeReadiness } from '../jobs/intakeSelectors'
import { resolveCanonicalFundingTarget, buildFundingEntryPath } from '../funding'
import {
  getFundingRequestByJobId,
  isFundingConfirmedForJob,
  isFundingRequestTerminalDead,
  isFundingRequestRepositoryHydrated,
} from '../payments/fundingRequest'
import { isEscrowPlanRepositoryHydrated } from '../payments/escrow'
import { getPaymentForJob, isPaymentRepositoryHydrated } from '../payments/service'
import { getDisputeByJobId } from '../disputes/disputeStore'
import {
  aktenzeichenToUrlSlug,
  formatAktenzeichen,
} from '../reconciliation/aktenzeichen'
import type {
  AttentionCategory,
  AttentionItem,
  AttentionRole,
  AttentionSeverity,
  AttentionSummary,
} from './types'

// ---------------------------------------------------------------------------
// Focus anchor helper
// ---------------------------------------------------------------------------
// Allows AttentionItems that link to a generic surface (e.g. JobDetailScreen)
// to carry a focus hint so the destination can scroll/expand the relevant
// sub-section instead of leaving the user to find the action manually.
//
// Allowed focus values are enumerated centrally in focusAnchors.ts.
// Consumers must read the focus param defensively and ignore unknown values
// without crashing.
import { withFocus, type AttentionFocus } from './focusAnchors'

export type { AttentionFocus }

/**
 * Build the customer-side deep-link for an attention item.
 *
 * Customer-side surfaces are `/projects/:projectId` (Customer-Project-Detail
 * gate `requiredRole="customer"`); craftsman/admin surfaces are
 * `/craftsman/jobs/:jobId` (gated by OwnerRouteGate). Routing customer
 * viewers to the craftsman path is a hard 404 because the gate kicks them
 * back to "/" — which is the bug this helper fixes.
 *
 * Returns `undefined` when no projectId is available so that callers can
 * gracefully fall back to the existing craftsman `linkTo` rather than
 * generating a broken link.
 */
function buildCustomerProjectLink(
  projectId: string | undefined,
  focus: AttentionFocus,
): string | undefined {
  if (!projectId) return undefined
  return withFocus(`/projects/${projectId}`, focus)
}

// ---------------------------------------------------------------------------
// Derive attention items from job state
// ---------------------------------------------------------------------------

function deriveJobAttention(job: Job, nowMs: number): AttentionItem[] {
  // Payment-critical attention items must wait for payment, funding, and
  // escrow repositories to finish their initial load. Without this guard a
  // cold start emits "Zahlung ausstehend" for jobs that are
  // already funded because the funding/escrow truth has not arrived yet.
  const paymentTruthReady =
    isPaymentRepositoryHydrated() &&
    isFundingRequestRepositoryHydrated() &&
    isEscrowPlanRepositoryHydrated()

  // Resolve canonical payment state — prefer the Payment entity (canonical
  // truth) over job.paymentState (mirror) so attention items never overstate
  // stale mirror truth when canonical truth disagrees.
  const canonicalPaymentState = getPaymentForJob(job.id)?.state ?? job.paymentState

  // Disputed payment — both parties and admin.
  //
  // Routing — N13.6:
  //   - Owner: when the dispute is awaiting their statement
  //     (`provider_waiting`), deep-link to the profile-side reconciliation
  //     center entry so the user lands directly on the form. Otherwise
  //     fall back to the job-tab focus anchor.
  //   - Customer: always to the project-detail focus anchor — customers
  //     do not have a profile-side center and the job-tab embed handles
  //     their statement flow.
  if (canonicalPaymentState === 'disputed') {
    const dispute = getDisputeByJobId(job.id)
    const akz = dispute
      ? formatAktenzeichen(dispute.id, dispute.createdAt)
      : null
    const ownerCenterLink =
      akz && dispute?.status === 'provider_waiting'
        ? `/craftsman/profile/disputes/${aktenzeichenToUrlSlug(akz)}`
        : null
    return [{
      id: `attn-dispute-${job.id}`,
      jobId: job.id,
      severity: 'urgent',
      category: 'dispute',
      title: 'Streitfall aktiv',
      description: `${job.title} — Zahlung eingefroren, Klärung erforderlich.`,
      icon: '⚖️',
      roles: ['craftsman', 'customer', 'admin'],
      occurredAt: nowMs,
      linkTo: ownerCenterLink ?? withFocus(`/craftsman/jobs/${job.id}`, 'dispute'),
      customerLinkTo: buildCustomerProjectLink(job.projectId, 'dispute'),
    }]
  }

  // Release pending — only emit when the job is in the customer-facing
  // 75 % approval phase (job.status === 'waiting_payment'). During the
  // 25 % auto-release at work start the plan is 'partially_released' but
  // Payment.state stays 'work_in_progress', so this branch is naturally
  // bypassed. The waiting_payment guard is a defense-in-depth check that
  // also handles edge cases such as stale dispute-rollback transitions
  // where release_pending can occur without a pending customer action.
  if (
    paymentTruthReady &&
    canonicalPaymentState === 'release_pending' &&
    job.status === 'waiting_payment'
  ) {
    return [
      {
        id: `attn-release-${job.id}-customer`,
        jobId: job.id,
        severity: 'urgent',
        category: 'payment',
        title: 'Freigabe erforderlich',
        description: `${job.title} — Zahlung wartet auf deine Freigabe.`,
        icon: '💳',
        roles: ['customer'],
        occurredAt: nowMs,
        linkTo:
          buildCustomerProjectLink(job.projectId, 'payment') ??
          withFocus(`/craftsman/jobs/${job.id}`, 'payment'),
      },
      {
        id: `attn-release-${job.id}-craftsman`,
        jobId: job.id,
        severity: 'waiting',
        category: 'payment',
        title: 'Wartet auf Kundenfreigabe',
        description: `${job.title} — Zahlung wartet auf Kundenfreigabe.`,
        icon: '💳',
        roles: ['craftsman'],
        occurredAt: nowMs,
        linkTo: withFocus(`/craftsman/jobs/${job.id}`, 'payment'),
      },
    ]
  }

  // Deposit required — customer must pay
  if (paymentTruthReady && canonicalPaymentState === 'deposit_required') {
    // Funded truth dominates: if funding is already confirmed for this job,
    // no deposit attention should be emitted — the stale paymentState has
    // not caught up with canonical funded truth yet.
    if (isFundingConfirmedForJob(job.id)) return []

    // Primary: use dedicated funding entry route keyed by fundingRequestId
    const fundingRequest = getFundingRequestByJobId(job.id)

    // Terminal-dead funding (expired / cancelled): never nag the customer to
    // pay a request that can no longer be funded (HTTP 409). The provider must
    // send a new request; the canonical funding card surfaces the honest
    // "Zahlungsanfrage abgelaufen" state on its own.
    if (isFundingRequestTerminalDead(fundingRequest?.status)) return []

    if (fundingRequest) {
      return [{
        id: `attn-deposit-${job.id}`,
        jobId: job.id,
        severity: 'action',
        category: 'payment',
        title: 'Zahlung ausstehend',
        description: `${job.title} — Zahlung erforderlich.`,
        icon: '💳',
        roles: ['customer'],
        occurredAt: nowMs,
        linkTo: buildFundingEntryPath(fundingRequest.id),
      }]
    }

    // Fallback: resolve via project-based canonical target
    const fundingTarget = resolveCanonicalFundingTarget(job.id)
    if (!fundingTarget.ok) {
      console.warn('[AttentionSelectors] deposit_required resolver failed for job', job.id, ':', fundingTarget.code)
      return []
    }

    return [{
      id: `attn-deposit-${job.id}`,
      jobId: job.id,
      severity: 'action',
      category: 'payment',
      title: 'Zahlung ausstehend',
      description: `${job.title} — Zahlung erforderlich.`,
      icon: '💳',
      roles: ['customer'],
      occurredAt: nowMs,
      linkTo: fundingTarget.path,
    }]
  }

  // Waiting payment without release_pending yet — craftsman should monitor.
  // Dedup: when canonicalPaymentState is already 'release_pending' the
  // block above returns first, so this branch only fires during the short
  // window between job.status='waiting_payment' and the payment FSM
  // transition to 'release_pending'.
  if (job.status === 'waiting_payment') {
    return [{
      id: `attn-waitpay-${job.id}`,
      jobId: job.id,
      severity: 'action',
      category: 'payment',
      title: 'Zahlung ausstehend',
      description: `${job.title} — Leistung abgeschlossen, Zahlungsfreigabe ausstehend.`,
      icon: '💰',
      roles: ['craftsman'],
      occurredAt: nowMs,
      linkTo: withFocus(`/craftsman/jobs/${job.id}`, 'payment'),
    }]
  }

  // New job — derive attention based on proposal state and intake completeness
  if (job.status === 'new') {
    // Proposal accepted: craftsman should schedule the job
    if (job.proposalAcceptedAt) {
      return [{
        id: `attn-accepted-${job.id}`,
        jobId: job.id,
        severity: 'action',
        category: 'scheduling',
        title: 'Termin einplanen',
        description: `${job.title} — Angebot angenommen. Ausführungsfenster und Termin jetzt einplanen.`,
        icon: '📅',
        roles: ['craftsman'],
        occurredAt: job.proposalAcceptedAt,
        linkTo: withFocus(`/craftsman/jobs/${job.id}`, 'timeline'),
      }]
    }

    const intake = deriveIntakeReadiness(job)

    if (intake.readiness === 'thin') {
      return [{
        id: `attn-new-${job.id}`,
        jobId: job.id,
        severity: 'action',
        category: 'job',
        title: 'Anfrage unvollständig',
        description: `${job.title} — Wichtige Angaben fehlen: ${intake.missingFields.map((f) => f.label).join(', ')}.`,
        icon: '⚠️',
        roles: ['craftsman'],
        occurredAt: nowMs,
        linkTo: `/craftsman/jobs/${job.id}`,
      }]
    }

    if (intake.readiness === 'partial') {
      return [{
        id: `attn-new-${job.id}`,
        jobId: job.id,
        severity: 'action',
        category: 'job',
        title: 'Neue Anfrage – Details prüfen',
        description: `${job.title} — Anfrage teilweise vollständig. Noch fehlend: ${intake.missingFields.map((f) => f.label).join(', ')}.`,
        icon: '📋',
        roles: ['craftsman'],
        occurredAt: nowMs,
        linkTo: `/craftsman/jobs/${job.id}`,
      }]
    }

    // readiness === 'ready'
    return [{
      id: `attn-new-${job.id}`,
      jobId: job.id,
      severity: 'action',
      category: 'job',
      title: 'Neue Anfrage',
      description: `${job.title} — Anfrage vollständig. Termin vorschlagen.`,
      icon: '📋',
      roles: ['craftsman'],
      occurredAt: nowMs,
      linkTo: `/craftsman/jobs/${job.id}`,
    }]
  }

  return []
}

// ---------------------------------------------------------------------------
// Derive attention items from disputes
// ---------------------------------------------------------------------------

/**
 * State-aware AttentionItem for a dispute (Block N3c).
 *
 * Wording follows the "Streit · {Auftrag}" mockup contract; never mentions
 * Stripe (Stripe is the payment rail, SaFix/Operator is the adjudicator).
 *
 * Inline `primaryAction` is set only when the user can take a meaningful
 * action right now (i.e. status is `*_waiting`). For `under_review` and
 * `open` the item is read-only — no phantom button.
 *
 * The click-through `linkTo` lands on the JobDetail dispute anchor, where
 * N3b's composer renders for owners/customers and the worker hint renders
 * for assigned workers. Worker click-through therefore never dead-ends.
 */
function deriveDisputeAttention(
  dispute: Dispute,
  projectId: string | undefined,
): AttentionItem | null {
  const craftsmanLink = withFocus(`/craftsman/jobs/${dispute.jobId}`, 'dispute')
  const customerLink = buildCustomerProjectLink(projectId, 'dispute')
  // N13.6 — when the dispute is awaiting the OWNER's statement, route them
  // straight to the profile-side reconciliation center instead of the job
  // tab, so the form is the first thing they see. Customers do not have a
  // profile-side surface and stay on the project tab.
  const akz = formatAktenzeichen(dispute.id, dispute.createdAt)
  const ownerCenterLink =
    akz && dispute.status === 'provider_waiting'
      ? `/craftsman/profile/disputes/${aktenzeichenToUrlSlug(akz)}`
      : null
  const titleLine = `Streit · ${dispute.title}`

  if (dispute.status === 'customer_waiting' || dispute.status === 'provider_waiting') {
    const isCustomer = dispute.status === 'customer_waiting'
    const targetRoles: AttentionItem['roles'] = isCustomer ? ['customer'] : ['craftsman']
    // Single-role items get a directly-correct linkTo. Customer items fall
    // back to the craftsman path only if no project is wired (defensive —
    // jobs always carry a projectId, but the selector must not assume so).
    const linkTo = isCustomer
      ? customerLink ?? craftsmanLink
      : ownerCenterLink ?? craftsmanLink
    return {
      id: `attn-response-${dispute.id}`,
      jobId: dispute.jobId,
      severity: 'urgent',
      category: 'dispute',
      title: titleLine,
      description: 'SaFix wartet auf deine Stellungnahme.',
      icon: '⚖️',
      roles: targetRoles,
      occurredAt: Date.parse(dispute.updatedAt),
      linkTo,
      primaryAction: {
        label: 'Stellungnahme senden',
        to: linkTo,
      },
    }
  }

  if (dispute.status === 'under_review') {
    return {
      id: `attn-review-${dispute.id}`,
      jobId: dispute.jobId,
      severity: 'waiting',
      category: 'dispute',
      title: titleLine,
      description: 'SaFix prüft den Fall.',
      icon: '⚖️',
      roles: ['craftsman', 'customer', 'admin'],
      occurredAt: Date.parse(dispute.updatedAt),
      linkTo: craftsmanLink,
      customerLinkTo: customerLink,
    }
  }

  if (dispute.status === 'open') {
    return {
      id: `attn-open-${dispute.id}`,
      jobId: dispute.jobId,
      severity: 'action',
      category: 'dispute',
      title: titleLine,
      description: 'Streitfall offen — Beweise einreichbar.',
      icon: '⚖️',
      roles: ['craftsman', 'customer', 'admin'],
      occurredAt: Date.parse(dispute.updatedAt),
      linkTo: craftsmanLink,
      customerLinkTo: customerLink,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Payment helpers
// ---------------------------------------------------------------------------

function isDisputedPayment(state: PaymentState): boolean {
  return state === 'disputed'
}

// ---------------------------------------------------------------------------
// Severity sorting
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  urgent: 0,
  action: 1,
  waiting: 2,
  info: 3,
}

function sortBySeverity(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (severityDiff !== 0) return severityDiff
    return b.occurredAt - a.occurredAt
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives a consolidated list of attention items from jobs and disputes.
 * Each item carries role annotations so consumers can filter by perspective.
 *
 * @param nowMs - Current timestamp in milliseconds. Defaults to `Date.now()`.
 *   Pass a fixed value in tests to keep the function deterministic.
 */
export function deriveAttentionItems(
  jobs: Job[],
  disputes: Dispute[],
  nowMs = Date.now()
): AttentionItem[] {
  const items: AttentionItem[] = []

  // Track dispute job IDs to avoid duplication with job-level attention
  const disputeJobIds = new Set(disputes.map((d) => d.jobId))

  // Build a job lookup so the dispute selector can resolve `projectId` for
  // customer-side routing without reaching into repositories. Disputes
  // referencing a job that is not in the input set get an undefined
  // projectId — the selector falls back to the craftsman path defensively.
  const jobsByJobId = new Map(jobs.map((j) => [j.id, j]))

  for (const dispute of disputes) {
    const job = jobsByJobId.get(dispute.jobId)
    const item = deriveDisputeAttention(dispute, job?.projectId)
    if (item) items.push(item)
  }

  for (const job of jobs) {
    // Skip jobs that already have active dispute attention
    // Block 4: use canonical payment truth to avoid stale mirror mismatch
    const jobCanonicalPayment = getPaymentForJob(job.id)?.state ?? job.paymentState
    if (disputeJobIds.has(job.id) && isDisputedPayment(jobCanonicalPayment)) {
      continue
    }
    const derived = deriveJobAttention(job, nowMs)
    for (const item of derived) items.push(item)
  }

  return sortBySeverity(items)
}

/**
 * Filters attention items to only those relevant to the given role.
 */
export function getAttentionItemsForRole(
  items: AttentionItem[],
  role: AttentionRole
): AttentionItem[] {
  return items.filter((item) => item.roles.includes(role))
}

/**
 * Filters attention items to a specific category.
 */
export function getAttentionItemsByCategory(
  items: AttentionItem[],
  category: AttentionCategory
): AttentionItem[] {
  return items.filter((item) => item.category === category)
}

/**
 * Builds a summary of the current attention state for a role.
 */
export function buildAttentionSummary(
  items: AttentionItem[],
  role: AttentionRole
): AttentionSummary {
  const filtered = getAttentionItemsForRole(items, role)

  return {
    urgentCount: filtered.filter((i) => i.severity === 'urgent').length,
    actionCount: filtered.filter((i) => i.severity === 'action').length,
    waitingCount: filtered.filter((i) => i.severity === 'waiting').length,
    totalCount: filtered.length,
    items: filtered,
  }
}
