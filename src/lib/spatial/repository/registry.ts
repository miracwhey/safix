import type { SpatialRepository } from './SpatialRepository'

let _repo: SpatialRepository | null = null

export function setSpatialRepository(repo: SpatialRepository): void {
  _repo = repo
}

export function getSpatialRepository(): SpatialRepository {
  if (!_repo) {
    throw new Error(
      'SpatialRepository not initialized. Call initializeSpatialRepository() during bootstrap.',
    )
  }
  return _repo
}

/** Resets the registry — test-only. */
export function resetSpatialRepository(): void {
  _repo = null
}

/** Convenience: late-bind during bootstrapRepositories(). */
export function initializeSpatialRepository(repo: SpatialRepository): void {
  setSpatialRepository(repo)
}
