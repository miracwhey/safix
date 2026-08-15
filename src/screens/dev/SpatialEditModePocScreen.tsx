/**
 * Dev-only POC screen — `/dev/spatial-edit`
 *
 * A runnable demonstration surface (NOT production logic) for the Phase-2
 * Block-2.9-2.12 edit-system: it mounts `<EditModeViewerHost>` against a
 * synthetic multi-variant bathroom scene so a reviewer can exercise, without a
 * rebuild:
 *
 *   - the VariantSwitcher (2.9)        — switch the active layer, see the
 *     pencil/eye affordance derived from the dev role,
 *   - the RBAC guard (2.10/2.11)       — flip the dev role; the writable
 *     variant + edit-mode availability change accordingly,
 *   - surface-tap → MaterialPickerSheet — tap a wall/floor to apply a material
 *     command onto the role-correct variant,
 *   - the Visual-Diff overlay (2.12)   — toggle "Diff" to tint the active
 *     variant's changes vs `base_roomplan`.
 *
 * Gated behind `import.meta.env.DEV` — never reachable in a production build
 * (see the `App.tsx` route guard). Production integration of the host into a
 * real customer/provider screen is later cross-domain scope (Phase 4/5).
 *
 * The dev role switcher writes a mock session via `__testOnly_setSession`,
 * which is the same authoritative seam the workflow-layer guards read. This is
 * a DEV affordance only — `__testOnly_setSession` must never be called from
 * production code.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { User } from '@supabase/supabase-js'

import { EditModeViewerHost } from '../../components/spatial/edit/EditModeViewerHost'
import type { Wall, Floor, Ceiling, WallOpening } from '../../lib/spatial/canonical/types/geometry'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { SpatialObject, ObjectCategory, ObjectHost } from '../../lib/spatial/canonical/types/objects'
import type { Variant, NodeOverride } from '../../lib/spatial/canonical/types/variants'
import {
  STANDARD_VARIANTS,
  providerAnnotationsVariantId,
} from '../../lib/spatial/canonical/types/variants'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../lib/spatial/canonical/types/primitives'
import { __testOnly_setSession, type SessionState } from '../../lib/session'
import { useEditHistoryStore } from '../../lib/spatial/canonical/store/editHistoryStore'

// ── Dev role switcher ─────────────────────────────────────────────────────

const DEV_PROVIDER_ID = 'dev-provider-1'

type DevRole = 'customer' | 'provider' | 'operator'

function mockSessionFor(role: DevRole): SessionState {
  const userId =
    role === 'customer'
      ? 'dev-customer-1'
      : role === 'provider'
        ? DEV_PROVIDER_ID
        : 'dev-operator-1'
  const user = {
    id: userId,
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  } as unknown as User
  return {
    user,
    role: role === 'customer' ? 'customer' : 'craftsman',
    craftsmanRole: role === 'provider' ? 'owner' : null,
    isOperator: role === 'operator',
    tosAcceptedAt: null,
    loading: false,
    sessionValidated: true,
    error: null,
    errorKind: null,
  }
}

export default function SpatialEditModePocScreen(): ReactElement {
  const [devRole, setDevRole] = useState<DevRole>('provider')
  const clearHistory = useEditHistoryStore((s) => s.clear)

  // Install the dev session synchronously before the host reads it. Reset the
  // edit-history stack on every role switch so a stale command targeting the
  // previous role's variant cannot be undone into the new role's layer.
  useEffect(() => {
    __testOnly_setSession(mockSessionFor(devRole))
    clearHistory()
  }, [devRole, clearHistory])

  const scene = useMemo(() => buildEditPocScene(), [])
  const variants = useMemo(() => buildVariants(), [])
  const overrides = useMemo(() => buildSeedOverrides(), [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#1a1a1d',
        color: '#fafafa',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
      }}
    >
      <header
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #2a2a2e',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
        }}
      >
        <strong>Spatial Edit-Mode · POC (Block 2.9-2.12)</strong>
        <span style={{ opacity: 0.6 }}>
          Tap eine Fläche im Bearbeiten-Modus · VariantSwitcher links · Diff unten
        </span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ opacity: 0.7 }}>Dev-Rolle</span>
          <select
            value={devRole}
            onChange={(e) => setDevRole(e.target.value as DevRole)}
            style={{
              background: '#27272b',
              color: '#fafafa',
              border: '1px solid #3a3a3e',
              borderRadius: 6,
              padding: '3px 6px',
              fontSize: 12,
            }}
          >
            <option value="customer">Customer</option>
            <option value="provider">Provider</option>
            <option value="operator">Operator</option>
          </select>
        </label>
      </header>

      <EditModeViewerHost
        scene={scene}
        overrides={overrides}
        variants={variants}
        className="spatial-edit-poc-host"
      />
    </div>
  )
}

// ── Synthetic multi-variant scene ─────────────────────────────────────────

const NOW = '2026-05-20T00:00:00.000Z'
const ROOM_ID = 'editpoc-room'
const WALL_HEIGHT = 2.5
const WALL_THICKNESS = 0.15

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkWall(
  id: string,
  start: { x: number; z: number },
  end: { x: number; z: number },
  opts: { materialId?: string; openings?: WallOpening[] } = {},
): Wall {
  return {
    ...baseNode(id, 'wall', ROOM_ID),
    start_point: { x: start.x, y: 0, z: start.z },
    end_point: { x: end.x, y: 0, z: end.z },
    height_m: WALL_HEIGHT,
    thickness_m: WALL_THICKNESS,
    base_height_m: 0,
    openings: opts.openings ?? [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    material_id: opts.materialId,
    length_m: Math.hypot(end.x - start.x, end.z - start.z),
    normal: { x: 0, y: 0, z: 0 },
  }
}

function mkOpening(
  id: string,
  hostWallId: string,
  type: WallOpening['type'],
  offsetAlong: number,
  width: number,
  height: number,
  offsetFromFloor: number,
): WallOpening {
  return {
    ...baseNode(id, type, hostWallId),
    host_wall_id: hostWallId,
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: offsetFromFloor,
    width_m: width,
    height_m: height,
    is_walkable_portal: type === 'door',
  }
}

function mkObject(args: {
  id: string
  category: ObjectCategory
  host: ObjectHost
  position: { x: number; y: number; z: number }
  dimensions: { width_m: number; depth_m: number; height_m: number }
  assetId?: string
  materialId?: string
}): SpatialObject {
  return {
    ...baseNode(args.id, 'object', ROOM_ID),
    transform: {
      position: args.position,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    category: args.category,
    asset_id: args.assetId,
    material_id: args.materialId,
    dimensions: args.dimensions,
    host: args.host,
    host_id: args.host === 'floor' ? 'editpoc-floor' : ROOM_ID,
  }
}

function buildEditPocScene(): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 5 },
    { x: 0, y: 0, z: 5 },
  ]
  const door = mkOpening('editpoc-door', 'w_s', 'door', 1.2, 0.9, 2.05, 0)

  const walls: Wall[] = [
    mkWall('w_s', { x: 0, z: 0 }, { x: 4, z: 0 }, {
      materialId: 'wall-tile-white',
      openings: [door],
    }),
    mkWall('w_e', { x: 4, z: 0 }, { x: 4, z: 5 }, { materialId: 'wall-tile-white' }),
    mkWall('w_n', { x: 4, z: 5 }, { x: 0, z: 5 }, { materialId: 'wall-tile-white' }),
    mkWall('w_w', { x: 0, z: 5 }, { x: 0, z: 0 }, { materialId: 'wall-tile-white' }),
  ]

  const floor: Floor = {
    ...baseNode('editpoc-floor', 'floor', ROOM_ID),
    polygon: ring,
    material_id: 'floor-marble',
    walkable_surface: true as const,
    floor_mounted: [],
  }

  const ceiling: Ceiling = {
    ...baseNode('editpoc-ceiling', 'ceiling', ROOM_ID),
    polygon: ring,
    height_m: WALL_HEIGHT,
    material_id: 'wall-paint-white',
    ceiling_mounted: [],
  }

  const free_objects: SpatialObject[] = [
    mkObject({
      id: 'obj-toilet',
      category: 'toilet',
      host: 'floor',
      position: { x: 0.6, y: 0, z: 0.6 },
      dimensions: { width_m: 0.4, depth_m: 0.7, height_m: 0.8 },
      assetId: 'sanitary-toilet-standard-floor',
      materialId: 'decor-ceramic-white',
    }),
    mkObject({
      id: 'obj-bathtub',
      category: 'bathtub',
      host: 'floor',
      position: { x: 2.0, y: 0, z: 4.0 },
      dimensions: { width_m: 1.7, depth_m: 0.8, height_m: 0.6 },
      assetId: 'sanitary-bathtub-freestanding-oval',
      materialId: 'decor-ceramic-white',
    }),
  ]

  return {
    ...baseNode(ROOM_ID, 'room', 'editpoc-building'),
    category: 'bathroom',
    walls,
    floor,
    ceiling,
    free_objects,
    pins: [],
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: WALL_HEIGHT, z: 5 },
    computed_area_m2: 20,
    computed_volume_m3: 50,
  }
}

/**
 * The five-variant chain — one of each variant TYPE so the VariantSwitcher
 * shows the pencil/eye affordance for every category and the RBAC guard can
 * be exercised by switching the dev role.
 */
function buildVariants(): Variant[] {
  return [
    {
      id: STANDARD_VARIANTS.BASE_ROOMPLAN,
      display_name: 'Scan (Original)',
      is_default: true,
    },
    {
      id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      display_name: 'Kunden-Korrekturen',
      parent_variant_id: STANDARD_VARIANTS.BASE_ROOMPLAN,
      is_default: false,
    },
    {
      id: providerAnnotationsVariantId(DEV_PROVIDER_ID),
      display_name: 'Meine Anmerkungen',
      parent_variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      is_default: false,
    },
    {
      id: providerAnnotationsVariantId('dev-provider-other'),
      display_name: 'Anmerkungen · anderer Handwerker',
      parent_variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      is_default: false,
    },
    {
      id: STANDARD_VARIANTS.OPERATOR_REVIEW,
      display_name: 'Operator-Prüfung',
      parent_variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      is_default: false,
    },
  ]
}

/**
 * Seed overrides so the Visual-Diff overlay has something to highlight: the
 * customer-corrections variant re-materials a wall (a `modified` marker).
 */
function buildSeedOverrides(): NodeOverride[] {
  return [
    {
      base_node_id: 'w_n',
      variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      override_fields: { material_id: 'wall-plaster-creme' },
    },
  ]
}
