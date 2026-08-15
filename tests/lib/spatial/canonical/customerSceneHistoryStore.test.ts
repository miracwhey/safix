/**
 * Block L4.a — customerSceneHistoryStore (Customer-Hub Undo/Redo).
 *
 * Snapshot-Stack-Semantik: push(prev) legt einen Undo-Schritt an + leert Redo;
 * undo(current)/redo(current) verschieben Scenes zwischen past/future und geben
 * die wiederherzustellende Scene zurück. Cap kappt die ältesten Schritte.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  useCustomerSceneHistoryStore,
  CUSTOMER_UNDO_CAP,
} from '../../../../src/lib/spatial/canonical/store/customerSceneHistoryStore.ts'
import { makeRoom } from './__helpers__/sceneFactory.ts'

// Distinct scene identities — the store compares by reference, not value.
function scene(tag: string) {
  return makeRoom({ name: tag })
}

beforeEach(() => {
  useCustomerSceneHistoryStore.getState().reset()
})

describe('push', () => {
  it('records an undo step and flips canUndo', () => {
    const s = useCustomerSceneHistoryStore.getState()
    expect(s.canUndo).toBe(false)
    s.push(scene('a'))
    const after = useCustomerSceneHistoryStore.getState()
    expect(after.canUndo).toBe(true)
    expect(after.past).toHaveLength(1)
  })

  it('clears the redo branch on a fresh push', () => {
    const a = scene('a')
    const b = scene('b')
    const store = useCustomerSceneHistoryStore.getState()
    store.push(a)
    store.undo(b) // a in past → restore a, b onto future
    expect(useCustomerSceneHistoryStore.getState().canRedo).toBe(true)
    useCustomerSceneHistoryStore.getState().push(scene('c'))
    expect(useCustomerSceneHistoryStore.getState().canRedo).toBe(false)
    expect(useCustomerSceneHistoryStore.getState().future).toHaveLength(0)
  })
})

describe('undo / redo round-trip', () => {
  it('undo returns the previous scene, redo returns to current', () => {
    const a = scene('a')
    const b = scene('b')
    const store = useCustomerSceneHistoryStore.getState()
    // edit a→b: push(a) at commit time, live scene becomes b
    store.push(a)
    const restored = useCustomerSceneHistoryStore.getState().undo(b)
    expect(restored).toBe(a)
    // now live scene is a again; redo should hand back b
    const redone = useCustomerSceneHistoryStore.getState().redo(a)
    expect(redone).toBe(b)
  })

  it('undo on an empty stack returns null', () => {
    expect(useCustomerSceneHistoryStore.getState().undo(scene('x'))).toBeNull()
  })

  it('redo on an empty stack returns null', () => {
    expect(useCustomerSceneHistoryStore.getState().redo(scene('x'))).toBeNull()
  })

  it('multi-step: two edits undo in LIFO order', () => {
    const a = scene('a')
    const b = scene('b')
    const c = scene('c')
    const store = useCustomerSceneHistoryStore.getState()
    store.push(a) // a→b
    store.push(b) // b→c, live = c
    expect(useCustomerSceneHistoryStore.getState().undo(c)).toBe(b)
    expect(useCustomerSceneHistoryStore.getState().undo(b)).toBe(a)
    expect(useCustomerSceneHistoryStore.getState().canUndo).toBe(false)
  })
})

describe('cap', () => {
  it('drops the oldest step beyond CUSTOMER_UNDO_CAP', () => {
    const scenes = Array.from({ length: CUSTOMER_UNDO_CAP + 5 }, (_, i) => scene(`s${i}`))
    scenes.forEach((s) => useCustomerSceneHistoryStore.getState().push(s))
    expect(useCustomerSceneHistoryStore.getState().past).toHaveLength(CUSTOMER_UNDO_CAP)
    // The oldest 5 fell out — the remaining oldest is scenes[5].
    expect(useCustomerSceneHistoryStore.getState().past[0]).toBe(scenes[5])
  })
})

describe('reset', () => {
  it('wipes both stacks', () => {
    const store = useCustomerSceneHistoryStore.getState()
    store.push(scene('a'))
    store.undo(scene('b'))
    useCustomerSceneHistoryStore.getState().reset()
    const s = useCustomerSceneHistoryStore.getState()
    expect(s.past).toHaveLength(0)
    expect(s.future).toHaveLength(0)
    expect(s.canUndo).toBe(false)
    expect(s.canRedo).toBe(false)
  })
})
