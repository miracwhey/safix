/**
 * Guided-Entry Visibility Rules
 *
 * Decides what the Customer Home should render for the guided-entry area
 * based on **both** the persisted guided_entry_state and real backend truth
 * (projects, conversations/requests, jobs).
 *
 * Resume mode removed (Block-1 JTBD redesign): once the customer has a real
 * project, the home answer card (NUDGE / lifecycle) owns the next step, so
 * guided entry hides. Only two outcomes remain — `full` (still onboarding) or
 * `none`.
 *
 * Key rules:
 *   1. Only shown for role = customer.
 *   2. Never shown once guided entry is completed.
 *   3. If the customer already has a real project, guided entry hides (the
 *      answer card takes over).
 *   4. With no project yet, the persisted step decides the path-specific card.
 */

import type { GuidedEntryState } from './guidedEntryState'
import type { Project } from '../projects'
import type { Conversation } from '../messages'
import type { Job } from '../jobs'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the guided-entry area on Customer Home should show.
 *
 * - `full` → large card with the current step (including initial question).
 * - `none` → hide guided entry entirely.
 */
export type GuidedEntryVisibility = { mode: 'full' } | { mode: 'none' }

// ---------------------------------------------------------------------------
// Steps that imply a project already exists — owned by the answer card → hide.
// ---------------------------------------------------------------------------

const PROJECT_IMPLYING_STEPS: ReadonlySet<string> = new Set([
  'project_created',
  'matching_ready',
  'request_ready',
])

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Derive what the guided-entry area should display.
 *
 * @param entryState    Canonical `profiles.guided_entry_state` (null = no state yet)
 * @param projects      All customer projects (from projects store)
 * @param conversations All customer conversations (from messages store)
 * @param jobs          All customer jobs (from jobs store)
 */
export function deriveGuidedEntryVisibility(
  entryState: GuidedEntryState | null,
  projects: Project[],
  conversations: Conversation[],
  jobs: Job[],
): GuidedEntryVisibility {
  const step = entryState?.step ?? 'initial'

  // ── Already completed → hide ──────────────────────────────────────────
  if (step === 'completed') {
    return { mode: 'none' }
  }

  const hasProjects = projects.length > 0
  const hasConversations = conversations.length > 0
  const hasJobs = jobs.length > 0

  // ── Beyond onboarding (a project plus a conversation or job) → hide ────
  if (hasProjects && (hasConversations || hasJobs)) {
    return { mode: 'none' }
  }

  // ── Project already exists (or a project-implying step) → hide ─────────
  // The home answer card now owns this (NUDGE replaces the old "find providers"
  // resume card). Money-safe: the resume path never recorded an invite
  // relationship, and the 5 % invited funnel runs through the `full`
  // initial→invited→"Betrieb suchen" path below, which requires no project yet.
  if (hasProjects || PROJECT_IMPLYING_STEPS.has(step)) {
    return { mode: 'none' }
  }

  // ── No project yet → show the full guided-entry card ───────────────────
  //   • initial → invited-vs-self_found fork (= the 5 % / 9 % attribution gate)
  //   • mid-flow without a project → path-specific card
  return { mode: 'full' }
}
