/**
 * Spatial · Canonical · Workflow · Provider Permissions (Phase B · B-3)
 *
 * Pure action-permission matrix for the Provider Spatial Hub.
 *
 * Four team roles map to the action columns in spec §2.2.  Zero React imports;
 * this module is L1-pure so it can be consumed in tests, workflows, and UI
 * without dragging in the React tree.
 *
 * Phase-C seam: V1 derives the role from the SaFix session (craftsman owner →
 * 'owner', worker → 'worker').  The DB RPC `spatial_user_team_role(p_scene_id)`
 * exists as the authoritative multi-tenant source and will replace the session
 * projection in Phase C once team-member rows are fully backfilled.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Role type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four roles a team member can hold inside a Provider Spatial Hub.
 * Maps to spec §2.1.
 *
 * | Role         | Who                                                       |
 * |--------------|-----------------------------------------------------------|
 * | owner        | Foreman / business owner — all permissions                |
 * | worker       | Field worker — field annotations + re-scan, no quoting    |
 * | office       | Admin / office staff — BoM + quoting, no field pins       |
 * | read_only    | Viewer — read access only                                 |
 */
export type SpatialTeamRole = 'owner' | 'worker' | 'office' | 'read_only'

// ─────────────────────────────────────────────────────────────────────────────
// Permission shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full per-role action matrix from spec §2.2 expressed as boolean flags.
 *
 * Every flag has a conservative default (false) so a newly-added action is
 * deny-by-default until an explicit grant is added.
 */
export interface SpatialProviderPermissions {
  /** Add / edit own annotation-pins (Notiz / Foto / Problem). */
  canAddOwnPin: boolean
  /**
   * Edit ANY team member's pin — owner override.  Workers are restricted to
   * own pins via `canAddOwnPin`; only owners additionally get this flag.
   */
  canEditAnyPin: boolean
  /** Record a measurement override against a scene element (Maß-Editor). */
  canAddMeasurementOverride: boolean
  /** Add a Material-Suggestion annotation on a surface. */
  canAddMaterialSuggestion: boolean
  /** Request a new lidar / photogrammetry re-scan for the job. */
  canTriggerRescan: boolean
  /** Edit the Bill of Materials / cost list for the job. */
  canEditBom: boolean
  /** Send a quote to the customer. */
  canSendQuote: boolean
  /** Accept or reject a customer-initiated change-order. */
  canAcceptChangeOrder: boolean
  /** Mark annotations as done → trigger the "Verify-Confirm" workflow step. */
  canVerifyConfirm: boolean
  /** Enter walk-through mode in the 3D viewer. */
  canWalk: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Action matrix
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_PERMISSIONS: SpatialProviderPermissions = {
  canAddOwnPin: true,
  canEditAnyPin: true,
  canAddMeasurementOverride: true,
  canAddMaterialSuggestion: true,
  canTriggerRescan: true,
  canEditBom: true,
  canSendQuote: true,
  canAcceptChangeOrder: true,
  canVerifyConfirm: true,
  canWalk: true,
}

const WORKER_PERMISSIONS: SpatialProviderPermissions = {
  canAddOwnPin: true,
  canEditAnyPin: false,
  canAddMeasurementOverride: true,
  canAddMaterialSuggestion: true,
  canTriggerRescan: true,
  canEditBom: false,
  canSendQuote: false,
  canAcceptChangeOrder: false,
  canVerifyConfirm: false,
  canWalk: true,
}

const OFFICE_PERMISSIONS: SpatialProviderPermissions = {
  canAddOwnPin: false,
  canEditAnyPin: false,
  canAddMeasurementOverride: false,
  canAddMaterialSuggestion: true,
  canTriggerRescan: true,
  canEditBom: true,
  canSendQuote: true,
  canAcceptChangeOrder: true,
  canVerifyConfirm: true,
  canWalk: true,
}

const READ_ONLY_PERMISSIONS: SpatialProviderPermissions = {
  canAddOwnPin: false,
  canEditAnyPin: false,
  canAddMeasurementOverride: false,
  canAddMaterialSuggestion: false,
  canTriggerRescan: false,
  canEditBom: false,
  canSendQuote: false,
  canAcceptChangeOrder: false,
  canVerifyConfirm: false,
  canWalk: true,
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the permission set for `role`.  The returned object is a frozen
 * singleton — callers must not mutate it.
 *
 * This is the single source of truth for the spec §2.2 matrix in the browser
 * workflow layer.  RLS policies are the server-side enforcement layer and must
 * mirror these flags.
 */
export function resolveSpatialActionPermissions(role: SpatialTeamRole): SpatialProviderPermissions {
  switch (role) {
    case 'owner':
      return OWNER_PERMISSIONS
    case 'worker':
      return WORKER_PERMISSIONS
    case 'office':
      return OFFICE_PERMISSIONS
    case 'read_only':
      return READ_ONLY_PERMISSIONS
  }
}
