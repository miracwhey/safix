/**
 * Presales · Workflow · createProviderPresalesProject (V1.5 · Phase B-P2)
 *
 * Creates a new `provider_presales_projects` row anchored to the caller's
 * provider-org. The workflow resolves `provider_org_id` from the JS-side
 * helper (mirrors `spatial_user_provider_org`) and writes through the
 * registered PresalesProjectRepository — Supabase in prod, in-memory in tests.
 *
 * RBAC: the workflow layer is mandatory because client paths reach this
 * function BEFORE RLS (CLAUDE.md architecture rule). A caller without a
 * provider-org membership is rejected here even though the INSERT RLS would
 * also block — keeps the failure path explicit and uniform.
 *
 * Result-typed (no throws) so UI can branch without try/catch noise.
 */

import { resolveProviderOrg } from '../../spatial/canonical/workflow/resolveProviderOrg'
import { getSession } from '../../session'
import { logError } from '../../observability'
import { getPresalesProjectRepository } from '../repository/registry'
import type { PresalesProject } from '../../../domain/presales/presalesProjectTypes'

export interface CreateProviderPresalesProjectInput {
  /** Optional friendly title. Defaults to `Aufmaß <YYYY-MM-DD>`. */
  title?: string
  /** Optional free-text site hint (e.g. "Bad EG bei Schmidt"). */
  locationHint?: string
  /** Optional draft customer name (free text, no account yet). */
  customerNameDraft?: string
  customerEmailDraft?: string
  customerPhoneDraft?: string
  notes?: string
}

export type CreateProviderPresalesProjectResult =
  | { ok: true; project: PresalesProject }
  | { ok: false; reason: CreateProviderPresalesProjectFailure; message: string }

export type CreateProviderPresalesProjectFailure =
  | 'not_authenticated'
  | 'not_provider_member'
  | 'org_resolve_failed'
  | 'repository_error'

/**
 * Default title applied when the caller creates a Pre-Sales project without
 * supplying one (F-15). Same-day captures used to collapse onto the same
 * `Aufmaß YYYY-MM-DD` string; this variant appends a German-formatted date +
 * `HH:mm` time so three scans in one afternoon stay disambiguated. The room
 * category is not known at create-time (the scan produces it), so the title
 * stays category-free — Option A from the L2-B spec.
 */
export function defaultTitle(now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat('de-DE', {
    day: 'numeric',
    month: 'long',
  }).format(now)
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `Aufmaß · ${date} · ${hh}:${mm}`
}

export async function createProviderPresalesProject(
  input: CreateProviderPresalesProjectInput = {},
): Promise<CreateProviderPresalesProjectResult> {
  const session = getSession()
  const uid = session.user?.id ?? null
  if (!uid) {
    return {
      ok: false,
      reason: 'not_authenticated',
      message: 'Anmeldung erforderlich.',
    }
  }

  const orgResolve = await resolveProviderOrg()
  if (orgResolve.failed) {
    return {
      ok: false,
      reason: 'org_resolve_failed',
      message: 'Konnte Betrieb nicht laden — bitte erneut versuchen.',
    }
  }
  if (!orgResolve.orgId) {
    return {
      ok: false,
      reason: 'not_provider_member',
      message: 'Aufmaß ist nur für Handwerker-Betriebe verfügbar.',
    }
  }

  const repo = getPresalesProjectRepository()
  try {
    const project = await repo.create({
      providerOrgId: orgResolve.orgId,
      createdByUserId: uid,
      title: input.title?.trim() || defaultTitle(),
      locationHint: input.locationHint?.trim() || null,
      customerNameDraft: input.customerNameDraft?.trim() || null,
      customerEmailDraft: input.customerEmailDraft?.trim() || null,
      customerPhoneDraft: input.customerPhoneDraft?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    return { ok: true, project }
  } catch (err) {
    logError('presales.createProject_failed', err, { uid, orgId: orgResolve.orgId })
    return {
      ok: false,
      reason: 'repository_error',
      message: 'Aufmaß konnte nicht angelegt werden.',
    }
  }
}
