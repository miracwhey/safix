import { getFeatureFlagsRepository } from './repository/registry'
import type { FeatureFlag } from './types'

// Session-free flag primitives. Kept separate from isFlagEnabled.ts (which
// imports ../session) so module-load consumers like the chat-cutover adapter
// don't transitively pull session.ts's onAuthStateChange side-effect into
// offline tests. See [[feedback_spatial_barrel_no_session_imports]].

/** Deterministic 0..99 bucket from a flag key + a stable user id (FNV-1a). */
function bucketFor(key: string, userId: string): number {
  const s = `${key}:${userId}`
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 100
}

/**
 * Pure flag evaluation. Fail-closed: a missing or disabled flag is OFF, and a
 * staged rollout is OFF for an actor that can't be bucketed (anonymous).
 */
export function evaluateFlag(
  flag: FeatureFlag | undefined,
  actor: { userId?: string; role?: string },
): boolean {
  if (!flag || !flag.enabled) return false
  // Role targeting — empty allowlist means all roles.
  if (flag.targetRoles.length > 0) {
    if (!actor.role || !flag.targetRoles.includes(actor.role)) return false
  }
  // targetRegions is intentionally NOT evaluated: the session carries no region
  // yet, and fail-closing on it would silently disable any region-targeted flag
  // for everyone. Wire it here once a region lands on the session.
  if (flag.rolloutPct >= 100) return true
  if (flag.rolloutPct <= 0) return false
  if (!actor.userId) return false
  return bucketFor(flag.key, actor.userId) < flag.rolloutPct
}

/**
 * Raw cache read — undefined when the flag row is absent. Lets callers (e.g.
 * the chat-cutover adapter) distinguish "no remote row, use my default" from
 * "row present, remote is the source of truth (incl. an OFF kill-switch)".
 * Session-free.
 */
export function getFlag(key: string): FeatureFlag | undefined {
  try {
    return getFeatureFlagsRepository().getFlag(key)
  } catch {
    return undefined
  }
}
