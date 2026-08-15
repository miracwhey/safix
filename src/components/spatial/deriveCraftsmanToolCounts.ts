/**
 * Spatial · deriveCraftsmanToolCounts
 *
 * Pure projection: count the placed objects in a scene per craftsman tool, for
 * the {@link CraftsmanSpatialToolBar} count badges. Kept out of the viewer
 * component so the kind→tool mapping is the single, unit-tested source of truth
 * (the placement side maps tool→category via the object builders; this is the
 * inverse used only for display, so a drift here can't corrupt scene data).
 *
 * Mapping (verified against the builders + geometry types):
 *   - openings[].type          'door' | 'window'                → door / window
 *   - wall_mounted[].category  radiator/electrical_outlet/
 *                              light_switch/fuse_box            → radiator/outlet/switch/fusebox
 *   - floor.floor_mounted[].category  bathtub/sink/toilet       → bathtub/sink/toilet
 *   - 'material' is a wall finish, not a countable object → never badged.
 */
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { CraftsmanSpatialTool } from './CraftsmanSpatialToolBar'

export type CraftsmanToolCounts = Partial<
  Record<CraftsmanSpatialTool, { count: number; glow?: boolean }>
>

export function deriveCraftsmanToolCounts(scene: RoomScene): CraftsmanToolCounts {
  const c: CraftsmanToolCounts = {}
  const bump = (k: CraftsmanSpatialTool): void => {
    c[k] = { count: (c[k]?.count ?? 0) + 1 }
  }
  for (const w of scene.walls) {
    for (const op of w.openings) {
      if (op.type === 'door') bump('door')
      else if (op.type === 'window') bump('window')
    }
    for (const o of w.wall_mounted) {
      if (o.category === 'radiator') bump('radiator')
      else if (o.category === 'electrical_outlet') bump('outlet')
      else if (o.category === 'light_switch') bump('switch')
      else if (o.category === 'fuse_box') bump('fusebox')
    }
  }
  for (const o of scene.floor.floor_mounted) {
    if (o.category === 'bathtub') bump('bathtub')
    else if (o.category === 'sink') bump('sink')
    else if (o.category === 'toilet') bump('toilet')
  }
  return c
}
