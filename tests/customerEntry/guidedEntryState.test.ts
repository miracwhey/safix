import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock the profile module to capture Supabase writes
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

describe('guided entry state machine', () => {
  it('starts in initial state', async () => {
    const m = await loadModule()
    const s = m.getGuidedEntryState()
    expect(s.step).toBe('initial')
    expect(s.path).toBeNull()
    expect(s.selectedProviderId).toBeNull()
    expect(s.projectId).toBeNull()
  })

  it('chooseInvitedPath sets step and path after confirmed write', async () => {
    const m = await loadModule()
    const ok = await m.chooseInvitedPath()
    expect(ok).toBe(true)
    const s = m.getGuidedEntryState()
    expect(s.step).toBe('invited')
    expect(s.path).toBe('invited')
  })

  it('chooseSelfFoundPath sets step and path after confirmed write', async () => {
    const m = await loadModule()
    const ok = await m.chooseSelfFoundPath()
    expect(ok).toBe(true)
    const s = m.getGuidedEntryState()
    expect(s.step).toBe('self_found')
    expect(s.path).toBe('self_found')
  })

  it('invited path transitions: invited → searching → provider_selected → project_needed → project_created → completed', async () => {
    const m = await loadModule()
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryState().step).toBe('invited')

    await m.startProviderSearch()
    expect(m.getGuidedEntryState().step).toBe('searching_provider')

    await m.selectProvider('prov-1')
    expect(m.getGuidedEntryState().step).toBe('provider_selected')
    expect(m.getGuidedEntryState().selectedProviderId).toBe('prov-1')

    await m.markProjectNeeded()
    expect(m.getGuidedEntryState().step).toBe('project_needed')

    await m.markProjectCreated('proj-1')
    expect(m.getGuidedEntryState().step).toBe('project_created')
    expect(m.getGuidedEntryState().projectId).toBe('proj-1')

    await m.completeGuidedEntry()
    expect(m.getGuidedEntryState().step).toBe('completed')
  })

  it('self-found path transitions: self_found → project_needed → project_created → matching_ready → request_ready → completed', async () => {
    const m = await loadModule()
    await m.chooseSelfFoundPath()
    expect(m.getGuidedEntryState().step).toBe('self_found')

    await m.markProjectNeeded()
    expect(m.getGuidedEntryState().step).toBe('project_needed')

    await m.markProjectCreated('proj-2')
    expect(m.getGuidedEntryState().step).toBe('project_created')
    expect(m.getGuidedEntryState().projectId).toBe('proj-2')

    await m.markMatchingReady()
    expect(m.getGuidedEntryState().step).toBe('matching_ready')

    await m.markRequestReady()
    expect(m.getGuidedEntryState().step).toBe('request_ready')

    await m.completeGuidedEntry()
    expect(m.getGuidedEntryState().step).toBe('completed')
  })

  it('persists state to localStorage cache and survives module reload', async () => {
    const m1 = await loadModule()
    await m1.chooseInvitedPath()
    await m1.startProviderSearch()
    await m1.selectProvider('prov-99')

    // Verify localStorage cache has data
    const raw = localStorage.getItem('fixup.guided-entry.v1')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.step).toBe('provider_selected')
    expect(parsed.selectedProviderId).toBe('prov-99')

    // Reset modules and reload — simulates app reload from cache
    vi.resetModules()
    const m2 = await loadModule()
    const s = m2.getGuidedEntryState()
    expect(s.step).toBe('provider_selected')
    expect(s.path).toBe('invited')
    expect(s.selectedProviderId).toBe('prov-99')
  })

  it('resetGuidedEntry clears state and localStorage cache', async () => {
    const m = await loadModule()
    await m.chooseSelfFoundPath()
    await m.markProjectCreated('proj-clear')
    expect(m.getGuidedEntryState().step).toBe('project_created')

    m.resetGuidedEntry()
    expect(m.getGuidedEntryState().step).toBe('initial')
    expect(m.getGuidedEntryState().path).toBeNull()
    expect(m.getGuidedEntryState().projectId).toBeNull()
    expect(localStorage.getItem('fixup.guided-entry.v1')).toBeNull()
  })

  it('notifies subscribers on state change', async () => {
    const m = await loadModule()
    const listener = vi.fn()
    const unsub = m.subscribeGuidedEntry(listener)

    await m.chooseInvitedPath()
    // saving=true notification + saving=false+committed notification
    expect(listener).toHaveBeenCalledTimes(2)

    await m.startProviderSearch()
    expect(listener).toHaveBeenCalledTimes(4) // +2 for next transition

    unsub()
    await m.selectProvider('prov-x')
    expect(listener).toHaveBeenCalledTimes(4) // not called after unsub
  })

  it('handles corrupted localStorage gracefully', async () => {
    localStorage.setItem('fixup.guided-entry.v1', 'not-json!!!')
    const m = await loadModule()
    expect(m.getGuidedEntryState().step).toBe('initial')
  })

  it('handles partial localStorage data gracefully — incoherent step/path resets to initial', async () => {
    // step='self_found' requires path='self_found'; without it, state is
    // incoherent and must reset to initial (hardening).
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({ step: 'self_found' }))
    vi.resetModules()
    const m = await loadModule()
    const s = m.getGuidedEntryState()
    expect(s.step).toBe('initial')
    expect(s.path).toBeNull()
    expect(s.projectId).toBeNull()
  })

  it('handles partial localStorage with consistent step/path gracefully', async () => {
    // step='self_found' with matching path='self_found' is valid
    localStorage.setItem('fixup.guided-entry.v1', JSON.stringify({ step: 'self_found', path: 'self_found' }))
    vi.resetModules()
    const m = await loadModule()
    const s = m.getGuidedEntryState()
    expect(s.step).toBe('self_found')
    expect(s.path).toBe('self_found')
    expect(s.projectId).toBeNull()
  })

  it('writes to Supabase (via profile) on every state transition', async () => {
    const m = await loadModule()
    await m.chooseInvitedPath()

    expect(mockSaveGuidedEntryState).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'invited', path: 'invited' }),
    )
  })

  it('hydrateFromProfile overwrites local state with server state', async () => {
    const m = await loadModule()
    // Start with local cache
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryState().step).toBe('invited')

    // Simulate Supabase returning a different state (server is canonical)
    const serverState = {
      step: 'project_created' as const,
      path: 'self_found' as const,
      selectedProviderId: null,
      projectId: 'server-proj-1',
    }
    m.hydrateFromProfile(serverState)

    const s = m.getGuidedEntryState()
    expect(s.step).toBe('project_created')
    expect(s.path).toBe('self_found')
    expect(s.projectId).toBe('server-proj-1')

    // localStorage cache should be updated too
    const raw = localStorage.getItem('fixup.guided-entry.v1')
    expect(raw).toBeTruthy()
    const cached = JSON.parse(raw!)
    expect(cached.step).toBe('project_created')
  })

  it('hydrateFromProfile with null resets to initial', async () => {
    const m = await loadModule()
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryState().step).toBe('invited')

    m.hydrateFromProfile(null)
    expect(m.getGuidedEntryState().step).toBe('initial')
    expect(m.getGuidedEntryState().path).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Persistence-hardening tests
// ---------------------------------------------------------------------------

describe('guided entry persistence hardening', () => {
  it('failed Supabase write does NOT commit state and surfaces error', async () => {
    mockSaveGuidedEntryState.mockRejectedValueOnce(new Error('Network error'))

    const m = await loadModule()
    expect(m.getGuidedEntryState().step).toBe('initial')

    const ok = await m.chooseInvitedPath()
    expect(ok).toBe(false)

    // State must NOT have advanced
    expect(m.getGuidedEntryState().step).toBe('initial')
    expect(m.getGuidedEntryState().path).toBeNull()

    // Error must be surfaced in status
    const st = m.getGuidedEntryStatus()
    expect(st.saving).toBe(false)
    expect(st.error).toBe('Network error')

    // localStorage must NOT have the failed state
    const raw = localStorage.getItem('fixup.guided-entry.v1')
    if (raw) {
      expect(JSON.parse(raw).step).toBe('initial')
    }
  })

  it('saving status is true during write and false after', async () => {
    let resolveWrite: () => void = () => {}
    mockSaveGuidedEntryState.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveWrite = resolve }),
    )

    const m = await loadModule()

    const promise = m.chooseInvitedPath()

    // After initiating, saving should be true (set synchronously in transitionTo)
    expect(m.getGuidedEntryStatus().saving).toBe(true)

    // Yield one microtask so doWrite starts and calls the mock (assigning resolveWrite).
    // Execution order: transitionTo() sets saving=true synchronously, then
    // _writeChain.then(doWrite) schedules doWrite as a microtask.  After this
    // yield, doWrite runs and calls saveGuidedEntryState (the mock), which
    // creates a pending promise and assigns its resolve to resolveWrite.
    await Promise.resolve()

    // Complete the write
    resolveWrite()
    await promise

    expect(m.getGuidedEntryStatus().saving).toBe(false)
    expect(m.getGuidedEntryStatus().error).toBeNull()
    expect(m.getGuidedEntryState().step).toBe('invited')
  })

  it('clearGuidedEntryError dismisses the error', async () => {
    mockSaveGuidedEntryState.mockRejectedValueOnce(new Error('Timeout'))

    const m = await loadModule()
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryStatus().error).toBe('Timeout')

    m.clearGuidedEntryError()
    expect(m.getGuidedEntryStatus().error).toBeNull()
  })

  it('retry after failure works when second write succeeds', async () => {
    mockSaveGuidedEntryState.mockRejectedValueOnce(new Error('First fail'))

    const m = await loadModule()
    const ok1 = await m.chooseInvitedPath()
    expect(ok1).toBe(false)
    expect(m.getGuidedEntryState().step).toBe('initial')

    // Retry — mock resolves this time
    mockSaveGuidedEntryState.mockResolvedValueOnce(undefined)
    const ok2 = await m.chooseInvitedPath()
    expect(ok2).toBe(true)
    expect(m.getGuidedEntryState().step).toBe('invited')
    expect(m.getGuidedEntryStatus().error).toBeNull()
  })

  it('consecutive transitions are serialized and do not corrupt state', async () => {
    const m = await loadModule()

    // Fire two fully-specified transitions without awaiting the first.
    // Both start from initial state — the second should win since it runs
    // after the first completes (serialized chain).
    const p1 = m.chooseInvitedPath()
    const p2 = m.chooseSelfFoundPath()

    const [ok1, ok2] = await Promise.all([p1, p2])
    expect(ok1).toBe(true)
    expect(ok2).toBe(true)

    // The second transition wins
    expect(m.getGuidedEntryState().step).toBe('self_found')
    expect(m.getGuidedEntryState().path).toBe('self_found')

    // saveGuidedEntryState should have been called twice in order
    expect(mockSaveGuidedEntryState).toHaveBeenCalledTimes(2)
    expect(mockSaveGuidedEntryState).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ step: 'invited' }),
    )
    expect(mockSaveGuidedEntryState).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ step: 'self_found' }),
    )
  })

  it('hydrateFromProfile clears saving/error status', async () => {
    mockSaveGuidedEntryState.mockRejectedValueOnce(new Error('fail'))
    const m = await loadModule()
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryStatus().error).toBe('fail')

    // Hydration from server should clear the error
    m.hydrateFromProfile({ step: 'self_found', path: 'self_found', selectedProviderId: null, projectId: null })
    expect(m.getGuidedEntryStatus().error).toBeNull()
    expect(m.getGuidedEntryStatus().saving).toBe(false)
  })

  it('resetGuidedEntry clears saving/error status', async () => {
    mockSaveGuidedEntryState.mockRejectedValueOnce(new Error('fail'))
    const m = await loadModule()
    await m.chooseInvitedPath()
    expect(m.getGuidedEntryStatus().error).toBe('fail')

    m.resetGuidedEntry()
    expect(m.getGuidedEntryStatus().error).toBeNull()
    expect(m.getGuidedEntryStatus().saving).toBe(false)
    expect(m.getGuidedEntryState().step).toBe('initial')
  })
})
