/**
 * Spatial · Workflow · Edit-Permissions RBAC Guard (Phase 2 · Block 2.10)
 *
 * The workflow-layer RBAC guard for the spatial edit-system.
 *
 * Why this layer (binding · SaFix architecture rule):
 *   "Workflow-layer RBAC guards mandatory — client workflows are reachable
 *   before RLS; guards belong in the workflow layer, not only in RLS
 *   policies." The edit-mode viewer constructs `EditCommand`s in the browser
 *   and writes overrides into the canonical scene store BEFORE anything
 *   reaches Supabase. A malicious caller could construct a command with a
 *   foreign `variant_id` from the JS console. This guard is the third defense
 *   layer (alongside the route gates and RLS): every command-apply path in
 *   edit-mode is forced through {@link resolveWritableVariantId} so a command
 *   can only ever target the role-correct variant.
 *
 * Layer: PURE workflow logic — no React, no zustand, no three.js. The guard
 * functions are deterministic over `(user, scene)`. A thin React hook
 * ({@link useSpatialEditPermissions}) wraps them for the UI; the hook adds no
 * policy of its own.
 *
 * Role → writable-variant mapping (Master-Spec §6 · Edit-Spec §1.2):
 *
 *   | role / sub-role     | writable variant                       |
 *   |---------------------|-----------------------------------------|
 *   | customer            | `customer_corrections`                  |
 *   | craftsman (provider)| `provider_{userId}_annotations` (OWN)    |
 *   | operator            | `operator_review`                       |
 *   | (anyone)            | `base_roomplan`        → READ-ONLY       |
 *   | (anyone)            | `job_{jobId}_final`    → READ-ONLY       |
 *
 * Spy-prevention (CD-7): a provider's writable variant is keyed to THEIR OWN
 * user id. {@link canWriteVariant} refuses `provider_X_annotations` for any
 * provider whose `user.id !== X`, so provider A can never write into provider
 * B's annotation layer — even if A can SEE B's layer in the variant switcher.
 */

import type { SessionState } from '../../session'
import { getSession } from '../../session'
import type { VariantId } from '../canonical/types/variants'
import {
  STANDARD_VARIANTS,
  providerAnnotationsVariantId,
  PROVIDER_ANNOTATIONS_PREFIX,
  PROVIDER_ANNOTATIONS_SUFFIX,
  JOB_FINAL_PREFIX,
  JOB_FINAL_SUFFIX,
} from '../canonical/types/variants'

// ─────────────────────────────────────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────────────────────────────────────

/** Stable reason codes for an edit-permission denial. */
export type SpatialEditPermissionCode =
  /** No validated user — the caller is not signed in. */
  | 'no_user'
  /** The user's role does not map to any writable variant. */
  | 'no_writable_variant'
  /** The target variant is immutable (`base_roomplan` / `job_*_final`). */
  | 'variant_read_only'
  /** A provider tried to write a DIFFERENT provider's annotation layer. */
  | 'provider_spy'
  /** The target variant is owned by a different role than the caller. */
  | 'variant_role_mismatch'

/**
 * Thrown by {@link assertCanWriteVariant}. The {@link code} lets callers /
 * tests branch deterministically; `message` carries a short German line the
 * UI may surface directly.
 */
export class SpatialEditPermissionError extends Error {
  readonly code: SpatialEditPermissionCode
  constructor(code: SpatialEditPermissionCode, message?: string) {
    super(message ?? code)
    this.name = 'SpatialEditPermissionError'
    this.code = code
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Caller identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal identity an edit-permission decision needs. A structural subset
 * of {@link SessionState} so the guard never depends on the full session
 * shape — production passes the live `getSession()` result, tests pass a
 * literal.
 */
export interface SpatialEditUser {
  /** auth.users.id of the caller, or `null` when not signed in. */
  userId: string | null
  /** Top-level role (`customer` / `craftsman`), or `null`. */
  role: SessionState['role']
  /** True when the caller is a SaFix operator (overrides `role`). */
  isOperator: boolean
}

/**
 * Project a {@link SessionState} onto the {@link SpatialEditUser} the guard
 * consumes. Defaults to the live session — call with no argument in
 * production, pass an explicit snapshot in tests.
 */
export function toSpatialEditUser(session?: SessionState): SpatialEditUser {
  const s = session ?? getSession()
  return {
    userId: s.user?.id ?? null,
    role: s.role,
    isOperator: s.isOperator,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene shape the guard needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal scene context an edit-permission decision needs: the list of
 * variant ids present on the scene. Structural subset of the canonical scene
 * store — the store's `variants` array (`Variant[]`) satisfies it once mapped
 * to ids, and tests can pass a bare `{ variantIds }`.
 */
export interface SpatialEditScene {
  /** Every variant id available on the scene. */
  variantIds: ReadonlyArray<VariantId>
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant classification (pure — no user)
// ─────────────────────────────────────────────────────────────────────────────

/** `true` when `id` is a `provider_{X}_annotations` variant. */
export function isProviderAnnotationsVariant(id: VariantId): boolean {
  return (
    id.startsWith(PROVIDER_ANNOTATIONS_PREFIX) &&
    id.endsWith(PROVIDER_ANNOTATIONS_SUFFIX) &&
    // there must be a non-empty user-id segment between prefix and suffix
    id.length > PROVIDER_ANNOTATIONS_PREFIX.length + PROVIDER_ANNOTATIONS_SUFFIX.length
  )
}

/** `true` when `id` is a sealed `job_{Y}_final` variant. */
export function isJobFinalVariant(id: VariantId): boolean {
  return (
    id.startsWith(JOB_FINAL_PREFIX) &&
    id.endsWith(JOB_FINAL_SUFFIX) &&
    id.length > JOB_FINAL_PREFIX.length + JOB_FINAL_SUFFIX.length
  )
}

/**
 * Extract the owning provider user-id from a `provider_{X}_annotations`
 * variant id, or `null` when `id` is not a provider-annotations variant.
 */
export function providerUserIdOfVariant(id: VariantId): string | null {
  if (!isProviderAnnotationsVariant(id)) return null
  return id.slice(
    PROVIDER_ANNOTATIONS_PREFIX.length,
    id.length - PROVIDER_ANNOTATIONS_SUFFIX.length,
  )
}

/**
 * `true` when NOBODY may write `id` regardless of role — the two immutable
 * layers: the system-owned `base_roomplan` scan and any sealed `job_*_final`.
 */
export function isImmutableVariant(id: VariantId): boolean {
  return id === STANDARD_VARIANTS.BASE_ROOMPLAN || isJobFinalVariant(id)
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONE variant id this user is allowed to write on this scene, or `null`
 * when the user has no writable layer (not signed in, or a role with no
 * edit rights).
 *
 * Mapping:
 *   - operator                → `operator_review`
 *   - customer                → `customer_corrections`
 *   - craftsman (provider)    → `provider_{user.id}_annotations`
 *   - anything else           → `null`
 *
 * The operator check is FIRST: an operator account always edits the review
 * layer even if its `role` also reads `customer` / `craftsman`.
 *
 * This is the single source of truth for command-targeting — the edit-mode
 * host builds every command with the id returned here, NEVER with the merely
 * active variant id (a user may VIEW a read-only variant but edits always
 * land on their own writable layer · Block 2.11).
 */
export function resolveWritableVariantId(user: SpatialEditUser): VariantId | null {
  if (!user.userId) return null
  if (user.isOperator) return STANDARD_VARIANTS.OPERATOR_REVIEW
  if (user.role === 'customer') return STANDARD_VARIANTS.CUSTOMER_CORRECTIONS
  if (user.role === 'craftsman') return providerAnnotationsVariantId(user.userId)
  return null
}

/**
 * `true` when `user` may write into `variantId`.
 *
 * A write is allowed IFF `variantId` is exactly the user's
 * {@link resolveWritableVariantId}. This single equality enforces every rule
 * at once:
 *   - immutable variants (`base_roomplan` / `job_*_final`) are never any
 *     user's writable variant ⇒ rejected,
 *   - a customer cannot write `operator_review` or a provider layer ⇒ the
 *     ids differ,
 *   - SPY-PREVENTION: provider A's writable id is `provider_A_annotations`;
 *     `provider_B_annotations !== provider_A_annotations` ⇒ rejected.
 *
 * `scene` is accepted for API symmetry + future scene-scoped policy (e.g.
 * dispute-lock); V1 does not branch on it.
 */
export function canWriteVariant(
  user: SpatialEditUser,
  _scene: SpatialEditScene,
  variantId: VariantId,
): boolean {
  const writable = resolveWritableVariantId(user)
  if (writable === null) return false
  return writable === variantId
}

/**
 * Assert `user` may write `variantId`, throwing a {@link SpatialEditPermissionError}
 * with a precise {@link SpatialEditPermissionCode} otherwise. Use this on every
 * command-apply path that accepts a caller-supplied variant id — it fails fast
 * with a branchable reason instead of letting an illegal write slip to RLS.
 */
export function assertCanWriteVariant(
  user: SpatialEditUser,
  _scene: SpatialEditScene,
  variantId: VariantId,
): void {
  if (!user.userId) {
    throw new SpatialEditPermissionError('no_user', 'Nicht angemeldet.')
  }
  if (isImmutableVariant(variantId)) {
    throw new SpatialEditPermissionError(
      'variant_read_only',
      'Diese Ebene ist schreibgeschützt.',
    )
  }
  const writable = resolveWritableVariantId(user)
  if (writable === null) {
    throw new SpatialEditPermissionError(
      'no_writable_variant',
      'Deine Rolle darf dieses Aufmaß nicht bearbeiten.',
    )
  }
  if (writable === variantId) return

  // The target is a provider layer that is not the caller's — spy attempt.
  const ownerOfTarget = providerUserIdOfVariant(variantId)
  if (ownerOfTarget !== null && ownerOfTarget !== user.userId) {
    throw new SpatialEditPermissionError(
      'provider_spy',
      'Du kannst nicht in die Anmerkungen eines anderen Handwerkers schreiben.',
    )
  }
  // Same role-family but wrong layer (e.g. customer → operator_review).
  throw new SpatialEditPermissionError(
    'variant_role_mismatch',
    'Diese Ebene gehört einer anderen Rolle.',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-variant view classification (for the VariantSwitcher UI)
// ─────────────────────────────────────────────────────────────────────────────

/** How the VariantSwitcher should present one variant to the current user. */
export type VariantAccess =
  /** The user's own writable layer — edits land here. */
  | 'writable'
  /** Visible but read-only for this user (base / job-final / foreign layer). */
  | 'read_only'

/**
 * Classify a single variant for the current user. Drives the VariantSwitcher's
 * pencil-vs-eye affordance: `writable` ⇒ pencil, `read_only` ⇒ eye.
 */
export function classifyVariantAccess(
  user: SpatialEditUser,
  scene: SpatialEditScene,
  variantId: VariantId,
): VariantAccess {
  return canWriteVariant(user, scene, variantId) ? 'writable' : 'read_only'
}
