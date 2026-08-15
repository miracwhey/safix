/**
 * Spatial · Canonical · Overrides · Cache (Risk R8 · audit-fix CRIT-3)
 *
 * The override resolver visits every node in the scene graph and walks an
 * inheritance chain — for V1's ~50-200-node scenes that costs a few
 * hundred microseconds per resolve. Re-running it on every frame as the
 * walk-mode camera moves would burn ~5-10 % of the 60 fps budget.
 *
 * ── Why content-based keys (not WeakMap-by-identity) ───────────────────
 * The previous implementation keyed the cache by `RoomScene` object
 * identity. That breaks under React-immutable consumers (zustand+immer,
 * structural-sharing patterns), because every commit produces a fresh
 * `RoomScene` reference — even if the content is unchanged. Cache hit-rate
 * in production would be ~0 %.
 *
 * The redesign uses a stable content-addressed key:
 *   key = JSON.stringify({
 *     sceneId, activeVariantId,
 *     overrides: sortedBy(base_node_id, variant_id, override_fields),
 *   })
 *
 * with a small LRU window (default 8 entries · matches the practical upper
 * bound of concurrent variants per scene).
 *
 * The cache instance is owned by callers (typically the zustand store) and
 * passed into {@link resolveSceneCached}. Invalidation helpers wipe keys
 * by scene-id prefix so behaviour matches the original WeakMap contract.
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type { NodeOverride, VariantId } from '../types/variants.ts'
import { resolveScene, type ResolveSceneInput } from './variant-resolve.ts'

/** Maximum entries kept per cache instance (LRU eviction order). */
export const OVERRIDE_CACHE_MAX_ENTRIES = 8

/**
 * Opaque cache type. The internal Map is keyed by content-hash so that
 * structural-sharing consumers (React, immer, zustand) still get cache
 * hits when the scene reference changes but the content is unchanged.
 */
export interface OverrideCache {
  readonly entries: Map<string, RoomScene>
  readonly maxEntries: number
}

/** Construct an empty cache instance (default LRU window = 8). */
export function createOverrideCache(
  maxEntries: number = OVERRIDE_CACHE_MAX_ENTRIES,
): OverrideCache {
  return { entries: new Map<string, RoomScene>(), maxEntries }
}

/**
 * Memoised wrapper around {@link resolveScene}. The first call for a given
 * (scene.id, activeVariantId, overrides-content) tuple computes the resolved
 * scene; subsequent calls return the cached reference until invalidation.
 *
 * Cache hits are content-equal — they will not preserve `===` if the input
 * `scene` reference changed (that is the intended trade-off: hits stay
 * stable for *equivalent* inputs, not identical ones).
 */
export function resolveSceneCached(
  input: ResolveSceneInput,
  cache: OverrideCache,
): RoomScene {
  const key = cacheKey(input.scene.id, input.activeVariantId, input.overrides)
  const existing = cache.entries.get(key)
  if (existing) {
    // Touch for LRU ordering: re-insert moves the key to the tail.
    cache.entries.delete(key)
    cache.entries.set(key, existing)
    return existing
  }
  const resolved = resolveScene(input)
  cache.entries.set(key, resolved)
  if (cache.entries.size > cache.maxEntries) {
    // Map iteration is insertion-order — first key is the oldest.
    const oldestKey = cache.entries.keys().next().value
    if (oldestKey !== undefined) cache.entries.delete(oldestKey)
  }
  return resolved
}

/**
 * Invalidate every cache entry for a single (scene, variant) pair. Use
 * this when an override on that variant changes; sibling-variant entries
 * for the same scene stay cached.
 */
export function invalidateVariant(
  cache: OverrideCache,
  scene: RoomScene,
  variantId: VariantId,
): void {
  const prefix = `${scene.id}::${variantId}::`
  for (const key of cache.entries.keys()) {
    if (key.startsWith(prefix)) cache.entries.delete(key)
  }
}

/**
 * Invalidate the entire cache for a scene. Use this when the base scene
 * itself mutates (e.g. a re-scan) — every variant entry is now stale.
 */
export function invalidateScene(cache: OverrideCache, scene: RoomScene): void {
  const prefix = `${scene.id}::`
  for (const key of cache.entries.keys()) {
    if (key.startsWith(prefix)) cache.entries.delete(key)
  }
}

/**
 * Wipe everything — escape hatch for variant-graph changes (adding /
 * removing a variant rewires inheritance arcs for every cached entry).
 *
 * Note: returns a fresh instance to match the original API contract; the
 * old reference's `entries` map is also cleared so callers that forget
 * to swap still get correct behaviour.
 */
export function clearOverrideCache(cache: OverrideCache): OverrideCache {
  cache.entries.clear()
  return createOverrideCache(cache.maxEntries)
}

// ── internal: stable content-addressed cache key ───────────────────────

function cacheKey(
  sceneId: string,
  variantId: VariantId,
  overrides: ReadonlyArray<NodeOverride>,
): string {
  const sorted = [...overrides]
    .map((o) => ({
      n: o.base_node_id,
      v: o.variant_id,
      f: stableStringify(o.override_fields),
    }))
    .sort((a, b) => {
      if (a.n !== b.n) return a.n < b.n ? -1 : 1
      if (a.v !== b.v) return a.v < b.v ? -1 : 1
      return a.f < b.f ? -1 : a.f > b.f ? 1 : 0
    })
  return `${sceneId}::${variantId}::${stableStringify(sorted)}`
}

/**
 * Deterministic JSON-stringify: sorts object keys recursively. Required
 * because `JSON.stringify` preserves insertion order, which can differ
 * between an in-memory object and one round-tripped through Supabase.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
  return `{${parts.join(',')}}`
}
