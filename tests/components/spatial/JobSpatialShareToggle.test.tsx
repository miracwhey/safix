// @vitest-environment jsdom
/**
 * Tests for {@link JobSpatialShareToggle} (Block 2).
 *
 * Covers the 4 acceptance cases from the Block-2 handover:
 *   - renders the Privat-State for an unshared scan,
 *   - renders the Geteilt-State + sharedAt-Timestamp for a shared scan,
 *   - opens the Confirm-Dialog on the first share per job and Cancel closes
 *     it without calling the mutation,
 *   - Confirm runs the mutation, sets the per-job localStorage flag, and a
 *     follow-up unshare/re-share skips the dialog.
 *
 * Additionally a 5th case covers D5 (Empty-State): when `scan === null` the
 * card stays mounted with a disabled button + hint.
 *
 * The useShareScanWithCustomer hook is fully mocked so the test exercises
 * UI behaviour without touching the repo / workflow path (those have their
 * own suites in `tests/lib/spatial/...`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// localStorage shim — the local vitest env exposes a partial `window.localStorage`
// without functional `getItem`/`setItem`. Stub a complete in-memory implementation
// on both `globalThis.localStorage` AND `window.localStorage` so the component
// path AND the test assertions both see the same store.
const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => {
      store[k] = v
    },
    removeItem: (k: string): void => {
      delete store[k]
    },
    clear: (): void => {
      store = {}
    },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length
    },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: memoryStorage,
    writable: true,
    configurable: true,
  })
}

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
const hapticsSpies = { selection: vi.fn(), success: vi.fn(), error: vi.fn() }

vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/hooks/useHaptics', () => ({ useHaptics: () => hapticsSpies }))

const toggleMock = vi.fn()
vi.mock('../../../src/lib/spatial/hooks/useShareScanWithCustomer', () => ({
  useShareScanWithCustomer: () => ({
    toggle: (...args: unknown[]) => toggleMock(...args),
    busy: false,
    error: null,
    resetError: () => {},
  }),
}))

import { JobSpatialShareToggle } from '../../../src/components/spatial/provider/JobSpatialShareToggle'
import type { Scan } from '../../../src/lib/spatial/types'

const JOB_ID = 'job-share-1'
const SCAN_ID = 'scan-share-1'

function baseScan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: SCAN_ID,
    jobId: JOB_ID,
    projectId: null,
    presalesProjectId: null,
    parentScanId: null,
    status: 'captured',
    source: 'roomplan',
    capturedBy: 'hw_1',
    deviceMeta: {},
    scanStartedAt: null,
    scanEndedAt: null,
    archivedAt: null,
    ownerType: 'craftsman',
    sharedWithCustomer: false,
    sharedAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  Object.values(toastSpies).forEach((s) => s.mockReset())
  Object.values(hapticsSpies).forEach((s) => s.mockReset())
  toggleMock.mockReset()
  memoryStorage.clear()
})

afterEach(cleanup)

describe('JobSpatialShareToggle', () => {
  it('renders the Privat-State for an unshared scan', () => {
    render(
      <JobSpatialShareToggle
        scan={baseScan()}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )
    expect(screen.getByText('Privat')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Mit Kundin teilen/ })).toBeTruthy()
  })

  it('renders the Geteilt-State + sharedAt-Timestamp for a shared scan', () => {
    const shared = baseScan({
      sharedWithCustomer: true,
      // 12.05.2026 14:30 local — formatted by Intl below.
      sharedAt: new Date('2026-05-12T12:30:00Z').getTime(),
    })
    render(
      <JobSpatialShareToggle scan={shared} jobId={JOB_ID} customerLabel="Maria" />,
    )
    expect(screen.getByText('Mit Kundin geteilt')).toBeTruthy()
    expect(screen.getByText(/Freigegeben am/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Freigabe zurückziehen/ }),
    ).toBeTruthy()
  })

  it('opens the Confirm-Dialog on the first share and Cancel closes it without calling the mutation', () => {
    render(
      <JobSpatialShareToggle
        scan={baseScan()}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /Mit Kundin teilen/ }),
    )
    expect(screen.getByRole('dialog', { name: /Aufmaß freigeben/ })).toBeTruthy()
    expect(toggleMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
    expect(screen.queryByRole('dialog', { name: /Aufmaß freigeben/ })).toBeNull()
    expect(toggleMock).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('spatial-share-confirmed:' + JOB_ID)).toBeNull()
  })

  it('Confirm runs the mutation, sets the per-job flag, and subsequent shares skip the dialog (D3)', async () => {
    toggleMock.mockResolvedValue({
      ok: true,
      scan: baseScan({ sharedWithCustomer: true, sharedAt: Date.now() }),
      changed: true,
    })
    const { rerender } = render(
      <JobSpatialShareToggle
        scan={baseScan()}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Mit Kundin teilen/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Freigeben' }))

    await waitFor(() => {
      expect(toggleMock).toHaveBeenCalledWith({ scanId: SCAN_ID, value: true })
    })
    expect(window.localStorage.getItem('spatial-share-confirmed:' + JOB_ID)).toBe('1')
    expect(toastSpies.info).toHaveBeenCalledWith(
      'Aufmaß ist jetzt für die Kundin sichtbar.',
    )

    // Now simulate the workflow path completing + customer screen state
    // updating. Re-render with the now-shared scan and trigger UNshare →
    // SHARE again — both should skip the dialog.
    rerender(
      <JobSpatialShareToggle
        scan={baseScan({ sharedWithCustomer: true, sharedAt: Date.now() })}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )
    toggleMock.mockReset()
    toggleMock.mockResolvedValue({
      ok: true,
      scan: baseScan({ sharedWithCustomer: false, sharedAt: null }),
      changed: true,
    })
    fireEvent.click(screen.getByRole('button', { name: /Freigabe zurückziehen/ }))
    await waitFor(() => {
      expect(toggleMock).toHaveBeenCalledWith({ scanId: SCAN_ID, value: false })
    })
    // No dialog opened (unshare path).
    expect(screen.queryByRole('dialog')).toBeNull()

    // Re-share — flag set, must skip the dialog.
    rerender(
      <JobSpatialShareToggle
        scan={baseScan()}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )
    toggleMock.mockReset()
    toggleMock.mockResolvedValue({
      ok: true,
      scan: baseScan({ sharedWithCustomer: true, sharedAt: Date.now() }),
      changed: true,
    })
    fireEvent.click(screen.getByRole('button', { name: /Mit Kundin teilen/ }))
    // dialog should NOT appear — directly fires toggle
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => {
      expect(toggleMock).toHaveBeenCalledWith({ scanId: SCAN_ID, value: true })
    })
  })

  it('renders the disabled empty-state when scan is null (D5 · Discoverability)', () => {
    render(
      <JobSpatialShareToggle scan={null} jobId={JOB_ID} customerLabel="Maria" />,
    )
    expect(screen.getByText('Noch kein Aufmaß')).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Aufmaß fehlt/ })
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces a workflow error via toast and does not write the localStorage flag', async () => {
    toggleMock.mockResolvedValue({
      ok: false,
      reason: 'persistence_failed',
      message: 'supabase 500',
    })
    render(
      <JobSpatialShareToggle
        scan={baseScan()}
        jobId={JOB_ID}
        customerLabel="Maria"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Mit Kundin teilen/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Freigeben' }))
    await waitFor(() => {
      expect(toggleMock).toHaveBeenCalled()
    })
    expect(toastSpies.error).toHaveBeenCalledWith('supabase 500')
    expect(window.localStorage.getItem('spatial-share-confirmed:' + JOB_ID)).toBeNull()
  })
})
