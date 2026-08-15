/**
 * Spatial · deriveCustomerToolCounts
 *
 * Pure projection: count the placed objects in a scene per CUSTOMER tool, for
 * the {@link CustomerSpatialToolBar} count badges ("how many doors did I mark").
 * Mirror of {@link deriveCraftsmanToolCounts} but folded onto the coarser
 * customer tool set (the customer bar merges outlet/switch/fusebox into one
 * `electrical` chip and exposes a single `furniture` chip for catalog assets).
 * Kept out of the hub so the kind→tool mapping is the single, unit-tested
 * source of truth; it is display-only, so a drift here can't corrupt scene data.
 *
 * Mapping (verified against the builders + geometry types):
 *   - openings[].type          'door' | 'window'                → door / window
 *   - wall_mounted[].category  radiator                         → heating
 *                              electrical_outlet/light_switch/
 *                              fuse_box                          → electrical
 *                              (any other wall catalog asset)    → furniture
 *   - floor.floor_mounted[]    (all)                            → furniture
 *   - ceiling.ceiling_mounted[] (all)                           → furniture
 *   - 'wall' is an edit mode, not a countable object → never badged.
 */
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { CustomerSpatialTool } from './customer/CustomerSpatialToolBar'

export type CustomerToolCounts = Partial<
  Record<CustomerSpatialTool, { count: number; glow?: boolean }>
>

const ELECTRICAL_CATEGORIES = new Set(['electrical_outlet', 'light_switch', 'fuse_box'])

export function deriveCustomerToolCounts(scene: RoomScene): CustomerToolCounts {
  const c: CustomerToolCounts = {}
  const bump = (k: CustomerSpatialTool, by = 1): void => {
    if (by <= 0) return
    c[k] = { count: (c[k]?.count ?? 0) + by }
  }
  for (const w of scene.walls) {
    for (const op of w.openings) {
      if (op.type === 'door') bump('door')
      else if (op.type === 'window') bump('window')
    }
    for (const o of w.wall_mounted) {
      if (o.category === 'radiator') bump('heating')
      else if (ELECTRICAL_CATEGORIES.has(o.category)) bump('electrical')
      else bump('furniture')
    }
  }
  bump('furniture', scene.floor?.floor_mounted?.length ?? 0)
  bump('furniture', scene.ceiling?.ceiling_mounted?.length ?? 0)
  return c
}
