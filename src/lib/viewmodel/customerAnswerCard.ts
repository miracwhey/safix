/**
 * Customer Answer-Card View-Model (pure)
 *
 * Builds the adaptive "Antwort-Karte" model for the customer home from the
 * canonical next-action truth — never hard-coded lifecycle copy.
 *
 * Source of truth: `deriveCustomerNextAction(...)` provides label/text/priority/
 * domain. This module only DERIVES presentation from that output plus a few
 * discriminators the next-action selector does not expose (the NUDGE pre-check
 * and the funding deep-link id). It deliberately re-uses the selector's
 * priority/domain decision instead of re-deriving lifecycle branching, so there
 * is no mirror-state to drift out of sync.
 *
 * Pure: no React, no Lucide, no persistence. The icon is returned as a semantic
 * `iconKey`; the presentational card maps it to a Lucide component. This keeps
 * the view-model unit-testable and the lib layer free of UI imports.
 */

import { deriveCustomerNextAction } from '../jobs/customerNextActionSelectors'
import type {
  NextActionPriority,
  NextActionDomain,
} from '../jobs/nextActionSelectors'
import { buildFundingEntryPath } from '../funding'
import type { CanonicalProjection } from '../shared/canonicalCustomerLifecycle'
import type { Project } from '../projects/projectTypes'
import type { Job } from '../jobs/types'
import type { JobStatus } from '../shared/coreTypes'
import type { ProjectStatus } from '../projects/projectTypes'
import type { DisputeStatus } from '../disputes/types'

// ── Types ───────────────────────────────────────────────────────────────────

/** Visual tone of the answer card. `nudge` = project without a linked job. */
export type AnswerCardTone = 'nudge' | 'loud' | 'calm' | 'done'

/**
 * Semantic icon key (domain + priority derived). The presentational card maps
 * this to a Lucide component — the raw `NextAction.icon` emoji is never used.
 */
export type AnswerCardIconKey =
  | 'nudge'
  | 'dispute'
  | 'pay'
  | 'secured'
  | 'offer'
  | 'pending'
  | 'done'

/** Navigation target. `state` carries router-state (e.g. search mode). */
export type AnswerCardRoute = {
  to: string
  state?: Record<string, unknown>
}

export type CustomerAnswerCardModel = {
  tone: AnswerCardTone
  iconKey: AnswerCardIconKey
  /** Short status word for the pill chip (e.g. "Streitfall", "In Prüfung"). */
  chip: string
  /** Headline (from NextAction.label, except NUDGE which is self-contained). */
  label: string
  /** Body answer sentence (from NextAction.text, except NUDGE). */
  text: string
  /** Project title shown top-right as context (from `project.title`). */
  projectTitle: string
  /** CTA / link label. */
  ctaLabel: string
  route: AnswerCardRoute
  /** True only when canonical funded truth exists — gates the escrow badge. */
  escrowConfirmed: boolean
  meta: { gewerk?: string; adresse?: string }
}

export type CustomerAnswerCardInput = {
  /** The selected top project (non-null). */
  project: Project
  /** Canonical projection of `project` (already resolved by the caller). */
  canonical: CanonicalProjection
  /** Linked source job, if `project.sourceJobId` resolves. */
  sourceJob: Job | undefined
  /** Dispute status — the caller MUST hydration-gate this (undefined if unsure). */
  disputeStatus: DisputeStatus | undefined
  /** Raw funding-request status for the source job. */
  fundingStatus: string | undefined
  /** Funding-request id for the source job — required for the funding deep-link. */
  fundingRequestId: string | undefined
}

// ── Pure mappers ──────────────────────────────────────────────────────────────

/**
 * Maps a canonical project status to the job status the next-action selector
 * expects. `accepted`/`request` collapse to `new` because acceptance is tracked
 * via the proposal timestamps (passed separately), not via job.status.
 */
export function mapProjectStatusToJobStatus(status: ProjectStatus): JobStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress'
    case 'review':
      return 'waiting_payment'
    case 'scheduled':
      return 'scheduled'
    case 'accepted':
    case 'request':
      return 'new'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'completed'
  }
}

/** priority → tone. Total over the priority union. */
export function answerCardToneFromPriority(
  priority: NextActionPriority,
): Exclude<AnswerCardTone, 'nudge'> {
  if (priority === 'urgent') return 'loud'
  if (priority === 'idle') return 'done'
  return 'calm'
}

/** (domain, priority) → semantic icon key. Total. NUDGE is handled upstream. */
export function answerCardIconKey(
  domain: NextActionDomain,
  priority: NextActionPriority,
): Exclude<AnswerCardIconKey, 'nudge'> {
  if (domain === 'dispute') return 'dispute'
  if (priority === 'idle') return 'done'
  if (domain === 'payment') return priority === 'urgent' ? 'pay' : 'secured'
  // domain === 'job'
  return priority === 'urgent' ? 'offer' : 'pending'
}

/** Derives the CTA label from tone + domain + the loud-state discriminators. */
export function answerCardCtaLabel(
  tone: AnswerCardTone,
  domain: NextActionDomain,
  ctx: { disputeStatus: DisputeStatus | undefined; paymentState: CanonicalProjection['paymentState'] },
): string {
  if (tone === 'nudge') return 'Handwerker finden'
  if (tone !== 'loud') return 'Zum Projekt'
  // loud — the action is the answer
  if (domain === 'dispute') {
    return ctx.disputeStatus === 'customer_waiting' ? 'Belege einreichen' : 'Streitfall ansehen'
  }
  if (domain === 'payment') {
    return ctx.paymentState === 'release_pending' ? 'Bestätigen & freigeben' : 'Auftrag bezahlen'
  }
  return 'Angebot ansehen'
}

/**
 * Short status word for the card's pill chip. Pure presentation derived from
 * the already-decided tone / iconKey / label — never a new lifecycle branch.
 * Overloaded iconKeys (dispute / pay / secured / pending span several labels)
 * are disambiguated by a keyword peek at the existing label, so the chip stays
 * truthful without re-deriving lifecycle state.
 */
export function answerCardChip(
  tone: AnswerCardTone,
  iconKey: AnswerCardIconKey,
  label: string,
): string {
  if (iconKey === 'nudge') return 'Bereit zu senden'
  if (iconKey === 'done') return 'Abgeschlossen'
  if (iconKey === 'dispute') {
    if (label.includes('Belege')) return 'Belege offen'
    return tone === 'loud' ? 'Streitfall' : 'In Prüfung'
  }
  if (iconKey === 'pay') {
    return label.includes('freigeb') || label.includes('estätig') ? 'Freigabe fällig' : 'Zahlung offen'
  }
  if (iconKey === 'secured') {
    return label.includes('abgelaufen') ? 'Abgelaufen' : 'Abgesichert'
  }
  if (iconKey === 'offer') return 'Angebot'
  // pending — calm job lifecycle (overloaded); refine by label keyword.
  if (label.includes('läuft')) return 'In Arbeit'
  if (label.includes('Termin')) return 'Terminiert'
  if (label.includes('Abnahme')) return 'Abnahme'
  if (label.includes('angenommen')) return 'Angenommen'
  if (label.includes('unklar')) return 'Prüfen'
  return 'In Prüfung'
}

/**
 * Resolves the card route. The funding deep-link (`/funding/:id`) is used ONLY
 * for the genuinely-payable deposit case: `deriveCustomerNextAction` returns
 * urgent + payment + deposit_required exclusively for a payable request
 * (funded / funding_started / terminal-dead all map to `active`), so reusing
 * that decision avoids re-deriving funding truth and never deep-links into a
 * dead request (which would 409).
 */
function resolveAnswerCardRoute(args: {
  projectId: string
  domain: NextActionDomain
  priority: NextActionPriority
  paymentState: CanonicalProjection['paymentState']
  fundingRequestId: string | undefined
}): AnswerCardRoute {
  const { projectId, domain, priority, paymentState, fundingRequestId } = args
  if (
    domain === 'payment' &&
    priority === 'urgent' &&
    paymentState === 'deposit_required' &&
    fundingRequestId
  ) {
    return { to: buildFundingEntryPath(fundingRequestId) }
  }
  return { to: `/projects/${projectId}` }
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildCustomerAnswerCardModel(
  input: CustomerAnswerCardInput,
): CustomerAnswerCardModel {
  const { project, canonical, sourceJob, disputeStatus, fundingStatus, fundingRequestId } = input

  const meta = {
    gewerk: project.category?.trim() || undefined,
    adresse: project.location?.trim() || undefined,
  }
  const projectTitle = project.title?.trim() || project.category?.trim() || 'Dein Projekt'

  // NUDGE — project exists but no job is linked yet. Never claim "Anfrage in
  // Prüfung" (would be a lie); the honest answer is "find a craftsman". Routed
  // through project-mode search (9 % platform_acquired) — NEVER provider-mode,
  // which is the 5 % invited funnel.
  if (!project.sourceJobId) {
    return {
      tone: 'nudge',
      iconKey: 'nudge',
      chip: 'Bereit zu senden',
      label: 'Finde Handwerker für dein Projekt',
      text: 'Dein Projekt steht. Finde jetzt den passenden Handwerker, der es umsetzt.',
      projectTitle,
      ctaLabel: 'Handwerker finden',
      route: { to: '/search', state: { mode: 'project', projectId: project.id } },
      escrowConfirmed: false,
      meta,
    }
  }

  const action = deriveCustomerNextAction(
    mapProjectStatusToJobStatus(canonical.status),
    canonical.paymentState,
    disputeStatus,
    sourceJob?.proposalSentAt,
    sourceJob?.proposalAcceptedAt,
    fundingStatus,
  )

  const tone = answerCardToneFromPriority(action.priority)

  const iconKey = answerCardIconKey(action.domain, action.priority)

  return {
    tone,
    iconKey,
    chip: answerCardChip(tone, iconKey, action.label),
    label: action.label,
    text: action.text,
    projectTitle,
    ctaLabel: answerCardCtaLabel(tone, action.domain, {
      disputeStatus,
      paymentState: canonical.paymentState,
    }),
    route: resolveAnswerCardRoute({
      projectId: project.id,
      domain: action.domain,
      priority: action.priority,
      paymentState: canonical.paymentState,
      fundingRequestId,
    }),
    // "In escrow" is honest only while funds are actually held. On a terminal
    // card (released / refunded / completed → tone 'done') the money has left
    // escrow, so the badge would contradict the headline — suppress it there.
    escrowConfirmed: canonical.fundingConfirmed && tone !== 'done',
    meta,
  }
}
