/**
 * Spatial Core · Block E3 · Section-Cut shared types
 *
 * Pulled into its own file so `SectionCutController.tsx` can stay a
 * pure-component export and the constant + type don't break Vite's
 * fast-refresh `only-export-components` rule.
 */

export type SectionAxis = 'x' | 'y' | 'z'

export interface SectionCutState {
  enabled: boolean
  axis: SectionAxis
  /** Height in meters along the axis. */
  height: number
  /** Flip the half that gets clipped — the "look inside from the other side" toggle. */
  flipped: boolean
}

export const DEFAULT_SECTION_CUT_STATE: SectionCutState = {
  enabled: false,
  axis: 'z',
  height: 1.2,
  flipped: false,
}
