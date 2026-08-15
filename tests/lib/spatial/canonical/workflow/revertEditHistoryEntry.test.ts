/**
 * Tests for canonical/workflow/revertEditHistoryEntry.ts — the PERSISTENT
 * reverter (Block 2.15), distinct from the session-undo.
 *
 * Covers:
 *   - a successful revert applies a RestoreOverrideCommand + persists a
 *     `command='restore'` row,
 *   - the RBAC gate (`assertCanWriteVariant`) blocks a foreign-variant revert,
 *   - the revert restores the predecessor delta when one exists,
 *   - the revert restores to base (override removed) when the entry is the
 *     first edit on its pair,
 *   - a persistence failure leaves the local revert applied (`reverted:true,
 *     persisted:false`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    auth: {
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import { revertEditHistoryEntry } from '../../../../../src/lib/spatial/canonical/workflow/revertEditHistoryEntry.ts'
import {
  InMemorySpatialEditHistoryRepository,
  type EditHistoryRowEntry,
  type SpatialEditHistoryRepository,
} from '../../../../../src/lib/spatial/canonical/repository/editHistoryRepository.ts'
import { useCanonicalSceneStore } from '../../../../../src/lib/spatial/canonical/store/sceneStore.ts'
import { useEditHistoryStore } from '../../../../../src/lib/spatial/canonical/store/editHistoryStore.ts'
import { providerAnnotationsVariantId } from '../../../../../src/lib/spatial/canonical/types/variants.ts'
import type { SpatialEditUser } from '../../../../../src/lib/spatial/workflow/spatialEditPermissions.ts'

const VARIANT = 'customer_corrections'
const SCENE = 'scene-1'

const CUSTOMER: SpatialEditUser = { userId: 'cust-1', role: 'customer', isOperator: false }
const SCENE_CTX = { variantIds: [VARIANT, providerAnnotationsVariantId('prov-9')] }

let seqCounter = 0

function entry(over: Partial<EditHistoryRowEntry> = {}): EditHistoryRowEntry {
  seqCounter += 1
  return {
    id: `e_${Math.random().toString(36).slice(2)}`,
    // Monotonic by construction order — the tiebreak the reverter uses for
    // same-`created_at` rows. Override explicitly when a test needs control.
    seq: seqCounter,
    scene_id: SCENE,
    variant_id: VARIANT,
    base_node_id: 'obj-1',
    user_id: 'cust-1',
    command: 'set',
    semantic_op: 'set_material',
    override_fields: { material_id: 'tile-anthracite' },
    parametric_sha256_before: null,
    parametric_sha256_after: null,
    created_at: '2026-05-20T10:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  // Fresh stores per test.
  useCanonicalSceneStore.getState().setScene(null)
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants([])
  useEditHistoryStore.getState().clear()
})

describe('revertEditHistoryEntry — RBAC gate', () => {
  it('blocks a revert of a variant the user may not write', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    const foreignEntry = entry({ variant_id: providerAnnotationsVariantId('prov-9') })
    const result = await revertEditHistoryEntry({
      entry: foreignEntry,
      history: [foreignEntry],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    expect(result.reverted).toBe(false)
    if (!result.reverted) expect(result.reason).toBe('rbac')
    // Nothing was applied to the session stack.
    expect(useEditHistoryStore.getState().canUndo).toBe(false)
  })
})

describe('revertEditHistoryEntry — restore semantics', () => {
  it('restores to base (removes the override) when the entry is the first edit', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    // The store currently has the material override applied.
    useCanonicalSceneStore.getState().setOverrides([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile-anthracite' } },
    ])
    const e = entry()
    const result = await revertEditHistoryEntry({
      entry: e,
      history: [e],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    expect(result.reverted).toBe(true)
    // The override was removed — the pair is back to base state.
    expect(
      useCanonicalSceneStore
        .getState()
        .overrides.find((o) => o.base_node_id === 'obj-1' && o.variant_id === VARIANT),
    ).toBeUndefined()
  })

  it('restores the predecessor delta when an earlier edit exists', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    useCanonicalSceneStore.getState().setOverrides([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile-anthracite' } },
    ])
    const older = entry({
      created_at: '2026-05-20T09:00:00.000Z',
      override_fields: { material_id: 'paint-white' },
    })
    const newer = entry({
      created_at: '2026-05-20T10:00:00.000Z',
      override_fields: { material_id: 'tile-anthracite' },
    })
    const result = await revertEditHistoryEntry({
      entry: newer,
      history: [older, newer],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    expect(result.reverted).toBe(true)
    // The pair is restored to the OLDER edit's material.
    const restored = useCanonicalSceneStore
      .getState()
      .overrides.find((o) => o.base_node_id === 'obj-1' && o.variant_id === VARIANT)
    expect(restored?.override_fields.material_id).toBe('paint-white')
  })

  it('restores the same-millisecond predecessor via seq, not base state (F6)', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    useCanonicalSceneStore.getState().setOverrides([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile-anthracite' } },
    ])
    // Two edits on the SAME pair with an IDENTICAL created_at — only `seq`
    // orders them. created_at-only logic would skip the predecessor and
    // wrongly revert `newer` to base state, losing the `paint-white` edit.
    const SAME_MS = '2026-05-20T10:00:00.000Z'
    const older = entry({
      seq: 1,
      created_at: SAME_MS,
      override_fields: { material_id: 'paint-white' },
    })
    const newer = entry({
      seq: 2,
      created_at: SAME_MS,
      override_fields: { material_id: 'tile-anthracite' },
    })
    const result = await revertEditHistoryEntry({
      entry: newer,
      history: [older, newer],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    expect(result.reverted).toBe(true)
    const restored = useCanonicalSceneStore
      .getState()
      .overrides.find((o) => o.base_node_id === 'obj-1' && o.variant_id === VARIANT)
    // The predecessor was found via seq — restored to `paint-white`, NOT base.
    expect(restored?.override_fields.material_id).toBe('paint-white')
  })

  it('persists a command=restore row for the revert', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    const e = entry()
    await revertEditHistoryEntry({
      entry: e,
      history: [e],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    const rows = await repo.list(SCENE)
    expect(rows).toHaveLength(1)
    expect(rows[0].command).toBe('restore')
    // The audit semantic_op stays faithful to the reverted operation.
    expect(rows[0].semantic_op).toBe('set_material')
  })

  it('the revert is itself undoable — it pushes onto the session stack', async () => {
    const repo = new InMemorySpatialEditHistoryRepository()
    const e = entry()
    await revertEditHistoryEntry({
      entry: e,
      history: [e],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: repo,
    })
    // The reverter does NOT pop the stack — it pushes a new (undoable) command.
    expect(useEditHistoryStore.getState().canUndo).toBe(true)
  })
})

describe('revertEditHistoryEntry — persistence failure', () => {
  it('keeps the local revert applied when the audit append fails', async () => {
    const failingRepo: SpatialEditHistoryRepository = {
      append: () => Promise.reject(new Error('audit down')),
      list: () => Promise.resolve([]),
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useCanonicalSceneStore.getState().setOverrides([
      { base_node_id: 'obj-1', variant_id: VARIANT, override_fields: { material_id: 'tile-anthracite' } },
    ])
    const e = entry()
    const result = await revertEditHistoryEntry({
      entry: e,
      history: [e],
      user: CUSTOMER,
      scene: SCENE_CTX,
      repository: failingRepo,
    })
    // Reverted locally; persistence failed — but the revert stands.
    expect(result.reverted).toBe(true)
    if (result.reverted) expect(result.persisted).toBe(false)
    expect(
      useCanonicalSceneStore
        .getState()
        .overrides.find((o) => o.base_node_id === 'obj-1'),
    ).toBeUndefined()
  })
})
