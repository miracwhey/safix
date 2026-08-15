/**
 * Path A / Path B Hardening Tests
 *
 * Validates that the two customer entry flows remain clearly separated:
 *
 * PATH A (invited / provider-directed):
 *   - Business-first: find exact business, then create project
 *   - Uses: searching_provider, provider_selected steps
 *   - Stores selectedProviderId
 *
 * PATH B (self_found / project-directed):
 *   - Project-first: create project, then discover providers
 *   - Uses: matching_ready, request_ready steps
 *   - Does NOT store selectedProviderId
 *
 * Hardening rules:
 *   - Path A transitions must not work when on Path B
 *   - Path B transitions must not work when on Path A
 *   - Reload must preserve path identity
 *   - Corrupted cache must not cross-contaminate paths
 *   - hydrateFromProfile validates path/step consistency
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Profile mock
// ---------------------------------------------------------------------------

const mockSaveGuidedEntryState = vi.fn().mockResolvedValue(undefined)

vi.mock('../../src/lib/profile', () => ({
  saveGuidedEntryState: (...args: unknown[]) => mockSaveGuidedEntryState(...args),
}))

function setupLocalStorage() {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() { return store.size },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}

beforeEach(() => {
  vi.resetModules()
  mockSaveGuidedEntryState.mockClear()
  mockSaveGuidedEntryState.mockResolvedValue(undefined)
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadModule() {
  return import('../../src/lib/customerEntry/guidedEntryState')
}

// ---------------------------------------------------------------------------
// Path guard enforcement
// ---------------------------------------------------------------------------

describe('Path A / Path B cross-transition guards', () => {
  it('startProviderSearch is rejected when on Path B (self_found)', async () => {
    const m = await loadModule()
    await m.chooseSelfFoundPath()
    expect(m.getGuidedEntryState().path).toBe('self_found')

    const ok = await m.startProviderSearch()
    expect(ok).toBe(false)
    // Step must NOT have changed
    expect(m.getGuidedEntryState().step).toBe('self_found')
  })

  it('selectProvider is rejected when on Path B (self_found)', async () => {
    const m = await loadModule()
    await m.chooseSelfFoundPath()

    const ok = await m.selectProvider('some-provider')
    expect(ok).toBe(false)
    expect(m.getGuidedEntryState().step).toBe('self_found')
    expect(m.getGuidedEntryState().selectedProviderId).toBeNull()
  })

  it('markMatchingReady is rejected when on Path A (invited)', async () => {
    const m = await loadModule()
    await m.chooseInvitedPath()
    await m.startProviderSearch()
    await m.selectProvider('prov-1')
    await m.markProjectNeeded()
    await m.markProjectCreated('proj-1')

    const ok = await m.markMatchingReady()
    expect(ok).toBe(false)
    // Step must NOT have changed to matching_ready
    expect(m.getGuidedEntryState().step).toBe('project_created')
  })

  it('startProviderSearch is rejected when path is null (initial state)', async () => {
    const m = await loadModule()
    expect(m.getGuidedEntryState().path).toBeNull()

    const ok = await m.startProviderSearch()
    expect(ok).toBe(false)
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('markMatchingReady is rejected when path is null (initial state)', async () => {
    const m = await loadModule()
    const ok = await m.markMatchingReady()
    expect(ok).toBe(false)
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('Path A transitions still work correctly on invited path', async () => {
    const m = await loadModule()
    await m.chooseInvitedPath()

    const ok1 = await m.startProviderSearch()
    expect(ok1).toBe(true)
    expect(m.getGuidedEntryState().step).toBe('searching_provider')

    const ok2 = await m.selectProvider('prov-abc')
    expect(ok2).toBe(true)
    expect(m.getGuidedEntryState().step).toBe('provider_selected')
    expect(m.getGuidedEntryState().selectedProviderId).toBe('prov-abc')
  })

  it('Path B transitions still work correctly on self_found path', async () => {
    const m = await loadModule()
    await m.chooseSelfFoundPath()
    await m.markProjectNeeded()
    await m.markProjectCreated('proj-1')

    const ok = await m.markMatchingReady()
    expect(ok).toBe(true)
    expect(m.getGuidedEntryState().step).toBe('matching_ready')
  })

  it('shared transitions (markProjectNeeded, markProjectCreated) work on both paths', async () => {
    // Path A
    const m1 = await loadModule()
    await m1.chooseInvitedPath()
    await m1.startProviderSearch()
    await m1.selectProvider('prov-1')
    const okA = await m1.markProjectNeeded()
    expect(okA).toBe(true)
    const okA2 = await m1.markProjectCreated('proj-a')
    expect(okA2).toBe(true)

    // Reset for Path B
    vi.resetModules()
    setupLocalStorage()

    const m2 = await loadModule()
    await m2.chooseSelfFoundPath()
    const okB = await m2.markProjectNeeded()
    expect(okB).toBe(true)
    const okB2 = await m2.markProjectCreated('proj-b')
    expect(okB2).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Path reload preservation
// ---------------------------------------------------------------------------

describe('Path identity preserved after reload', () => {
  it('Path A state survives localStorage cache reload', async () => {
    const m1 = await loadModule()
    await m1.chooseInvitedPath()
    await m1.startProviderSearch()
    await m1.selectProvider('business-xyz')

    // Simulate reload
    vi.resetModules()
    const m2 = await loadModule()
    const s = m2.getGuidedEntryState()
    expect(s.path).toBe('invited')
    expect(s.step).toBe('provider_selected')
    expect(s.selectedProviderId).toBe('business-xyz')
  })

  it('Path B state survives localStorage cache reload', async () => {
    const m1 = await loadModule()
    await m1.chooseSelfFoundPath()
    await m1.markProjectNeeded()
    await m1.markProjectCreated('proj-reload')

    // Simulate reload
    vi.resetModules()
    const m2 = await loadModule()
    const s = m2.getGuidedEntryState()
    expect(s.path).toBe('self_found')
    expect(s.step).toBe('project_created')
    expect(s.projectId).toBe('proj-reload')
  })

  it('hydrateFromProfile overwrites cache with server truth', async () => {
    const m = await loadModule()
    // Start on Path A locally
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryState().path).toBe('invited')

    // Server says user is on Path B (canonical truth)
    m.hydrateFromProfile({
      step: 'project_created',
      path: 'self_found',
      selectedProviderId: null,
      projectId: 'server-proj',
    })

    const s = m.getGuidedEntryState()
    expect(s.path).toBe('self_found')
    expect(s.step).toBe('project_created')
    expect(s.projectId).toBe('server-proj')
  })
})

// ---------------------------------------------------------------------------
// Cache corruption hardening
// ---------------------------------------------------------------------------

describe('corrupted guided-entry cache hardening', () => {
  it('invalid step in cache is reset to initial', async () => {
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'FAKE_STEP',
      path: 'invited',
      selectedProviderId: null,
      projectId: null,
    }))
    const m = await loadModule()
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('invalid path in cache with past-initial step is reset to initial', async () => {
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'searching_provider',
      path: 'FAKE_PATH',
      selectedProviderId: null,
      projectId: null,
    }))
    const m = await loadModule()
    expect(m.getGuidedEntryState().step).toBe('initial')
    expect(m.getGuidedEntryState().path).toBeNull()
  })

  it('step needing path but path missing is reset to initial', async () => {
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'provider_selected',
      path: null,
      selectedProviderId: 'prov-1',
      projectId: null,
    }))
    const m = await loadModule()
    expect(m.getGuidedEntryState().step).toBe('initial')
    expect(m.getGuidedEntryState().selectedProviderId).toBeNull()
  })

  it('non-string selectedProviderId in cache is sanitized to null', async () => {
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'invited',
      path: 'invited',
      selectedProviderId: 12345,
      projectId: null,
    }))
    const m = await loadModule()
    expect(m.getGuidedEntryState().selectedProviderId).toBeNull()
  })

  it('non-string projectId in cache is sanitized to null', async () => {
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({
      step: 'self_found',
      path: 'self_found',
      selectedProviderId: null,
      projectId: { id: 'fake' },
    }))
    const m = await loadModule()
    expect(m.getGuidedEntryState().projectId).toBeNull()
  })

  it('hydrateFromProfile with invalid step resets to initial', async () => {
    const m = await loadModule()
    m.hydrateFromProfile({
      step: 'UNKNOWN_STEP' as never,
      path: 'invited',
      selectedProviderId: null,
      projectId: null,
    })
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('hydrateFromProfile with incoherent step/path resets to initial', async () => {
    const m = await loadModule()
    m.hydrateFromProfile({
      step: 'searching_provider',
      path: null,  // step needs a path but path is null
      selectedProviderId: null,
      projectId: null,
    })
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('initial and completed steps do not require a path', async () => {
    const m = await loadModule()
    // 'initial' should work without a path
    m.hydrateFromProfile({
      step: 'initial',
      path: null,
      selectedProviderId: null,
      projectId: null,
    })
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('completed step does not require a path', async () => {
    const m = await loadModule()
    m.hydrateFromProfile({
      step: 'completed',
      path: null,
      selectedProviderId: null,
      projectId: null,
    })
    // completed without a path: 'completed' is not in NEEDS_PATH
    expect(m.getGuidedEntryState().step).toBe('completed')
  })
})
