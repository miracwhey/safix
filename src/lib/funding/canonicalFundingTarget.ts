/**
 * Canonical Funding Target Resolver
 *
 * Single source of truth for resolving the customer-facing payment entry
 * from any funding entry point (funding card CTA, payment badge,
 * continue-payment CTA, next-step banner).
 *
 * Primary resolution (hydration-safe, cold-start-safe):
 *   0. Dedicated funding entry route via fundingRequestId — always works
 *      when the artifact carries its canonical fundingRequestId.
 *
 * Fallback resolution (project-based, for non-funding CTAs):
 *   1. Explicit projectId carried by the funding artifact (survives cold start)
 *   2. getJobById(jobId) → job.projectId   (job store loaded)
 *   3. getProjectByJobId(jobId)             (reverse lookup via project.sourceJobId)
 *   4. Precise error — never silent fallback to /projects
 *
 * All funding/payment navigation surfaces must use this resolver
 * instead of inline `getJobById → projectId` chains.
 */

import { getJobById } from '../jobs/service'
import { getProjectById, getProjectByJobId } from '../projects'

// ── Result types ─────────────────────────────────────────────────────────

export type FundingTargetSuccess = {
  ok: true
  projectId: string
  path: string
}

export type FundingTargetError = {
  ok: false
  code: 'NO_JOB_ID' | 'PROJECT_NOT_FOUND' | 'JOB_WITHOUT_PROJECT'
  message: string
}

export type FundingTargetResult = FundingTargetSuccess | FundingTargetError

// ── User-facing error messages ───────────────────────────────────────────

/** German user-facing messages for each resolver error code */
export const FUNDING_TARGET_ERROR_MESSAGES: Record<FundingTargetError['code'], string> = {
  NO_JOB_ID: 'Zahlungsziel konnte nicht ermittelt werden.',
  PROJECT_NOT_FOUND: 'Projekt wird geladen — bitte versuchen Sie es erneut.',
  JOB_WITHOUT_PROJECT: 'Kein verknüpftes Projekt gefunden.',
}

// ── Dedicated funding entry path ─────────────────────────────────────────

/**
 * Builds the canonical funding entry path keyed by funding truth.
 *
 * This is the primary entry mechanism for all funding/payment CTAs.
 * It does NOT depend on job/project store hydration — only on the
 * fundingRequestId that is persisted on the funding artifact at creation.
 *
 * @param fundingRequestId  The canonical funding request identifier
 * @returns                 The dedicated funding entry route path
 */
export function buildFundingEntryPath(fundingRequestId: string): string {
  return `/funding/${fundingRequestId}`
}

// ── Resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves the canonical customer-facing project and navigation path
 * for a funding entry point.
 *
 * @param jobId      The job ID from the funding artifact / funding request
 * @param projectId  Optional explicit project ID carried by the artifact
 *                   (hydration-safe — does not depend on store state)
 * @returns          Success with projectId + path, or precise error
 */
export function resolveCanonicalFundingTarget(
  jobId: string | undefined,
  projectId?: string,
): FundingTargetResult {
  // Normalize: treat empty strings as absent
  const effectiveJobId = jobId || undefined
  const effectiveProjectId = projectId || undefined

  if (!effectiveJobId && !effectiveProjectId) {
    const error: FundingTargetError = {
      ok: false,
      code: 'NO_JOB_ID',
      message: 'Kein Job-ID für die Zahlungszielauflösung vorhanden.',
    }
    console.warn('[FundingTarget] resolution failed:', error.code, error.message)
    return error
  }

  // ── Priority 0: Explicit artifact-carried projectId ─────────────────
  // Strongest signal — persisted at artifact creation time.
  // Resolves even when job/project stores are not yet hydrated.
  if (effectiveProjectId) {
    return {
      ok: true,
      projectId: effectiveProjectId,
      path: `/projects/${effectiveProjectId}?focus=payment`,
    }
  }

  // ── Priority 1: Job store → job.projectId ───────────────────────────
  const job = getJobById(effectiveJobId!)
  if (job?.projectId) {
    const project = getProjectById(job.projectId)
    if (project) {
      return {
        ok: true,
        projectId: project.id,
        path: `/projects/${project.id}?focus=payment`,
      }
    }
    // Job has a projectId but project not found in store — try reverse
  }

  // ── Priority 2: Reverse lookup via project.sourceJobId ──────────────
  const projectByJob = getProjectByJobId(effectiveJobId!)
  if (projectByJob) {
    return {
      ok: true,
      projectId: projectByJob.id,
      path: `/projects/${projectByJob.id}?focus=payment`,
    }
  }

  // ── Priority 3: Job exists but no linked project ────────────────────
  if (job) {
    const error: FundingTargetError = {
      ok: false,
      code: 'JOB_WITHOUT_PROJECT',
      message: `Job ${effectiveJobId} hat kein verknüpftes Projekt.`,
    }
    console.warn('[FundingTarget] resolution failed:', error.code, error.message)
    return error
  }

  // ── No resolution possible ──────────────────────────────────────────
  const error: FundingTargetError = {
    ok: false,
    code: 'PROJECT_NOT_FOUND',
    message: `Kein Projekt für Job ${effectiveJobId} gefunden. Job- und Projektdaten werden geladen.`,
  }
  console.warn('[FundingTarget] resolution failed:', error.code, error.message)
  return error
}
