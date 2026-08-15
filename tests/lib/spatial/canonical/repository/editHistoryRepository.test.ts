/**
 * Tests for repository/editHistoryRepository.ts — the InMemory + Supabase
 * edit-history persistence layer, the command→row mapper, and the registry.
 *
 * Covers (Block 2.13):
 *   - InMemory append/list — append-only, newest-first, scene-scoped.
 *   - Command→Row mapping — multi-node command ⇒ multiple rows; the coarse
 *     command-enum mapping (set / delete / restore).
 *   - Supabase impl — RPC args + the SELECT, with a fully-mocked client.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The Supabase impl imports `../../../supabase` — mock it before the module
// under test is loaded so no real client is constructed.
const rpcMock = vi.fn()
const fromMock = vi.fn()
vi.mock('../../../../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}))

import {
  InMemorySpatialEditHistoryRepository,
  SupabaseSpatialEditHistoryRepository,
  getSpatialEditHistoryRepository,
  resetSpatialEditHistoryRepository,
  mapCommandToRows,
  mapRestoreCommandToRows,
  type EditHistoryAppendRow,
} from '../../../../../src/lib/spatial/canonical/repository/editHistoryRepository.ts'
import { DELETION_MARKER_KEY } from '../../../../../src/lib/spatial/canonical/overrides/layer-merge.ts'
import type { EditCommand } from '../../../../../src/lib/spatial/canonical/types/commands.ts'
import type { NodeOverride } from '../../../../../src/lib/spatial/canonical/types/variants.ts'

const VARIANT = 'customer_corrections'
const SCENE = 'scene-1'

/** Build an `EditCommand` with a chosen operation + `after` override list. */
function cmd(
  kind: EditCommand['operation']['kind'],
  after: NodeOverride[],
  extra: Partial<EditCommand['operation']> = {},
): EditCommand {
  return {
    id: `c_${Math.random().toString(36).slice(2)}`,
    operation: { kind, node_id: 'n', ...extra } as EditCommand['operation'],
    label: 'Test',
    variant_id: VARIANT,
    before: [],
    after,
    timestamp: Date.now(),
  }
}

function ov(nodeId: string, fields: Record<string, unknown>): NodeOverride {
  return { base_node_id: nodeId, variant_id: VARIANT, override_fields: fields }
}

beforeEach(() => {
  resetSpatialEditHistoryRepository()
  rpcMock.mockReset()
  fromMock.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
// Command → Row mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('mapCommandToRows — command→row mapping', () => {
  it('maps a single-node command to exactly one row', () => {
    const rows = mapCommandToRows(cmd('set_material', [ov('w1', { material_id: 'tile' })]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      base_node_id: 'w1',
      variant_id: VARIANT,
      command: 'set',
      semantic_op: 'set_material',
      override_fields: { material_id: 'tile' },
    })
  })

  it('maps a MULTI-node command to one row per touched override', () => {
    // set_room_height resizes every wall — 4 overrides ⇒ 4 rows.
    const rows = mapCommandToRows(
      cmd('set_room_height', [
        ov('w_s', { height_m: 2.6 }),
        ov('w_e', { height_m: 2.6 }),
        ov('w_n', { height_m: 2.6 }),
        ov('w_w', { height_m: 2.6 }),
      ]),
    )
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.base_node_id)).toEqual(['w_s', 'w_e', 'w_n', 'w_w'])
    // Every row carries the same fine semantic op.
    expect(rows.every((r) => r.semantic_op === 'set_room_height')).toBe(true)
    // …and the coarse primitive is `set` (no deletion marker).
    expect(rows.every((r) => r.command === 'set')).toBe(true)
  })

  it('maps a delete-marker override to the `delete` coarse primitive', () => {
    const rows = mapCommandToRows(
      cmd('delete_node', [ov('obj1', { [DELETION_MARKER_KEY]: true })]),
    )
    expect(rows[0].command).toBe('delete')
    expect(rows[0].semantic_op).toBe('delete_node')
  })

  it('an empty after-snapshot produces zero rows', () => {
    expect(mapCommandToRows(cmd('set_material', []))).toHaveLength(0)
  })

  // ── F5 · node-adding commands emit an audit row ────────────────────────────
  it('emits an audit row for add_door even though `after` is empty', () => {
    // Only the `door.id` field is load-bearing for the audit row — the rest of
    // the WallOpening shape is irrelevant to mapCommandToRows.
    const addDoor: EditCommand = {
      id: 'c_door',
      operation: {
        kind: 'add_door',
        wall_id: 'w_s',
        door: { id: 'door_new' },
      } as unknown as EditCommand['operation'],
      label: 'Tür',
      variant_id: VARIANT,
      before: [],
      after: [], // node-adding command — no override rows
      timestamp: Date.now(),
    }
    const rows = mapCommandToRows(addDoor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      base_node_id: 'door_new',
      variant_id: VARIANT,
      command: 'set',
      semantic_op: 'add_door',
    })
  })

  it('emits an audit row for add_pin even though `after` is empty', () => {
    const addPin: EditCommand = {
      id: 'c_pin',
      operation: {
        kind: 'add_pin',
        pin_id: 'pin_new',
        anchor: {
          anchor_surface_id: 'w_s',
          anchor_surface_type: 'wall',
          anchor_uv: { u: 0.5, v: 0.5 },
          anchor_offset_normal_m: 0.01,
        },
      },
      label: 'Pin',
      variant_id: VARIANT,
      before: [],
      after: [],
      timestamp: Date.now(),
    }
    const rows = mapCommandToRows(addPin)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      base_node_id: 'pin_new',
      variant_id: VARIANT,
      command: 'set',
      semantic_op: 'add_pin',
    })
  })
})

describe('mapRestoreCommandToRows — reverter row mapping', () => {
  it('forces command=`restore` regardless of the delta shape', () => {
    const setRows = mapRestoreCommandToRows(cmd('set_material', [ov('w1', { material_id: 't' })]))
    expect(setRows[0].command).toBe('restore')

    const delRows = mapRestoreCommandToRows(
      cmd('delete_node', [ov('w1', { [DELETION_MARKER_KEY]: true })]),
    )
    // A restore that re-applies a deletion is STILL `restore`, not `delete`.
    expect(delRows[0].command).toBe('restore')
  })

  it('honours the semantic-op override (faithful audit)', () => {
    const rows = mapRestoreCommandToRows(
      cmd('delete_node', [ov('w1', {})]),
      'resize_wall',
    )
    expect(rows[0].semantic_op).toBe('resize_wall')
    expect(rows[0].command).toBe('restore')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// InMemory implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemorySpatialEditHistoryRepository', () => {
  const rows: EditHistoryAppendRow[] = [
    {
      variant_id: VARIANT,
      base_node_id: 'w1',
      override_fields: { material_id: 'tile' },
      command: 'set',
      semantic_op: 'set_material',
    },
  ]

  it('append returns the written rows; list reads them back', async () => {
    const repo = new InMemorySpatialEditHistoryRepository({ actorIdProvider: () => 'user-9' })
    const written = await repo.append({ scene_id: SCENE, rows })
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      scene_id: SCENE,
      base_node_id: 'w1',
      user_id: 'user-9',
      command: 'set',
      semantic_op: 'set_material',
    })
    const listed = await repo.list(SCENE)
    expect(listed).toHaveLength(1)
    expect(listed[0].base_node_id).toBe('w1')
  })

  it('list is scene-scoped', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({ scene_id: 'scene-A', rows })
    await repo.append({ scene_id: 'scene-B', rows })
    expect(await repo.list('scene-A')).toHaveLength(1)
    expect(await repo.list('scene-B')).toHaveLength(1)
    expect(await repo.list('scene-C')).toHaveLength(0)
  })

  it('list returns newest first', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({
      scene_id: SCENE,
      rows: [{ ...rows[0], base_node_id: 'first' }],
    })
    await repo.append({
      scene_id: SCENE,
      rows: [{ ...rows[0], base_node_id: 'second' }],
    })
    const listed = await repo.list(SCENE)
    // Most recent append is at index 0.
    expect(listed[0].base_node_id).toBe('second')
    expect(listed[1].base_node_id).toBe('first')
  })

  it('a multi-row append writes every row', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({
      scene_id: SCENE,
      rows: [
        { ...rows[0], base_node_id: 'w_s' },
        { ...rows[0], base_node_id: 'w_e' },
        { ...rows[0], base_node_id: 'w_n' },
      ],
    })
    expect(await repo.list(SCENE)).toHaveLength(3)
  })

  it('returns defensive copies — a mutated result cannot corrupt the log', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({ scene_id: SCENE, rows })
    const first = await repo.list(SCENE)
    first[0].override_fields.material_id = 'MUTATED'
    const second = await repo.list(SCENE)
    expect(second[0].override_fields.material_id).toBe('tile')
  })

  it('passes the parametric SHAs through', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({
      scene_id: SCENE,
      rows,
      parametric_sha256_before: 'sha-before',
      parametric_sha256_after: 'sha-after',
    })
    const [entry] = await repo.list(SCENE)
    expect(entry.parametric_sha256_before).toBe('sha-before')
    expect(entry.parametric_sha256_after).toBe('sha-after')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

describe('edit-history repository registry', () => {
  it('returns the InMemory impl for the in-memory source', () => {
    expect(getSpatialEditHistoryRepository('in-memory')).toBeInstanceOf(
      InMemorySpatialEditHistoryRepository,
    )
  })

  it('returns the Supabase impl for the supabase source', () => {
    expect(getSpatialEditHistoryRepository('supabase')).toBeInstanceOf(
      SupabaseSpatialEditHistoryRepository,
    )
  })

  it('caches the singleton per source kind', () => {
    expect(getSpatialEditHistoryRepository('in-memory')).toBe(
      getSpatialEditHistoryRepository('in-memory'),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Supabase implementation — RPC + SELECT contract
// ─────────────────────────────────────────────────────────────────────────────

describe('SupabaseSpatialEditHistoryRepository', () => {
  const repo = new SupabaseSpatialEditHistoryRepository()

  it('append calls the 8-arg spatial_edit_history_append RPC per row', async () => {
    rpcMock.mockResolvedValue({ data: 'row-uuid', error: null })
    // The fetch-after-append SELECT chain.
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: {
                id: 'row-uuid',
                scene_id: SCENE,
                actor_id: 'user-9',
                variant_id: VARIANT,
                base_node_id: 'w1',
                override_fields: { material_id: 'tile' },
                command: 'set',
                semantic_op: 'set_material',
                parametric_sha256_before: null,
                parametric_sha256_after: null,
                created_at: '2026-05-20T00:00:00.000Z',
              },
              error: null,
            }),
        }),
      }),
    })

    const written = await repo.append({
      scene_id: SCENE,
      rows: [
        {
          variant_id: VARIANT,
          base_node_id: 'w1',
          override_fields: { material_id: 'tile' },
          command: 'set',
          semantic_op: 'set_material',
        },
      ],
      parametric_sha256_before: 'before',
      parametric_sha256_after: 'after',
    })

    expect(rpcMock).toHaveBeenCalledWith('spatial_edit_history_append', {
      p_scene_id: SCENE,
      p_variant_id: VARIANT,
      p_base_node_id: 'w1',
      p_override_fields: { material_id: 'tile' },
      p_command: 'set',
      p_sha_before: 'before',
      p_sha_after: 'after',
      p_semantic_op: 'set_material',
    })
    expect(written[0].id).toBe('row-uuid')
    expect(written[0].user_id).toBe('user-9')
  })

  it('append throws when the RPC errors', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rls denied' } })
    await expect(
      repo.append({
        scene_id: SCENE,
        rows: [
          {
            variant_id: VARIANT,
            base_node_id: 'w1',
            override_fields: {},
            command: 'set',
            semantic_op: 'set_material',
          },
        ],
      }),
    ).rejects.toThrow(/rls denied/)
  })

  it('list issues a scene-scoped SELECT ordered by created_at desc', async () => {
    const orderSpy = vi.fn().mockReturnValue({
      limit: () => Promise.resolve({ data: [], error: null }),
    })
    const eqSpy = vi.fn().mockReturnValue({ order: orderSpy })
    fromMock.mockReturnValue({ select: () => ({ eq: eqSpy }) })

    await repo.list(SCENE)

    expect(fromMock).toHaveBeenCalledWith('spatial_edit_history')
    expect(eqSpy).toHaveBeenCalledWith('scene_id', SCENE)
    expect(orderSpy).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('list maps a null actor_id / semantic_op defensively', async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () =>
              Promise.resolve({
                data: [
                  {
                    id: 'r1',
                    scene_id: SCENE,
                    actor_id: null,
                    variant_id: VARIANT,
                    base_node_id: 'w1',
                    override_fields: {},
                    command: 'set',
                    semantic_op: null,
                    parametric_sha256_before: null,
                    parametric_sha256_after: null,
                    created_at: '2026-05-20T00:00:00.000Z',
                  },
                ],
                error: null,
              }),
          }),
        }),
      }),
    })
    const listed = await repo.list(SCENE)
    expect(listed[0].user_id).toBe('')
    expect(listed[0].semantic_op).toBe('set_material')
  })
})
