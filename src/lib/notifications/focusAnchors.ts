/**
 * Single source of truth for AttentionFocus values + their target section
 * IDs on JobDetail / ProjectDetail surfaces.
 *
 * Producers (attentionSelectors, AssignmentIntegrityWarningBanner …) build
 * `?focus=…` deep-links via {@link withFocus}; consumers
 * (CraftsmanJobDetailScreen, CustomerProjectDetailScreen) parse the param
 * via {@link isAttentionFocus} and look up the scroll target via
 * {@link FOCUS_SECTION_IDS}.
 *
 * Block 7.2 Phase 3 extraction:
 * - `correction` was dropped from the whitelist — corrections live in their
 *   own surfaces (Worker/Craftsman-Korrekturen-Screens), never as a JobDetail
 *   section. Removing it keeps the contract honest: every focus value maps
 *   to a real section id.
 * - `assignment` was added so AssignmentIntegrityWarningBanner can deep-link
 *   to JobDetail's team section (Phase 2 L2).
 *
 * Consumers must still guard defensively — `isAttentionFocus` filters
 * unknown strings, `getElementById` safely returns null when the section
 * is conditionally hidden, and the scroll handler treats a missing element
 * as a silent no-op.
 */

export type AttentionFocus =
  | 'payment'
  | 'dispute'
  | 'documents'
  | 'timeline'
  | 'offer'
  | 'assignment'

export const FOCUS_SECTION_IDS: Record<AttentionFocus, string> = {
  payment: 'job-section-payment',
  dispute: 'job-section-dispute',
  documents: 'job-section-documents',
  timeline: 'job-section-timeline',
  offer: 'job-section-offer',
  assignment: 'job-section-assignment',
}

const FOCUS_VALUES = new Set<string>(Object.keys(FOCUS_SECTION_IDS))

export function withFocus(path: string, focus: AttentionFocus): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}focus=${focus}`
}

export function isAttentionFocus(
  value: string | null | undefined,
): value is AttentionFocus {
  return typeof value === 'string' && FOCUS_VALUES.has(value)
}

export function resolveSectionId(focus: string | null | undefined): string | null {
  if (!isAttentionFocus(focus)) return null
  return FOCUS_SECTION_IDS[focus]
}
