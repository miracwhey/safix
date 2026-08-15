/**
 * Spatial · Canonical · Store · Scene Store (Day 10 · L3 spike)
 *
 * Zustand store that owns the read-side of the canonical renderer:
 *   - the base `RoomScene`
 *   - the override stack (`NodeOverride[]`)
 *   - the variants registry + active variant id
 *   - the override cache (content-addressed · per CRIT-3 audit-fix)
 *
 * The `resolved` getter wraps {@link resolveSceneCached} so render code can
 * select the resolved RoomScene without re-running the resolver every frame.
 * Subscribers select via `subscribeWithSelector` for cheap referential
 * comparisons — `getState().resolved` returns the same reference until
 * something downstream invalidates the cache.
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

import type { RoomScene } from '../types/scene-graph.ts'
import type { NodeOverride, Variant, VariantId } from '../types/variants.ts'
import type { CameraMode, CutawaySetting } from '../types/camera.ts'
import {
  createOverrideCache,
  resolveSceneCached,
  invalidateScene,
  invalidateVariant,
  type OverrideCache,
} from '../overrides/cache.ts'

/**
 * Host eines fokussierten Objekts — Subset von `ObjectHost`, die einen eigenen
 * Edit-Layer / eine eigene Edit-UI haben (V1.6.1 Partial-Focus-Unify).
 */
export type ObjectFocusHost = 'floor' | 'wall' | 'ceiling'

/**
 * Public shape exposed by {@link useCanonicalSceneStore}.
 */
export interface CanonicalSceneState {
  // ── persisted state ──────────────────────────────────────────────────────
  scene: RoomScene | null
  overrides: NodeOverride[]
  variants: Variant[]
  activeVariantId: VariantId | null

  // ── derived ──────────────────────────────────────────────────────────────
  /**
   * Lazily resolved scene against `activeVariantId`. Uses the content-
   * addressed override cache so consecutive calls with the same inputs
   * return `===`-stable references.
   */
  resolved: RoomScene | null

  // ── camera + section view state (transient · B-4 / B-5) ──────────────────
  /** Active camera mode. View-only — never persisted, never affects `resolved`. */
  cameraMode: CameraMode
  /** Active cutaway preset (ceiling / wall-hide presets). */
  cutawaySetting: CutawaySetting
  /** Walls manually hidden by the user (per-wall section toggle). */
  hiddenWallIds: string[]
  /** Horizontal section-slice height in meters; `null` = no slice. */
  sectionSliderY: number | null
  /**
   * R12.3: Aktuell durch Tap selektierte Surface (Two-Step-Interaktion im
   * Customer-Hub). `${kind}-${nodeId}` Format (z.B. `wall-w_n`). Transient,
   * nicht persistiert. Erster Tap → setSelected; zweiter Tap auf gleiche
   * Surface → Host öffnet Detail-/Edit-Sheet; Tap-andere → wechselt; Tap
   * ins Leere (Background) → setSelected(null).
   */
  selectedSurface: string | null

  /**
   * V1.6.1 Partial-Focus-Unify: id des aktuell fokussierten Objekts, egal auf
   * welchem Host (Boden/Wand/Decke) — EINE Quelle für Selektion + Edit-Sheet +
   * Selektions-Outline. `focusedHost` disambiguiert, welcher Edit-Layer / welche
   * UI das Objekt konsumiert (floor → Drag/Pinch/Dreh-Dial + Aktionsleiste,
   * wall → CustomerObjectEditSheet, ceiling → Decken-Drag + Aktionsleiste).
   * Beide transient, nicht persistiert. `null`/`null` = nichts fokussiert.
   */
  focusedObjectId: string | null
  focusedHost: ObjectFocusHost | null
  /**
   * Phase 5: während einer Möbel-Geste (Drag/Pinch/Dial) gesetzt → der
   * DollhouseController schaltet OrbitControls (rotate/zoom) ab, damit die
   * Geste das Objekt bewegt statt die Kamera.
   */
  objectInteractionLocked: boolean

  // ── actions (immutable updaters · React-immer-compat) ────────────────────
  setScene(scene: RoomScene | null): void
  setOverrides(overrides: readonly NodeOverride[]): void
  setVariants(variants: readonly Variant[]): void
  setActiveVariantId(id: VariantId | null): void
  setCameraMode(mode: CameraMode): void
  setCutawaySetting(setting: CutawaySetting): void
  toggleHiddenWall(wallId: string): void
  setSectionSliderY(y: number | null): void
  setSelectedSurface(key: string | null): void
  /** Fokus auf ein Objekt setzen (Host explizit). Ersetzt das alte floor-only
   *  `setSelectedObjectId`. */
  setFocus(id: string, host: ObjectFocusHost): void
  /** Fokus komplett räumen (kein Objekt selektiert). */
  clearFocus(): void
  setObjectInteractionLocked(locked: boolean): void

  /** Apply a single override update + invalidate the affected variant. */
  upsertOverride(o: NodeOverride): void
  removeOverride(baseNodeId: string, variantId: VariantId): void

  /** Wipe the override cache (escape hatch). */
  resetOverrideCache(): void
}

/**
 * Underlying cache instance lives outside the React state tree so its
 * mutations never trigger a render. Recomputed on demand by the
 * `resolved` getter.
 */
let overrideCache: OverrideCache = createOverrideCache()

function recomputeResolved(state: Pick<CanonicalSceneState, 'scene' | 'overrides' | 'variants' | 'activeVariantId'>): RoomScene | null {
  if (!state.scene) return null
  // No overrides → resolution is a no-op; return the base scene directly.
  // Why: Customer-Hub mounts CanonicalSceneRoot with `scene` + `variants` but
  // without `activeVariantId` (no variant editor). Previously the resolver
  // bailed `null` when `activeVariantId` was missing, leaving the canvas
  // empty (R5 customer-render bug 2026-05-27). When there's nothing to
  // override anyway, an active variant id is irrelevant — render the scene.
  if (state.overrides.length === 0) {
    return state.scene
  }
  // Overrides exist but no active variant chosen → cannot resolve; render base.
  if (!state.activeVariantId) {
    return state.scene
  }
  return resolveSceneCached(
    {
      scene: state.scene,
      overrides: state.overrides,
      variants: state.variants,
      activeVariantId: state.activeVariantId,
    },
    overrideCache,
  )
}

export const useCanonicalSceneStore = create<CanonicalSceneState>()(
  subscribeWithSelector((set, get) => ({
    scene: null,
    overrides: [],
    variants: [],
    activeVariantId: null,
    resolved: null,
    cameraMode: 'dollhouse',
    cutawaySetting: 'none',
    hiddenWallIds: [],
    sectionSliderY: null,
    selectedSurface: null,
    focusedObjectId: null,
    focusedHost: null,
    objectInteractionLocked: false,

    setScene(scene) {
      set((s) => {
        if (s.scene) invalidateScene(overrideCache, s.scene)
        const next = { ...s, scene }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    setOverrides(overrides) {
      set((s) => {
        const next = { ...s, overrides: overrides as NodeOverride[] }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    setVariants(variants) {
      set((s) => {
        const next = { ...s, variants: variants as Variant[] }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    setActiveVariantId(activeVariantId) {
      set((s) => {
        const next = { ...s, activeVariantId }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    upsertOverride(o) {
      set((s) => {
        const idx = s.overrides.findIndex(
          (existing) => existing.base_node_id === o.base_node_id && existing.variant_id === o.variant_id,
        )
        const overrides = idx >= 0
          ? s.overrides.map((existing, i) => (i === idx ? o : existing))
          : [...s.overrides, o]
        if (s.scene) invalidateVariant(overrideCache, s.scene, o.variant_id)
        const next = { ...s, overrides }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    removeOverride(baseNodeId, variantId) {
      set((s) => {
        const overrides = s.overrides.filter(
          (o) => !(o.base_node_id === baseNodeId && o.variant_id === variantId),
        )
        if (s.scene) invalidateVariant(overrideCache, s.scene, variantId)
        const next = { ...s, overrides }
        return { ...next, resolved: recomputeResolved(next) }
      })
    },

    setCameraMode(cameraMode) {
      // Pure view state — no resolved-scene recompute, no cache touch.
      set({ cameraMode })
    },

    setCutawaySetting(cutawaySetting) {
      set({ cutawaySetting })
    },

    toggleHiddenWall(wallId) {
      set((s) => ({
        hiddenWallIds: s.hiddenWallIds.includes(wallId)
          ? s.hiddenWallIds.filter((id) => id !== wallId)
          : [...s.hiddenWallIds, wallId],
      }))
    },

    setSectionSliderY(sectionSliderY) {
      set({ sectionSliderY })
    },

    setSelectedSurface(selectedSurface) {
      set({ selectedSurface })
    },

    setFocus(id, host) {
      set({ focusedObjectId: id, focusedHost: host })
    },

    clearFocus() {
      set({ focusedObjectId: null, focusedHost: null })
    },

    setObjectInteractionLocked(objectInteractionLocked) {
      set({ objectInteractionLocked })
    },

    resetOverrideCache() {
      overrideCache = createOverrideCache()
      const next = get()
      set({ ...next, resolved: recomputeResolved(next) })
    },
  })),
)

/**
 * Pure getter for the resolved scene — equivalent to
 * `useCanonicalSceneStore.getState().resolved` but typed-narrow so callers
 * outside React can subscribe without importing zustand.
 */
export function getResolvedSceneSnapshot(): RoomScene | null {
  return useCanonicalSceneStore.getState().resolved
}
