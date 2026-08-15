/**
 * Tests for canonical/workflow/persistEditCommand.ts — the workflow-layer
 * helper that persists an executed EditCommand to the edit-history audit trail.
 *
 * Covers (Block 2.13):
 *   - a successful append returns `persisted:true` with the written entries,
 *   - the command→row mapping flows through (multi-node ⇒ multi-row),
 *   - a repository failure is CAUGHT — `persisted:false`, never thrown
 *     (best-effort audit append: the local edit must not roll back),
 *   - the `isRestore` path maps rows with `command='restore'`,
 *   - the parametric SHAs are derived from the override snapshots.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../../src/lib/supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}))

import { persistEditCommand } from '../../../../../src/lib/spatial/canonical/workflow/persistEditCommand.ts'
import {
  InMemorySpatialEditHistoryRepository,
  type SpatialEditHistoryRepository,
} from '../../../../../src/lib/spatial/canonical/repository/editHistoryRepository.ts'
import type { EditCommand } from '../../../../../src/lib/spatial/canonical/types/commands.ts'
import type { NodeOverride } from '../../../../../src/lib/spatial/canonical/types/variants.ts'

const VARIANT = 'customer_corrections'
const SCENE = 'scene-1'

function ov(nodeId: string, fields: Record<string, unknown>): NodeOverride {
  return { base_node_id: nodeId, variant_id: VARIANT, override_fields: fields }
}

function cmd(after: NodeOverride[]): EditCommand {
  return {
    id: 'c1',
    operation: { kind: 'set_material', node_id: 'w1', surface: 'wall', material_id: 'tile' },
    label: 'Material',
    variant_id: VARIANT,
    before: [],
    after,
    timestamp: Date.now(),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('persistEditCommand', () => {
  it('persists a command and returns the written entries', async () => {
    const repo = new InMemorySpatialEditHistoryRepository({ actorIdProvider: () => 'user-1' })
    const result = await persistEditCommand(cmd([ov('w1', { material_id: 'tile' })]), {
      sceneId: SCENE,
      repository: repo,
    })
    expect(result.persisted).toBe(true)
    if (result.persisted) {
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].command).toBe('set')
      expect(result.entries[0].semantic_op).toBe('set_material')
    }
    expect(await repo.list(SCENE)).toHaveLength(1)
  })

  it('writes one audit row per touched node (multi-node command)', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await persistEditCommand(
      {
        ...cmd([ov('w_s', { height_m: 2.6 }), ov('w_e', { height_m: 2.6 })]),
        operation: { kind: 'set_room_height', room_id: 'room', new_height_m: 2.6 },
      },
      { sceneId: SCENE, repository: repo },
    )
    const rows = await repo.list(SCENE)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.semantic_op === 'set_room_height')).toBe(true)
  })

  it('does NOT throw when the repository fails — returns persisted:false', async () => {
    const failingRepo: SpatialEditHistoryRepository = {
      append: () => Promise.reject(new Error('rpc down')),
      list: () => Promise.resolve([]),
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await persistEditCommand(cmd([ov('w1', { material_id: 'tile' })]), {
      sceneId: SCENE,
      repository: failingRepo,
    })
    expect(result.persisted).toBe(false)
    if (!result.persisted) {
      expect(result.error.message).toMatch(/rpc down/)
      expect(result.rowCount).toBe(1)
    }
    // Failure is logged but never rethrown — the local edit stays applied.
    expect(errSpy).toHaveBeenCalled()
  })

  it('the isRestore path persists rows with command=restore', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await persistEditCommand(cmd([ov('w1', { material_id: 'tile' })]), {
      sceneId: SCENE,
      repository: repo,
      isRestore: true,
      restoreSemanticOp: 'set_material',
    })
    const [row] = await repo.list(SCENE)
    expect(row.command).toBe('restore')
    expect(row.semantic_op).toBe('set_material')
  })

  it('derives the parametric SHAs from the override snapshots', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await persistEditCommand(cmd([ov('w1', { material_id: 'tile' })]), {
      sceneId: SCENE,
      repository: repo,
      overridesBefore: [],
      overridesAfter: [ov('w1', { material_id: 'tile' })],
    })
    const [row] = await repo.list(SCENE)
    // 64-char lowercase hex SHA-256.
    expect(row.parametric_sha256_before).toMatch(/^[0-9a-f]{64}$/)
    expect(row.parametric_sha256_after).toMatch(/^[0-9a-f]{64}$/)
    expect(row.parametric_sha256_before).not.toBe(row.parametric_sha256_after)
  })

  it('leaves the SHAs null when no snapshots are supplied', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    await persistEditCommand(cmd([ov('w1', {})]), { sceneId: SCENE, repository: repo })
    const [row] = await repo.list(SCENE)
    expect(row.parametric_sha256_before).toBeNull()
    expect(row.parametric_sha256_after).toBeNull()
  })
})
