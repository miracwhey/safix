/**
 * Spatial · Canonical · Three · SceneRenderer (Day 11 wiring)
 *
 * Reads the resolved canonical RoomScene from the store and dispatches
 * every node to its dedicated adapter (Day 11).
 *
 * Pin host resolution: pins reference their host via `anchor_surface_id`.
 * The renderer builds a flat lookup of every renderable surface (walls +
 * floor + ceiling + objects) so PinAdapter can resolve UV → world.
 */

import { useMemo, type ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'
import type { Wall, Floor, Ceiling } from '../../../../lib/spatial/canonical/types/geometry.ts'
import type { SpatialObject } from '../../../../lib/spatial/canonical/types/objects.ts'
import { buildWallJoinGraph } from '../../../../lib/spatial/canonical/geometry/wall-joins.ts'

import { CeilingAdapter } from './adapters/CeilingAdapter'
import { FloorAdapter } from './adapters/FloorAdapter'
import { ObjectAdapter } from './adapters/ObjectAdapter'
import { PinAdapter } from './adapters/PinAdapter'
import { WallAdapter } from './adapters/WallAdapter'
import { SkirtingAdapter } from './adapters/SkirtingAdapter'
import { FloorplanCadOverlay } from './FloorplanCadOverlay'

type AnchorHost = Wall | Floor | Ceiling | SpatialObject

/**
 * Selects which renderer draws pins.
 *   - `'adapter'` (default) — built-in <PinAdapter> spheres rendered inline.
 *   - `'none'` — SceneRenderer omits pins entirely; the host page is
 *     expected to mount `<PinSet>` (or similar) separately. Pass `'none'`
 *     whenever PinSet/billboard pins are used to avoid double-rendering
 *     every pin (a sphere AND a billboard at the same world position).
 */
type PinRenderer = 'adapter' | 'none'

interface SceneRendererProps {
  pinRenderer?: PinRenderer
}

export function SceneRenderer({ pinRenderer = 'adapter' }: SceneRendererProps = {}): ReactElement | null {
  const resolved = useCanonicalSceneStore((s) => s.resolved)
  const cameraMode = useCanonicalSceneStore((s) => s.cameraMode)

  // Build a flat lookup of anchor-host nodes once per resolved-scene change.
  // Only needed when this component is the one rendering pins; skip the
  // allocation when the host page renders pins via PinSet.
  const hostsById = useMemo(() => {
    const map = new Map<string, AnchorHost>()
    if (!resolved || pinRenderer !== 'adapter') return map
    for (const w of resolved.walls) {
      map.set(w.id, w)
      for (const o of w.wall_mounted) map.set(o.id, o)
    }
    map.set(resolved.floor.id, resolved.floor)
    for (const o of resolved.floor.floor_mounted) map.set(o.id, o)
    map.set(resolved.ceiling.id, resolved.ceiling)
    for (const o of resolved.ceiling.ceiling_mounted) map.set(o.id, o)
    for (const o of resolved.free_objects) map.set(o.id, o)
    return map
  }, [resolved, pinRenderer])

  // Corner-join topology for the room — derived once, fed to every WallAdapter
  // (mitered footprint) and the SkirtingAdapter (mitered inner edge).
  const joinGraph = useMemo(
    () => buildWallJoinGraph(resolved?.walls ?? []),
    [resolved],
  )

  if (!resolved) return null

  // Floorplan-Mode (R8 Update): CAD-Architekten-Plan-Look per Mockup 13
  // V5 State B. FloorAdapter ausgeblendet — das warm-beige ModeBackground
  // ist jetzt die Floor-Surface, darüber zeichnet FloorplanCadOverlay
  // die Wände als 2D-Quads (mit Thickness) + Maß-Bubbles + Room-Label.
  // Vorher waren Floor (Taupe) + Background (off-white) + Wand-Lines drei
  // konkurrierende Layer; jetzt klare Hierarchie:
  //   Background (warm-beige) → Walls (dark-ink Quads) → Labels (white).
  if (cameraMode === 'floorplan') {
    return (
      <group name="canonical-scene-root-floorplan">
        <FloorplanCadOverlay />
      </group>
    )
  }

  return (
    <group name="canonical-scene-root">
      {resolved.walls.map((w) => (
        <WallAdapter key={w.id} wall={w} joinGraph={joinGraph} />
      ))}
      <SkirtingAdapter walls={resolved.walls} joinGraph={joinGraph} />
      <FloorAdapter floor={resolved.floor} />
      <CeilingAdapter ceiling={resolved.ceiling} />
      {/*
        Free-standing objects live on RoomScene directly (not under a wall /
        floor / ceiling group). They carry `host: 'free'`, so ObjectAdapter
        positions them at `transform.position` with no re-anchoring. Walls,
        floor and ceiling render their own hosted objects via their adapters.
      */}
      {resolved.free_objects.map((obj) => (
        <ObjectAdapter key={obj.id} object={obj} />
      ))}
      {pinRenderer === 'adapter' &&
        resolved.pins.map((p) => (
          <PinAdapter key={p.id} pin={p} host={hostsById.get(p.anchor_surface_id) ?? null} />
        ))}
    </group>
  )
}
