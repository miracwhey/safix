export type GuidedEntryStep =
  | 'initial'
  | 'invited'
  | 'self_found'
  | 'searching_provider'
  | 'provider_selected'
  | 'project_needed'
  | 'project_created'
  | 'matching_ready'
  | 'request_ready'
  | 'completed'

export type GuidedEntryPath = 'invited' | 'self_found'

export type GuidedEntryState = {
  step: GuidedEntryStep
  path: GuidedEntryPath | null
  selectedProviderId: string | null
  projectId: string | null
}

/** Transient UI status — not persisted, only observable. */
export type GuidedEntryStatus = {
  saving: boolean
  error: string | null
}
