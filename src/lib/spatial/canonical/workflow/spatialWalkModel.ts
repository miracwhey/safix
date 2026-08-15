/**
 * Spatial · Walk · Object-Selection Model (Phase-B · B-7)
 *
 * Pure logic — zero React, zero three.js. Defines:
 *   - The selectable element kinds in walk-mode (wall / floor / ceiling / object / opening)
 *   - The available actions per element kind, per spec §6.1 / §8.1
 *   - Walk-session state shape (selected element, pending action)
 *
 * Phase-C seam: this model describes actions in terms of `WalkAction` records.
 * The 3D hit-test that maps a pointer event to a `WalkableElement` is a Phase-C
 * concern. For now callers construct `WalkableElement` directly from scene-graph
 * nodes after a 2D hit-test (or from the lightweight 2D placeholder in
 * WorkerFieldWalkScreen).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Element kinds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scene-graph kinds that can be tapped by a field worker in walk-mode.
 * 'opening' covers both doors and windows.
 */
export type WalkableElementKind =
  | 'wall'
  | 'floor'
  | 'ceiling'
  | 'object'
  | 'opening'

// ─────────────────────────────────────────────────────────────────────────────
// Action descriptors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable identifiers for the per-element actions.
 *
 * Keep these aligned with spec §6.1 / §8.1. New action ids must be added
 * here AND in `ACTIONS_BY_KIND` below.
 */
export type WalkActionId =
  // Shared across multiple element kinds
  | 'add_photo_pin'
  | 'add_pin_note'
  | 'report_problem'
  // Wall-specific
  | 'edit_dimensions'
  | 'change_wall_material'
  // Floor-specific
  | 'change_floor_material'
  // Ceiling-specific
  | 'change_ceiling_material'
  // Object-specific
  | 'replace_object'
  | 'reposition_object'
  // Opening-specific
  | 'edit_opening_dimensions'
  | 'change_opening_type'

/**
 * Display descriptor for one action entry in the context sheet.
 *
 * `icon` is a Lucide icon name (string) so this layer stays zero-React.
 * The UI layer maps these to actual icon components.
 */
export interface WalkAction {
  id: WalkActionId
  /** Short label shown in the context sheet action row. */
  label: string
  /** Sub-label shown below label — describes what it does. */
  hint: string
  /** Lucide icon name. */
  icon: string
  /** Visual accent of the action icon (matches mockup colour classes). */
  accent: 'edit' | 'material' | 'photo' | 'pin' | 'problem' | 'replace'
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions catalogue
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_EDIT_DIMENSIONS: WalkAction = {
  id: 'edit_dimensions',
  label: 'Maß bearbeiten',
  hint: 'Breite & Höhe korrigieren',
  icon: 'Pencil',
  accent: 'edit',
}

const ACTION_CHANGE_WALL_MATERIAL: WalkAction = {
  id: 'change_wall_material',
  label: 'Wandbelag & Farbe',
  hint: 'Fliese, Putz, Anstrich wählen',
  icon: 'Layers',
  accent: 'material',
}

const ACTION_CHANGE_FLOOR_MATERIAL: WalkAction = {
  id: 'change_floor_material',
  label: 'Bodenbelag',
  hint: 'Fliese, Parkett, Vinyl wählen',
  icon: 'Layers',
  accent: 'material',
}

const ACTION_CHANGE_CEILING_MATERIAL: WalkAction = {
  id: 'change_ceiling_material',
  label: 'Deckenbelag & Farbe',
  hint: 'Farbe, Putz wählen',
  icon: 'Layers',
  accent: 'material',
}

const ACTION_ADD_PHOTO_PIN: WalkAction = {
  id: 'add_photo_pin',
  label: 'Foto aufnehmen',
  hint: 'An dieses Element geheftet',
  icon: 'Camera',
  accent: 'photo',
}

const ACTION_ADD_PIN_NOTE: WalkAction = {
  id: 'add_pin_note',
  label: 'Pin / Notiz setzen',
  hint: 'Hinweis für Büro / Kundin',
  icon: 'MapPin',
  accent: 'pin',
}

const ACTION_REPORT_PROBLEM: WalkAction = {
  id: 'report_problem',
  label: 'Problem melden',
  hint: 'Schaden, Mangel, Scan-Fehler',
  icon: 'AlertTriangle',
  accent: 'problem',
}

const ACTION_REPLACE_OBJECT: WalkAction = {
  id: 'replace_object',
  label: 'Objekt austauschen',
  hint: 'Anderes Sanitär- oder Möbelstück wählen',
  icon: 'RefreshCw',
  accent: 'replace',
}

const ACTION_REPOSITION_OBJECT: WalkAction = {
  id: 'reposition_object',
  label: 'Objekt verschieben',
  hint: 'Position im Raum anpassen',
  icon: 'Move',
  accent: 'edit',
}

const ACTION_EDIT_OPENING_DIMENSIONS: WalkAction = {
  id: 'edit_opening_dimensions',
  label: 'Öffnung Maß bearbeiten',
  hint: 'Breite & Höhe korrigieren',
  icon: 'Pencil',
  accent: 'edit',
}

const ACTION_CHANGE_OPENING_TYPE: WalkAction = {
  id: 'change_opening_type',
  label: 'Öffnungstyp ändern',
  hint: 'Tür, Fenster, Durchgang wählen',
  icon: 'DoorOpen',
  accent: 'material',
}

/**
 * The ordered list of available actions per element kind.
 *
 * Ordering is deliberate: most-used actions first, destructive-ish actions
 * (replace, report) last. The context sheet renders them in this order.
 */
export const ACTIONS_BY_KIND: Readonly<Record<WalkableElementKind, ReadonlyArray<WalkAction>>> =
  Object.freeze({
    wall: [
      ACTION_EDIT_DIMENSIONS,
      ACTION_CHANGE_WALL_MATERIAL,
      ACTION_ADD_PHOTO_PIN,
      ACTION_ADD_PIN_NOTE,
      ACTION_REPORT_PROBLEM,
    ],
    floor: [
      ACTION_CHANGE_FLOOR_MATERIAL,
      ACTION_ADD_PHOTO_PIN,
      ACTION_ADD_PIN_NOTE,
      ACTION_REPORT_PROBLEM,
    ],
    ceiling: [
      ACTION_CHANGE_CEILING_MATERIAL,
      ACTION_ADD_PHOTO_PIN,
      ACTION_ADD_PIN_NOTE,
      ACTION_REPORT_PROBLEM,
    ],
    object: [
      ACTION_REPLACE_OBJECT,
      ACTION_REPOSITION_OBJECT,
      ACTION_ADD_PHOTO_PIN,
      ACTION_ADD_PIN_NOTE,
      ACTION_REPORT_PROBLEM,
    ],
    opening: [
      ACTION_EDIT_OPENING_DIMENSIONS,
      ACTION_CHANGE_OPENING_TYPE,
      ACTION_ADD_PHOTO_PIN,
      ACTION_ADD_PIN_NOTE,
      ACTION_REPORT_PROBLEM,
    ],
  })

// ─────────────────────────────────────────────────────────────────────────────
// Walkable element (what was tapped)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tappable element in the scene. Phase-C seam: `id` and `kind` come from
 * the 3D hit-test; `label`, `subtitle`, and `currentValues` are derived from
 * scene-graph nodes by the calling component / hook.
 */
export interface WalkableElement {
  /** Node id in the canonical scene-graph. */
  id: string
  kind: WalkableElementKind
  /** Display name shown at the top of the context sheet. */
  label: string
  /** Short metadata line (dimensions, material, area). */
  subtitle: string
  /**
   * Per-action current values displayed alongside the action row.
   * Keys are `WalkActionId`; values are human-readable strings.
   * Actions without a current value are omitted.
   */
  currentValues?: Partial<Record<WalkActionId, string>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk session state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal walk-session state. The selected element is the single ephemeral
 * selection. Callers (e.g. `WorkerFieldWalkScreen`) hold this in `useState`.
 *
 * `pendingAction` is set when a worker taps an action; the UI opens the
 * appropriate sub-flow and clears it when done / cancelled.
 */
export interface WalkSessionState {
  selectedElement: WalkableElement | null
  pendingAction: WalkActionId | null
}

export const INITIAL_WALK_SESSION: WalkSessionState = {
  selectedElement: null,
  pendingAction: null,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the ordered actions available for an element kind.
 * Pure, side-effect-free.
 */
export function getActionsForKind(kind: WalkableElementKind): ReadonlyArray<WalkAction> {
  return ACTIONS_BY_KIND[kind]
}

/**
 * Select an element — returns a new session state with the element selected
 * and any pending action cleared.
 */
export function selectElement(
  _prev: WalkSessionState,
  element: WalkableElement,
): WalkSessionState {
  return { selectedElement: element, pendingAction: null }
}

/**
 * Deselect the current element (e.g. tap outside / close sheet).
 */
export function deselect(_prev: WalkSessionState): WalkSessionState {
  return INITIAL_WALK_SESSION
}

/**
 * Set a pending action — requires an element to be selected. Returns the
 * previous state unchanged when no element is selected (defensive).
 */
export function setPendingAction(
  prev: WalkSessionState,
  actionId: WalkActionId,
): WalkSessionState {
  if (!prev.selectedElement) return prev
  return { ...prev, pendingAction: actionId }
}

/**
 * Clear a pending action after the sub-flow completes or is cancelled.
 */
export function clearPendingAction(prev: WalkSessionState): WalkSessionState {
  return { ...prev, pendingAction: null }
}
