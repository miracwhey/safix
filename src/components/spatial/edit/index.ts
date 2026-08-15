/**
 * Spatial · Edit · barrel (Mockup 42 · Phase 2 Block 2.9-2.12)
 */

export { MaterialPickerSheet } from './MaterialPickerSheet'
export type { MaterialPickerSheetProps, MaterialPickerSurface } from './MaterialPickerSheet'
export { MaterialUndoToast } from './MaterialUndoToast'
export type { MaterialUndoToastProps } from './MaterialUndoToast'
export { CategoryPillRow } from './CategoryPillRow'
export { SearchField } from './SearchField'
export { MaterialCard } from './MaterialCard'
export { MaterialSectionGrid } from './MaterialSectionGrid'
export {
  CATEGORY_PILLS,
  surfaceTypeToCategory,
  materialThumbnailUrl,
  materialFinishLabel,
  type SurfaceType,
} from './materialPickerModel'

// ── Phase 2 · Block 2.9-2.12 — variant editing + edit-mode host ────────────
export { VariantSwitcher } from './VariantSwitcher'
export type { VariantSwitcherProps } from './VariantSwitcher'
export { EditModeViewerHost } from './EditModeViewerHost'
export type { EditModeViewerHostProps } from './EditModeViewerHost'

// ── Phase 2 · Block 2.14 — persistent edit-history timeline + reverter ─────
export { EditHistoryTimeline } from './EditHistoryTimeline'
export type { EditHistoryTimelineProps } from './EditHistoryTimeline'
