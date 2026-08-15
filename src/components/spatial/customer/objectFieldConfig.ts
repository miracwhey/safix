/**
 * Spatial · Shared grouping for the CustomerObjectEditSheet sliders.
 *
 * Pure (no components) so {@link CustomerObjectEditSheet} can import the tab
 * grouping + the tabbed/flat rule without tripping
 * `react-refresh/only-export-components` — mirrors `dimensionFieldConfig.ts`.
 *
 * Rule: a 4-field object (Position · Breite · Höhe · Über Boden) is too tall as
 * a flat stack, so it splits into two tabs (Position | Größe). A 3-field object
 * (door, offset hidden) stays a flat stack. The 4th field is exactly
 * `offsetFromFloorCm.show`, so tabbed ⇔ offset shown ⇔ visible-field-count ≥ 4.
 */
import type {
  CustomerObjectEditSheetValue,
  ObjectSliderConfig,
} from './CustomerObjectEditSheet'

export interface ObjectFieldTab {
  key: 'place' | 'size'
  label: string
  fields: readonly (keyof CustomerObjectEditSheetValue)[]
}

export const OBJECT_FIELD_TABS: readonly ObjectFieldTab[] = [
  { key: 'place', label: 'Position', fields: ['positionAlongWallM', 'offsetFromFloorM'] },
  { key: 'size', label: 'Größe', fields: ['widthM', 'heightM'] },
]

/** Visible slider count: Position + Breite + Höhe (3), plus Über Boden when shown → 4. */
export function visibleFieldCount(config: ObjectSliderConfig): number {
  return config.offsetFromFloorCm.show ? 4 : 3
}

/** 4 visible fields ⇒ split into two tabs (Position | Größe); else flat stack. */
export function isObjectSheetTabbed(config: ObjectSliderConfig): boolean {
  return visibleFieldCount(config) >= 4
}
