/**
 * Spatial · Canonical · Three · Pick-Layer (V1.6.1 R14)
 *
 * Decouples *pick geometry* (what the raycaster hits) from *render geometry*
 * (what the user sees). Walls/Floors/Ceilings render on the default Three.js
 * layer 0; their accompanying `<PickProxy>` mesh lives on PICK_LAYER and is
 * the only object the canonical raycaster hits.
 *
 * Why this exists:
 *   - Box-Walls have 6 faces; raycasts can pierce a wall and hit the far-side
 *     wall first (front-face culling vs DoubleSide thickness multi-hit).
 *   - AutoCutaway/FrontWall-Hide toggles `visible` in `useFrame`; Three.js
 *     `Raycaster.intersectObject` does NOT check `.visible` so hidden walls
 *     were still hit (frame-lag race).
 *   - Pick-Plane is a single thin plane positioned at the wall's INNER face
 *     (the side the customer sees from inside the dollhouse) — one unambiguous
 *     hit per wall, regardless of body thickness.
 *
 * Layer convention:
 *   - Layer 0 — default render. Walls/Floors/Ceilings/Objects render here.
 *   - Layer 1 (PICK_LAYER) — pick proxies. Camera does not see this layer;
 *     the canonical raycaster is configured to hit ONLY this layer.
 */

import type { Object3D, Raycaster } from 'three'

/** The dedicated Three.js layer that the canonical raycaster is bound to. */
export const PICK_LAYER = 1

/** Minimal Object3D shape — enables vitest with plain literals. */
interface PickableNode {
  layers: { enable(channel: number): void; disable(channel: number): void; set(channel: number): void }
  children?: ReadonlyArray<PickableNode>
}

/**
 * Mark an Object3D + all descendants as a *pure pick target*: removes them
 * from layer 0 (no render) and adds them to PICK_LAYER (raycast-only).
 *
 * Use on PickProxy meshes. Stable for the lifetime of the mesh — there is no
 * "toggle pickability" in our model. Cutaway hides the parent group via
 * `.visible = false` and we re-validate visibility in the tap handler.
 */
export function markPickOnly(node: PickableNode | null | undefined): void {
  if (!node) return
  const stack: PickableNode[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    n.layers.set(PICK_LAYER)
    if (n.children) for (const c of n.children) stack.push(c)
  }
}

/**
 * Configure a raycaster to hit ONLY PICK_LAYER. Call once on the canonical
 * raycaster (CanonicalSceneRoot init effect). Cumulative: a single call is
 * idempotent; subsequent calls re-apply the same layer mask.
 */
export function bindRaycasterToPickLayer(raycaster: Raycaster): void {
  raycaster.layers.disableAll()
  raycaster.layers.enable(PICK_LAYER)
}

/**
 * For debug-mode: temporarily make camera see PICK_LAYER too (pick-proxies
 * will render as semi-transparent overlays). Reverts on unmount via the
 * returned cleanup function.
 */
export function showPickLayerOnCamera(camera: Object3D): () => void {
  camera.layers.enable(PICK_LAYER)
  return () => camera.layers.disable(PICK_LAYER)
}

/**
 * Add PICK_LAYER to a subtree WITHOUT removing existing layers. Use for
 * solid singular meshes (Object, Opening, Pin) where the rendered body is
 * also the desired pick target — no need for a separate PickProxy. The
 * mesh stays on layer 0 (rendered) AND on layer 1 (raycastable by our
 * pick-layer-bound raycaster).
 */
export function enableSubtreePick(node: PickableNode | null | undefined): void {
  if (!node) return
  const stack: PickableNode[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    n.layers.enable(PICK_LAYER)
    if (n.children) for (const c of n.children) stack.push(c)
  }
}
