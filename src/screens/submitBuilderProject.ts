import type { createProjectFromBuilderWorkflow } from '../lib/workflow'
import type { ProjectBuilderInput } from '../lib/projects'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../lib/diagnostics'

type SubmitDeps = {
  createProject: typeof createProjectFromBuilderWorkflow
  navigate: (path: string, options?: { replace?: boolean }) => void
  setSubmitting: (value: boolean) => void
  setSubmitError: (value: string | null) => void
  setDebugInfo?: (value: RuntimeDiagnostic | null) => void
}

let submissionInFlight = false

/**
 * Submits a builder project and handles UI state transitions.
 *
 * - Starts loading state
 * - Clears previous error
 * - Navigates to the created project on success
 * - Resets loading and surfaces an error message on failure
 */
export async function submitBuilderProject(
  input: ProjectBuilderInput,
  deps: SubmitDeps
): Promise<string | null> {
  if (submissionInFlight) return null
  submissionInFlight = true

  deps.setSubmitting(true)
  deps.setSubmitError(null)
  deps.setDebugInfo?.(null)

  try {
    const projectId = await deps.createProject(input)
    deps.navigate(`/projects/${projectId}`, { replace: true })
    return projectId
  } catch (err) {
    const diagnostic = buildDiagnostic({
      source: 'PROJECT_CREATE',
      step: 'submit_builder',
      name: 'submitBuilderProject',
      error: err,
      details: { category: input.category, location: input.location },
      hint: 'Verify customer session and Supabase insert permissions.',
    })
    emitDiagnostic(diagnostic)
    deps.setDebugInfo?.(diagnostic)

    const message =
      err instanceof Error
        ? err.message
        : 'Projekt konnte nicht erstellt werden. Bitte versuche es erneut.'
    deps.setSubmitError(message)
    return null
  } finally {
    deps.setSubmitting(false)
    submissionInFlight = false
  }
}
