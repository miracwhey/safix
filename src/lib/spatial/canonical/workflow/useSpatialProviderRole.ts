/**
 * Spatial · Canonical · Workflow · useSpatialProviderRole (Phase B · B-3)
 *
 * React hook that resolves the current user's {@link SpatialTeamRole} inside
 * the Provider Spatial Hub and returns the matching {@link SpatialProviderPermissions}.
 *
 * ## V1 role derivation (session-based)
 * The hook reads the live SaFix session via {@link useSession} and projects it:
 *   - `role === 'craftsman'` + `craftsmanRole === 'owner'` → `'owner'`
 *   - `role === 'craftsman'` + `craftsmanRole === 'worker'` → `'worker'`
 *   - `role === 'craftsman'` + anything else → `'owner'` (fallback; owner is the
 *     default craftsman account, worker is an explicit sub-role)
 *   - anything else (customer, operator, signed-out) → `'read_only'`
 *
 * ## Phase-C seam
 * The DB RPC `spatial_user_team_role(p_scene_id uuid) → text` is the
 * authoritative multi-tenant source of truth for team role.  It reads the
 * `provider_team_members` table keyed on `auth.uid()` and `provider_org_id`.
 * In Phase C, replace the session projection below with a `useEffect` that
 * calls the RPC once per scene mount and caches the result.  The hook signature
 * and return type are stable — no consumer changes required.
 */

import { useMemo } from 'react'

import { useSession } from '../../../../hooks/useSession'
import {
  resolveSpatialActionPermissions,
  type SpatialProviderPermissions,
  type SpatialTeamRole,
} from './spatialProviderPermissions'

export interface SpatialProviderRoleResult {
  /** The resolved team role for the current user. */
  role: SpatialTeamRole
  /** The full action-permission set derived from `role`. */
  permissions: SpatialProviderPermissions
}

/**
 * Resolve the current user's Provider-Hub team role and action permissions.
 *
 * Re-renders only when the session's `role` or `craftsmanRole` changes — not
 * on every unrelated session update (e.g. token refresh).
 */
export function useSpatialProviderRole(): SpatialProviderRoleResult {
  const { role, craftsmanRole } = useSession()

  const teamRole = useMemo<SpatialTeamRole>(() => {
    if (role !== 'craftsman') return 'read_only'
    if (craftsmanRole === 'worker') return 'worker'
    // 'owner' is the default craftsman sub-role when craftsmanRole is null or
    // unrecognised — the original account holder is always the foreman.
    return 'owner'
  }, [role, craftsmanRole])

  const permissions = useMemo(
    () => resolveSpatialActionPermissions(teamRole),
    [teamRole],
  )

  return useMemo(() => ({ role: teamRole, permissions }), [teamRole, permissions])
}
