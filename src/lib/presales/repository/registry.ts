/**
 * Presales · Repository · Registry
 *
 * Mirrors the canonical SpatialSceneRepository registry pattern. Source switch
 * via `VITE_DATA_SOURCE` (`in-memory` | `supabase`). Singleton per kind.
 */

import { supabase } from '../../supabase'
import { InMemoryPresalesProjectRepository } from './InMemoryPresalesProjectRepository'
import { SupabasePresalesProjectRepository } from './SupabasePresalesProjectRepository'
import type { PresalesProjectRepository } from './PresalesProjectRepository'

export type PresalesDataSource = 'in-memory' | 'supabase'

let _instance: PresalesProjectRepository | null = null
let _kind: PresalesDataSource | null = null

export function resolvePresalesDataSource(): PresalesDataSource {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  const raw = env?.VITE_DATA_SOURCE
  return raw === 'supabase' ? 'supabase' : 'in-memory'
}

export function getPresalesProjectRepository(
  kindOverride?: PresalesDataSource,
): PresalesProjectRepository {
  const kind = kindOverride ?? resolvePresalesDataSource()
  if (_instance && _kind === kind) return _instance
  _instance =
    kind === 'supabase'
      ? new SupabasePresalesProjectRepository(supabase)
      : new InMemoryPresalesProjectRepository()
  _kind = kind
  return _instance
}

export function resetPresalesProjectRepository(): void {
  _instance = null
  _kind = null
}

/** Test-only override — inject a custom repo instance. */
export function setPresalesProjectRepository(
  repo: PresalesProjectRepository,
  kind: PresalesDataSource = 'in-memory',
): void {
  _instance = repo
  _kind = kind
}
