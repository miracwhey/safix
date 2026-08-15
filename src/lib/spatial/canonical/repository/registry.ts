/**
 * Spatial · Canonical · Repository · Registry
 *
 * Source switch for the active {@link SpatialSceneRepository} implementation.
 * Mirrors the existing SaFix pattern (`VITE_DATA_SOURCE` env var · `in-memory`
 * | `supabase`) — keeps tests pinned to InMemory while production code reads
 * the env var.
 *
 * IMPORTANT: the registry holds at most one instance per implementation kind
 * for the lifetime of the module. Tests that need a fresh InMemory store
 * should construct their own (`new InMemorySpatialSceneRepository()`) rather
 * than re-using the singleton.
 */

import { InMemorySpatialSceneRepository } from './InMemorySpatialSceneRepository.ts'
import { SupabaseSpatialSceneRepository } from './SupabaseSpatialSceneRepository.ts'
import type { SpatialSceneRepository } from './SpatialSceneRepository.ts'

export type SpatialDataSource = 'in-memory' | 'supabase'

let _instance: SpatialSceneRepository | null = null
let _kind: SpatialDataSource | null = null

/**
 * Resolve the data-source kind. Reads `VITE_DATA_SOURCE` when defined,
 * otherwise defaults to `in-memory` so tests + first-run dev environments
 * boot without a Supabase round-trip.
 */
export function resolveSpatialDataSource(): SpatialDataSource {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  const raw = env?.VITE_DATA_SOURCE
  return raw === 'supabase' ? 'supabase' : 'in-memory'
}

/**
 * Return the singleton repository for the current source. Subsequent calls
 * return the same instance; switch sources by passing an explicit
 * `kindOverride` (typically only in tests).
 */
export function getSpatialSceneRepository(
  kindOverride?: SpatialDataSource,
): SpatialSceneRepository {
  const kind = kindOverride ?? resolveSpatialDataSource()
  if (_instance && _kind === kind) return _instance
  _instance = kind === 'supabase'
    ? new SupabaseSpatialSceneRepository()
    : new InMemorySpatialSceneRepository()
  _kind = kind
  return _instance
}

/** Reset the singleton — useful in test `beforeEach` blocks. */
export function resetSpatialSceneRepository(): void {
  _instance = null
  _kind = null
}
