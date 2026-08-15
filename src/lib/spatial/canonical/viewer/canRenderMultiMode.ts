/**
 * Spatial · Canonical · Viewer · canRenderMultiMode
 *
 * Pure gate that decides whether a presales / provider-owned scene can be
 * mounted in the view-only multi-mode canonical viewer (Grundriss / Dollhouse
 * / Walk).
 *
 * Two conditions must hold:
 *   1. the parametric blob is hydrated (`blobState === 'ready'` ⇒ `roomScene`
 *      is non-null per the `usePresalesDetail` contract), and
 *   2. the scene has real geometry — at least 3 walls.
 *
 * The wall-count guard is deliberate: `empty_canvas` manual drafts are inserted
 * with `is_renderable = true` in the DB but carry 0 walls, so the coarse DB flag
 * alone would surface a featureless dead-end viewer. Mirroring the validator's
 * `is_renderable` rule (floor polygon ≥ 3 and walls ≥ 3) keeps the CTA honest:
 * a 2×2 room (4 walls) or example room renders; a blank canvas keeps the stats
 * card until the user has drawn walls.
 */

import type { RoomScene } from '../types/scene-graph'

/** Blob-hydration lifecycle — mirrors `PresalesBlobState` (usePresalesDetail). */
export type MultiModeBlobState = 'absent' | 'loading' | 'ready' | 'error'

export function canRenderMultiMode(
  roomScene: RoomScene | null,
  blobState: MultiModeBlobState,
): boolean {
  return roomScene !== null && roomScene.walls.length >= 3 && blobState === 'ready'
}
