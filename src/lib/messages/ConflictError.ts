/**
 * Thrown by SupabaseThreadArtifactRepository.upsert() when a CAS update
 * detects that another write updated the row concurrently (version mismatch).
 * Callers should surface this as a user-visible error and avoid silently
 * retrying without re-reading the latest state.
 */
export class ConflictError extends Error {
  readonly isConflictError = true

  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export function isConflictError(err: unknown): err is ConflictError {
  return (
    err instanceof ConflictError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { isConflictError?: unknown }).isConflictError === true)
  )
}
