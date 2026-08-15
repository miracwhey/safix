/**
 * Owner-Notes Workflow · Block FU.5
 *
 * RBAC: assertOwnerRole — prüft Rolle + craftsmanRole=owner.
 * Job-level Isolation (welche Jobs der Owner sehen/schreiben darf) wird
 * durch RLS (owner_notes_owner_all via providers.profile_id = auth.uid())
 * erzwungen. `assertJobProviderOwner` wäre zu eng: es prüft
 * job.craftsmanUserId, das bei Legacy-Jobs undefined ist → würde alle
 * Legacy-Job-Notizen blocken.
 * Defense-in-depth: Workflow-Rolle-Check → RLS-Provider-Scope-Check.
 */

import type { Job } from '../jobs/types'
import type { SessionState } from '../session'
import { assertOwnerRole } from '../auth/rbacGuards'
import {
  SupabaseOwnerNoteRepository,
  type OwnerNoteRepository,
} from './repository/OwnerNoteRepository'
import type { OwnerNote } from './types'

export interface AddOwnerNoteWorkflowInput {
  job: Job
  body: string
  metadata?: Record<string, unknown>
}

export interface UpdateOwnerNoteWorkflowInput {
  job: Job
  note: OwnerNote
  body: string
  metadata?: Record<string, unknown>
}

export interface DeleteOwnerNoteWorkflowInput {
  job: Job
  noteId: string
}

export interface OwnerNotesWorkflowOptions {
  repository?: OwnerNoteRepository
}

export async function addOwnerNoteWorkflow(
  input: AddOwnerNoteWorkflowInput,
  session: SessionState,
  options: OwnerNotesWorkflowOptions = {},
): Promise<OwnerNote> {
  assertOwnerRole(session)
  if (!session.user?.id) {
    throw new Error('Keine aktive Sitzung — bitte erneut anmelden.')
  }
  const repo = options.repository ?? new SupabaseOwnerNoteRepository()
  return repo.add({
    jobId: input.job.id,
    authoredBy: session.user.id,
    body: input.body,
    metadata: input.metadata,
  })
}

export async function updateOwnerNoteWorkflow(
  input: UpdateOwnerNoteWorkflowInput,
  session: SessionState,
  options: OwnerNotesWorkflowOptions = {},
): Promise<OwnerNote> {
  assertOwnerRole(session)
  if (!session.user?.id) {
    throw new Error('Keine aktive Sitzung — bitte erneut anmelden.')
  }
  const repo = options.repository ?? new SupabaseOwnerNoteRepository()
  return repo.update({
    noteId: input.note.id,
    body: input.body,
    metadata: input.metadata,
  })
}

export async function deleteOwnerNoteWorkflow(
  input: DeleteOwnerNoteWorkflowInput,
  session: SessionState,
  options: OwnerNotesWorkflowOptions = {},
): Promise<void> {
  assertOwnerRole(session)
  const repo = options.repository ?? new SupabaseOwnerNoteRepository()
  return repo.delete(input.noteId)
}
