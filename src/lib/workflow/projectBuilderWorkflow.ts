/**
 * Project-builder workflow.
 *
 * Creates a structured Project in the projects store from a guided
 * builder input. The resulting project becomes the primary object that
 * downstream flows (inquiry, matching, scheduling, payment) attach to.
 *
 * This is distinct from the inquiry-conversion path:
 * – Builder flow:  customer defines a project first → inquiry follows
 * – Inquiry flow:  customer contacts a craftsman first → project created later
 */

import { addProject } from '../projects/projectsStore'
import { getCustomerContext } from '../customer/customerContextStore'
import { getSession } from '../session'
import { logInfo, logWarning } from '../observability'
import { supabase } from '../supabase'
import type { ProjectBuilderInput } from '../projects/projectBuilderSelectors'
import { generateProjectId } from '../projects/projectId'

/**
 * Create a new project from a completed builder input.
 *
 * - Reads customer context for the customer name.
 * - Stores the project with status 'request' and source 'builder'.
 * - Returns the new project ID so the caller can navigate to it.
 */
export async function createProjectFromBuilderWorkflow(
  input: ProjectBuilderInput
): Promise<string> {
  const ctx = getCustomerContext()
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const projectId = generateProjectId()
  const builderId = `project_builder_${uid}`

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) {
    logWarning('workflow.project_builder.session_load_failed', {
      projectId,
      builderId,
      reason: sessionError.message,
    })
  }

  const userId = sessionData?.session?.user?.id ?? getSession().user?.id ?? null
  if (!userId) {
    logWarning('workflow.project_builder.session_missing', { projectId, builderId })
    throw new Error('Keine aktive Anmeldung gefunden. Bitte melde dich erneut an.')
  }

  const customerName = ctx.displayName.trim() || 'Kunde'
  const title =
    (input.title ?? '').trim() ||
    `${input.category}-Projekt${input.location ? ` in ${input.location}` : ''}`

  await addProject({
    id: projectId,
    builderId,
    sourceJobId: '',
    title,
    customer: customerName,
    craftsman: '',
    location: input.location.trim(),
    dateLabel: 'Termin offen',
    // `price` is left empty for builder projects — it represents the actual
    // agreed price from a craftsman proposal, not the customer's budget estimate.
    price: '',
    status: 'request',
    // `deposit_required` is the conventional initial payment state for 'request'
    // status projects in the existing data model.  No payment flow is triggered
    // until a job is created and a proposal is accepted.
    paymentState: 'deposit_required',
    messageCount: 0,
    noteCount: 0,
    photoCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'builder',
    category: input.category,
    description: input.description.trim(),
    requestedBudget: input.requestedBudget?.trim(),
    requestedTiming: input.requestedTiming?.trim(),
    tradeSpecificAnswers: input.tradeSpecificAnswers,
    // Stamp the creating customer's auth UID so that RLS policies can scope
    // builder-origin project reads and writes to the customer who created them.
    customerUserId: userId,
  })

  logInfo('workflow.project_builder.project_created', {
    projectId,
    builderId,
    category: input.category,
  })

  return projectId
}
