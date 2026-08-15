// @vitest-environment jsdom
/**
 * ChangeOrderComposerScreen · Resume-Robustness Block 4 — draft persistence.
 *
 * Covers:
 *   • restore at mount: the persisted JSON object refills
 *     leistung/ursache/zeitauswirkung/priceInput WITHOUT submitting.
 *   • debounced write-through under `fixup.changeorder.draft.<jobId>`.
 *   • successful submit clears the draft before navigating to the detail
 *     route (clear ONLY on success — a failed submit keeps the draft).
 *
 * Rendered without JSX (.test.ts — vitest glob scopes .tsx to the spatial
 * tree) inside a createMemoryRouter (useBlocker requires a data router).
 * Mocked: jobs repo lookups (mock Job mirrors the real Job type), the
 * changeOrder workflow (network), useSession (full SessionState shape),
 * AppShell (layout chrome with nav/swipe hooks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { Job } from '../../src/lib/jobs/types'
import type { SessionState } from '../../src/lib/session'

// In-memory localStorage stub — same pattern as tests/hooks/useDraftPersistence.test.ts.
const memoryStorage = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string): string | null => (k in store ? store[k] : null),
    setItem: (k: string, v: string): void => { store[k] = v },
    removeItem: (k: string): void => { delete store[k] },
    clear: (): void => { store = {} },
    key: (i: number): string | null => Object.keys(store)[i] ?? null,
    get length(): number { return Object.keys(store).length },
  }
})()
vi.stubGlobal('localStorage', memoryStorage)
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: memoryStorage,
})

// Mock Job mirrors the real producer shape (lib/jobs/types.ts — all required
// fields present). jobKind stays undefined → legacy standard job, allowed.
const { mockJob } = vi.hoisted(() => {
  const mockJob = {
    id: 'job-1',
    projectId: 'project-1',
    title: 'Bad sanieren',
    customer: 'Kunde K.',
    location: 'Hannover',
    dateLabel: 'Heute',
    status: 'in_progress' as const,
    amount: '2.300 €',
    description: 'Komplettsanierung Bad',
    paymentState: 'in_escrow' as const,
    documentationStatus: 'Keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: 'cust-user-1',
    sourceOfferId: 'offer-1',
    sourceConversationId: 'conv-1',
  }
  return { mockJob }
})

vi.mock('../../src/lib/jobs', () => ({
  getJobById: vi.fn(() => mockJob),
  isJobRepositoryHydrated: vi.fn(() => true),
}))

vi.mock('../../src/lib/messages', () => ({
  // Not reached — mockJob.sourceConversationId short-circuits the lookup.
  getConversationByProjectId: vi.fn(() => undefined),
}))

vi.mock('../../src/lib/workflow', () => ({
  // Real producer returns Payment | undefined — undefined = no payment yet.
  getPaymentForJobWorkflow: vi.fn(() => undefined),
}))

vi.mock('../../src/lib/workflow/changeOrderWorkflow', () => ({
  createChangeOrderWorkflow: vi.fn(),
}))

// Full SessionState shape (lib/session.ts) — the screen reads user.id only.
vi.mock('../../src/hooks/useSession', () => ({
  useSession: (): SessionState => ({
    user: {
      id: 'hw-user-1',
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-01-01T00:00:00Z',
    } as SessionState['user'] & object,
    role: 'craftsman',
    craftsmanRole: 'owner',
    isOperator: false,
    tosAcceptedAt: '2026-01-01T00:00:00Z',
    loading: false,
    sessionValidated: true,
    error: null,
    errorKind: null,
  }),
}))

// Layout chrome only (BottomNav/useSwipeNavigation) — passthrough.
vi.mock('../../src/components/AppShell', () => ({
  default: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

import ChangeOrderComposerScreen from '../../src/screens/ChangeOrderComposerScreen'
import { createChangeOrderWorkflow } from '../../src/lib/workflow/changeOrderWorkflow'

// Satisfy the type the screen consumes; only fields it touches are realistic.
void (mockJob as unknown as Job)

const KEY = 'fixup.changeorder.draft.job-1'

function renderScreen() {
  const router = createMemoryRouter(
    [
      {
        path: '/craftsman/nachtrag/neu',
        element: createElement(ChangeOrderComposerScreen),
      },
      {
        path: '/craftsman/nachtrag/:changeOrderId',
        element: createElement('div', { 'data-testid': 'co-detail-route' }),
      },
      {
        path: '/craftsman/jobs/:jobId',
        element: createElement('div', { 'data-testid': 'job-detail-route' }),
      },
    ],
    { initialEntries: ['/craftsman/nachtrag/neu?jobId=job-1'] },
  )
  render(createElement(RouterProvider, { router }))
  return { router }
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`field ${id} not rendered`)
  return el as HTMLInputElement | HTMLTextAreaElement
}

describe('ChangeOrderComposerScreen draft persistence (Block 4)', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
    vi.mocked(createChangeOrderWorkflow).mockResolvedValue({
      id: 'co-1',
      jobId: 'job-1',
      craftsmanUserId: 'hw-user-1',
      customerUserId: 'cust-user-1',
      description: 'Mehrarbeit',
      price: '+450 €',
      grossTotal: 45000,
      status: 'pending',
    } as Awaited<ReturnType<typeof createChangeOrderWorkflow>>)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('restores a persisted draft into the form at mount — without submitting', () => {
    memoryStorage.setItem(
      KEY,
      JSON.stringify({
        leistung: 'Abdichtung 4 m²',
        ursache: 'Feuchtigkeitsschäden hinter Fliesen',
        zeitauswirkung: '+2 Werktage',
        priceInput: '450',
      }),
    )
    renderScreen()
    expect(field('co-leistung').value).toBe('Abdichtung 4 m²')
    expect(field('co-ursache').value).toBe('Feuchtigkeitsschäden hinter Fliesen')
    expect(field('co-zeit').value).toBe('+2 Werktage')
    expect(field('co-price').value).toBe('450')
    // Drafts must NEVER trigger a submit.
    expect(createChangeOrderWorkflow).not.toHaveBeenCalled()
  })

  it('persists typed fields as ONE JSON object keyed by job after the debounce', () => {
    renderScreen()
    fireEvent.change(field('co-leistung'), { target: { value: 'Mehrarbeit Rohre' } })
    fireEvent.change(field('co-price'), { target: { value: '300' } })
    expect(memoryStorage.getItem(KEY)).toBe(null)
    act(() => { vi.advanceTimersByTime(350) })
    expect(JSON.parse(memoryStorage.getItem(KEY)!)).toEqual({
      leistung: 'Mehrarbeit Rohre',
      ursache: '',
      zeitauswirkung: '',
      priceInput: '300',
    })
  })

  it('a successful submit clears the draft and navigates to the detail route', async () => {
    renderScreen()
    fireEvent.change(field('co-leistung'), { target: { value: 'Abdichtung' } })
    fireEvent.change(field('co-ursache'), { target: { value: 'Befund' } })
    fireEvent.change(field('co-price'), { target: { value: '450' } })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).not.toBe(null)

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-change-order'))
    })

    expect(createChangeOrderWorkflow).toHaveBeenCalledTimes(1)
    expect(createChangeOrderWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        craftsmanUserId: 'hw-user-1',
        customerUserId: 'cust-user-1',
        grossTotal: 45000,
        conversationId: 'conv-1',
      }),
    )
    expect(memoryStorage.getItem(KEY)).toBe(null)
    expect(screen.getByTestId('co-detail-route')).toBeTruthy()
    // No stale debounce may resurrect the cleared draft.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('a failed submit keeps the persisted draft (retry without re-typing)', async () => {
    vi.mocked(createChangeOrderWorkflow).mockRejectedValueOnce(new Error('network down'))
    renderScreen()
    fireEvent.change(field('co-leistung'), { target: { value: 'Abdichtung' } })
    fireEvent.change(field('co-ursache'), { target: { value: 'Befund' } })
    fireEvent.change(field('co-price'), { target: { value: '450' } })
    act(() => { vi.advanceTimersByTime(350) })

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-change-order'))
    })

    const stored = JSON.parse(memoryStorage.getItem(KEY)!) as Record<string, unknown>
    expect(stored.leistung).toBe('Abdichtung')
    expect(screen.queryByTestId('co-detail-route')).toBe(null)
  })
})
