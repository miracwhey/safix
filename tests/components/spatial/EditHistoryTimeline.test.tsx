// @vitest-environment jsdom
/**
 * Render tests for the Block-2.14 `EditHistoryTimeline`.
 *
 * Covers:
 *   - the timeline loads history through the repository and lists rows
 *     newest-first with German semantic labels,
 *   - an empty history shows the empty state,
 *   - a load error shows the error state + retry,
 *   - the "Wiederherstellen" action triggers the reverter and reloads,
 *   - the revert action is disabled for a variant the user cannot write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
  },
}))

import { EditHistoryTimeline } from '../../../src/components/spatial/edit/EditHistoryTimeline'
import { InMemorySpatialEditHistoryRepository } from '../../../src/lib/spatial/canonical/repository/editHistoryRepository'
import type { SpatialEditHistoryRepository } from '../../../src/lib/spatial/canonical/repository/editHistoryRepository'
import { useCanonicalSceneStore } from '../../../src/lib/spatial/canonical/store/sceneStore'
import { useEditHistoryStore } from '../../../src/lib/spatial/canonical/store/editHistoryStore'
import {
  STANDARD_VARIANTS,
  providerAnnotationsVariantId,
  type Variant,
} from '../../../src/lib/spatial/canonical/types/variants'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
} from '../../helpers/mockSession'

const SCENE = 'scene-1'
const PROVIDER = 'prov-9'

const VARIANTS: Variant[] = [
  { id: STANDARD_VARIANTS.BASE_ROOMPLAN, display_name: 'Scan', is_default: true },
  { id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS, display_name: 'Kunden-Korrekturen', is_default: false },
  { id: providerAnnotationsVariantId(PROVIDER), display_name: 'Handwerker', is_default: false },
]

/** Seed the InMemory repo with a small history (customer + provider rows). */
async function seedRepo(): Promise<InMemorySpatialEditHistoryRepository> {
  const repo = new InMemorySpatialEditHistoryRepository({ actorIdProvider: () => 'cust-1' })
  await repo.append({
    scene_id: SCENE,
    rows: [
      {
        variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
        base_node_id: 'wall-1',
        override_fields: { height_m: 2.6 },
        command: 'set',
        semantic_op: 'resize_wall',
      },
    ],
  })
  await repo.append({
    scene_id: SCENE,
    rows: [
      {
        variant_id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
        base_node_id: 'obj-1',
        override_fields: { material_id: 'tile' },
        command: 'set',
        semantic_op: 'set_material',
      },
    ],
  })
  return repo
}

beforeEach(() => {
  cleanup()
  resetMockSession()
  Object.values(toastSpies).forEach((s) => s.mockReset())
  useCanonicalSceneStore.getState().setScene(null)
  useCanonicalSceneStore.getState().setOverrides([])
  useCanonicalSceneStore.getState().setVariants(VARIANTS)
  useEditHistoryStore.getState().clear()
})
afterEach(cleanup)

describe('EditHistoryTimeline — listing', () => {
  it('lists history rows newest-first with German labels', async () => {
    installMockSession(mockCustomerSession('cust-1'))
    const repo = await seedRepo()
    render(<EditHistoryTimeline sceneId={SCENE} repository={repo} />)

    // The newest row (set_material) renders first.
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Material geändert')
    expect(rows[1].textContent).toContain('Wand angepasst')
  })

  it('shows the empty state for a scene with no history', async () => {
    installMockSession(mockCustomerSession('cust-1'))
    const repo = new InMemorySpatialEditHistoryRepository()
    render(<EditHistoryTimeline sceneId={SCENE} repository={repo} />)
    expect(await screen.findByText(/Noch keine Änderungen/)).toBeTruthy()
  })

  it('shows the error state when the repository rejects', async () => {
    installMockSession(mockCustomerSession('cust-1'))
    const failingRepo: SpatialEditHistoryRepository = {
      append: () => Promise.resolve([]),
      list: () => Promise.reject(new Error('load failed')),
    }
    render(<EditHistoryTimeline sceneId={SCENE} repository={failingRepo} />)
    expect(await screen.findByText('load failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeTruthy()
  })
})

describe('EditHistoryTimeline — reverter', () => {
  it('the revert action triggers the reverter and shows a success toast', async () => {
    installMockSession(mockCustomerSession('cust-1'))
    const repo = await seedRepo()
    render(<EditHistoryTimeline sceneId={SCENE} repository={repo} />)

    const revertBtn = (await screen.findAllByRole('button', { name: /wiederherstellen/i }))[0]
    fireEvent.click(revertBtn)

    await waitFor(() => expect(toastSpies.success).toHaveBeenCalled())
    // The reverter persisted a `restore` row — the history grew.
    await waitFor(async () => {
      expect(await repo.list(SCENE)).toHaveLength(3)
    })
  })

  it('disables the revert action for a variant the user cannot write', async () => {
    installMockSession(mockCustomerSession('cust-1'))
    // A history row on the PROVIDER's variant — a customer cannot revert it.
    const repo = new InMemorySpatialEditHistoryRepository()
    await repo.append({
      scene_id: SCENE,
      rows: [
        {
          variant_id: providerAnnotationsVariantId(PROVIDER),
          base_node_id: 'obj-2',
          override_fields: { material_id: 'wood' },
          command: 'set',
          semantic_op: 'set_material',
        },
      ],
    })
    render(<EditHistoryTimeline sceneId={SCENE} repository={repo} />)
    const revertBtn = await screen.findByRole('button', { name: /wiederherstellen/i })
    expect(revertBtn.hasAttribute('disabled')).toBe(true)
  })
})
