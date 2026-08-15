/**
 * Spatial · Canonical · Camera
 *
 * Camera modes, presets, and visibility filters per Master-Spec §3.6 + §4 + §5.
 *
 * Four camera modes ship in V1: Dollhouse (orbit · best for overview),
 * Floorplan (orthographic top-down · best for measurements), Walk (first-
 * person · best for inspection), and AR-Compare (placeholder in V1 · backed
 * by RealityKit in V1.x).
 *
 * Each mode has a static `CameraPreset` (lens, clipping, movement model)
 * and a `VisibilityFilter` controlling which scene-graph node-kinds are
 * rendered in that mode. This is the schema; controllers consuming it live
 * in `src/components/spatial/three/canonical/cameras/` (Day 16 P13-P16).
 */

/**
 * V1 camera modes. New modes (e.g. `cutaway`, `inspection`) can be added
 * without a schema migration by extending this union.
 */
export type CameraMode = 'dollhouse' | 'floorplan' | 'walk' | 'ar_compare'

/**
 * Camera-input model bound to a mode.
 *
 *   - 'orbit'          : drag to rotate around target, pinch to zoom (dollhouse)
 *   - 'walk'           : WASD / joystick / tap-to-move (first-person)
 *   - 'top-down'       : pan + pinch-zoom on an orthographic camera (floorplan)
 *   - 'ar-passthrough' : ARKit / RealityKit camera (V1.x)
 */
export type CameraMovement = 'orbit' | 'walk' | 'top-down' | 'ar-passthrough'

/**
 * Cutaway / cross-section setting · Master-Spec §5.
 *
 * Cutaway is a MODE setting (transient · per-user-session per Decision #4),
 * NOT a scene-graph mutation. The scene-graph stays whole; cutaway hides
 * subsets of nodes during rendering.
 *
 *   - 'none'                            : everything visible
 *   - 'remove_ceiling'                  : ceiling hidden
 *   - 'remove_ceiling_and_high_walls'   : ceiling + wall-tops above camera-Y hidden (floorplan default)
 *   - 'remove_front_wall'               : the wall facing the camera hidden (dollhouse side-view)
 *   - 'xray_walls'                      : walls rendered at opacity 0.3 with double-sided
 *   - 'half_height_walls'               : walls cut to 1.2 m (architectural side-cut look)
 */
export type CutawaySetting =
  | 'none'
  | 'remove_ceiling'
  | 'remove_ceiling_and_high_walls'
  | 'remove_front_wall'
  | 'xray_walls'
  | 'half_height_walls'

/**
 * Static configuration for a camera mode. Consumed by mode controllers to
 * configure the underlying three.js camera; never mutated at run time.
 *
 * `height_m` is `null` for non-walk modes (orbit / orthographic) where the
 * camera is positioned algorithmically (fit-to-bounds for dollhouse,
 * orthographic top-down for floorplan).
 */
export interface CameraPreset {
  mode: CameraMode
  height_m: number | null
  fov_deg: number
  near_clip_m: number
  far_clip_m: number
  movement: CameraMovement
  collision_enabled: boolean
  ceiling_visible: boolean
  cutaway_default: CutawaySetting
}

/**
 * Per-node-kind visibility flags applied when rendering a given mode.
 *
 * Renderers (Day 11 adapters) consult this filter to decide which children
 * to render. The dollhouse mode hides the ceiling so the user can see into
 * the room from above; the walk mode keeps everything visible because the
 * camera is inside the room.
 */
export interface VisibilityFilter {
  show_ceiling: boolean
  show_walls: boolean
  show_doors: boolean
  show_windows: boolean
  show_objects: boolean
  show_pins: boolean
  show_photos: boolean
  cutaway: CutawaySetting
}

/**
 * Canonical camera presets keyed by mode. Frozen and exported so the
 * controllers and the dev-screen share one source of truth.
 *
 * Per Master-Spec §3.6 table.
 */
export const CAMERA_PRESETS: Readonly<Record<CameraMode, CameraPreset>> = Object.freeze({
  dollhouse: Object.freeze({
    mode: 'dollhouse',
    height_m: null,
    fov_deg: 50,
    near_clip_m: 0.1,
    far_clip_m: 50,
    movement: 'orbit',
    collision_enabled: false,
    ceiling_visible: false,
    cutaway_default: 'remove_ceiling',
  }),
  floorplan: Object.freeze({
    mode: 'floorplan',
    height_m: null,
    fov_deg: 35,
    near_clip_m: 0.1,
    far_clip_m: 30,
    movement: 'top-down',
    collision_enabled: false,
    ceiling_visible: false,
    cutaway_default: 'remove_ceiling_and_high_walls',
  }),
  walk: Object.freeze({
    mode: 'walk',
    height_m: 1.7,
    fov_deg: 65,
    near_clip_m: 0.1,
    far_clip_m: 30,
    movement: 'walk',
    collision_enabled: true,
    ceiling_visible: true,
    cutaway_default: 'none',
  }),
  ar_compare: Object.freeze({
    mode: 'ar_compare',
    height_m: null,
    fov_deg: 60,
    near_clip_m: 0.1,
    far_clip_m: 20,
    movement: 'ar-passthrough',
    collision_enabled: false,
    ceiling_visible: true,
    cutaway_default: 'none',
  }),
})

/**
 * Default visibility filters per mode. Renderers may layer user-toggled
 * overrides on top of these defaults.
 */
export const DEFAULT_VISIBILITY: Readonly<Record<CameraMode, VisibilityFilter>> = Object.freeze({
  dollhouse: Object.freeze({
    show_ceiling: false,
    show_walls: true,
    show_doors: true,
    show_windows: true,
    show_objects: true,
    show_pins: true,
    show_photos: true,
    cutaway: 'remove_ceiling',
  }),
  floorplan: Object.freeze({
    show_ceiling: false,
    show_walls: true,
    show_doors: true,
    show_windows: true,
    show_objects: true,
    show_pins: true,
    show_photos: false,
    cutaway: 'remove_ceiling_and_high_walls',
  }),
  walk: Object.freeze({
    show_ceiling: true,
    show_walls: true,
    show_doors: true,
    show_windows: true,
    show_objects: true,
    show_pins: true,
    show_photos: true,
    cutaway: 'none',
  }),
  ar_compare: Object.freeze({
    show_ceiling: true,
    show_walls: true,
    show_doors: true,
    show_windows: true,
    show_objects: true,
    show_pins: true,
    show_photos: true,
    cutaway: 'none',
  }),
})
