// @vitest-environment jsdom
/**
 * QuoteCreationSheet · Resume-Robustness Block 4 — draft persistence +
 * X-tap discard confirm.
 *
 * Covers:
 *   • restore at mount: the persisted JSON object refills the form fields
 *     (schema-tolerant — partial drafts work) WITHOUT triggering a send.
 *   • debounced write-through: typing persists ONE JSON object under
 *     `fixup.quote.draft.<conversationId>.<documentType>`.
 *   • X-tap with content → confirm panel instead of silent discard;
 *     'Weiter bearbeiten' keeps editing, 'Verwerfen' clears draft + closes.
 *   • X-tap with empty form closes directly (no panel).
 *   • successful send clears the persisted draft (clear ONLY on success).
 *
 * Rendered without JSX (.test.ts — the vitest glob scopes .tsx to the
 * spatial tree). createOfferWorkflow is mocked (network workflow);
 * QuoteDetailView is stubbed (display-only preview, pulls react-router Link).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { QuoteComposerContext } from '../../src/components/messages/QuoteCreationSheet'

// In-memory localStorage stub — the vitest-jsdom localStorage in this repo
// has no functional methods; same pattern as tests/hooks/useDraftPersistence.test.ts.
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

vi.mock('../../src/lib/workflow/offerWorkflow', () => ({
  // Return value is ignored by the sheet (it only awaits the dispatch).
  createOfferWorkflow: vi.fn().mockResolvedValue(undefined),
}))

// Display-only preview renderer — stubbed so the test does not need a Router
// context (QuoteDetailView renders react-router Links).
vi.mock('../../src/components/quotes/QuoteDetailView', () => ({
  default: () => createElement('div', { 'data-testid': 'quote-detail-stub' }),
}))

// Observability — logError is called when an onCreated callback throws (Block 2);
// stub so the isolation test has no real telemetry side-effects.
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

import QuoteCreationSheet from '../../src/components/messages/QuoteCreationSheet'
import { createOfferWorkflow } from '../../src/lib/workflow/offerWorkflow'

// Shape mirrors the real producer `buildQuoteContext` (MessageThreadScreen.tsx) —
// the thread-neutral context the composer now takes (Cutover Slice-2 decoupling).
// craftsman/customer user ids are required for the send path; projectLocation/
// projectDescription stay undefined here exactly as the legacy-conversation path
// produces them when those fields are absent.
const context: QuoteComposerContext = {
  conversationId: 'conv-1',
  craftsmanUserId: 'hw-user-1',
  customerUserId: 'cust-user-1',
  projectTitle: 'Bad sanieren',
  craftsmanName: 'Handwerker H.',
}

const KEY = `fixup.quote.draft.${context.conversationId}.diagnosis`

type SheetProps = Partial<Parameters<typeof QuoteCreationSheet>[0]>

function renderSheet(overrides: SheetProps = {}) {
  const onClose = overrides.onClose ?? vi.fn()
  const onCreated = overrides.onCreated ?? vi.fn()
  const utils = render(
    createElement(QuoteCreationSheet, {
      context,
      documentType: 'diagnosis' as const,
      onClose,
      onCreated,
      ...overrides,
    }),
  )
  return { ...utils, onClose, onCreated }
}

function input(testId: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByTestId(testId) as HTMLInputElement | HTMLTextAreaElement
}

describe('QuoteCreationSheet draft persistence (Block 4)', () => {
  beforeEach(() => {
    memoryStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('restores a persisted draft into the fields at mount — without sending', () => {
    memoryStorage.setItem(
      KEY,
      JSON.stringify({
        price: '120 €',
        scopeSummary: 'Leck unter der Spüle prüfen',
        assumptions: 'Zusatzarbeiten bis 200 €',
        validUntil: '2026-12-31',
      }),
    )
    renderSheet()
    expect(input('quote-price-input').value).toBe('120 €')
    expect(input('quote-summary-input').value).toBe('Leck unter der Spüle prüfen')
    expect(input('quote-assumptions-input').value).toBe('Zusatzarbeiten bis 200 €')
    expect(input('quote-validity-input').value).toBe('2026-12-31')
    // Drafts must NEVER trigger a submit — restore only refills fields.
    expect(createOfferWorkflow).not.toHaveBeenCalled()
  })

  it('persists typed fields as ONE JSON object under the thread+type key', () => {
    renderSheet()
    fireEvent.change(input('quote-price-input'), { target: { value: '150 €' } })
    fireEvent.change(input('quote-summary-input'), { target: { value: 'Heizung entlüften' } })
    expect(memoryStorage.getItem(KEY)).toBe(null)
    act(() => { vi.advanceTimersByTime(350) })
    const stored = JSON.parse(memoryStorage.getItem(KEY)!) as Record<string, unknown>
    expect(stored.price).toBe('150 €')
    expect(stored.scopeSummary).toBe('Heizung entlüften')
    expect(stored.vatIncluded).toBe(true)
    expect(memoryStorage.length).toBe(1)
  })

  it('X-tap with content shows the discard confirm instead of closing', () => {
    const { onClose } = renderSheet()
    fireEvent.change(input('quote-price-input'), { target: { value: '99 €' } })
    act(() => { vi.advanceTimersByTime(350) })
    fireEvent.click(screen.getByLabelText('Schließen'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('quote-discard-confirm')).toBeTruthy()
    // 'Weiter bearbeiten' → panel gone, still open, draft intact.
    fireEvent.click(screen.getByTestId('quote-discard-keep-button'))
    expect(screen.queryByTestId('quote-discard-confirm')).toBe(null)
    expect(onClose).not.toHaveBeenCalled()
    expect(memoryStorage.getItem(KEY)).not.toBe(null)
    // 'Verwerfen' → draft cleared + closed.
    fireEvent.click(screen.getByLabelText('Schließen'))
    fireEvent.click(screen.getByTestId('quote-discard-confirm-button'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('X-tap with an empty form closes directly without a confirm', () => {
    const { onClose } = renderSheet()
    fireEvent.click(screen.getByLabelText('Schließen'))
    expect(screen.queryByTestId('quote-discard-confirm')).toBe(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a pre-filled scopeSummary alone does not count as draft content', () => {
    const { onClose } = renderSheet({ initialScopeSummary: 'Diagnose-Basis' })
    expect(input('quote-summary-input').value).toBe('Diagnose-Basis')
    act(() => { vi.advanceTimersByTime(350) })
    // Pre-fill only → no persisted entry, X closes without confirm.
    expect(memoryStorage.getItem(KEY)).toBe(null)
    fireEvent.click(screen.getByLabelText('Schließen'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a successful send clears the persisted draft and closes', async () => {
    const { onClose, onCreated } = renderSheet()
    fireEvent.change(input('quote-price-input'), { target: { value: '120 €' } })
    fireEvent.change(input('quote-summary-input'), { target: { value: 'Leck prüfen' } })
    fireEvent.change(input('quote-assumptions-input'), { target: { value: 'bis 200 €' } })
    fireEvent.change(input('quote-validity-input'), { target: { value: '2026-12-31' } })
    act(() => { vi.advanceTimersByTime(350) })
    expect(memoryStorage.getItem(KEY)).not.toBe(null)

    fireEvent.click(screen.getByTestId('quote-preview-button'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-submit-button'))
    })

    expect(createOfferWorkflow).toHaveBeenCalledTimes(1)
    expect(createOfferWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        documentType: 'diagnosis',
        price: '120 €',
      }),
    )
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(memoryStorage.getItem(KEY)).toBe(null)
    // No stale debounce timer may resurrect the cleared draft.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(memoryStorage.getItem(KEY)).toBe(null)
  })

  it('a failed send keeps the persisted draft (retry without re-typing)', async () => {
    vi.mocked(createOfferWorkflow).mockRejectedValueOnce(new Error('Load failed'))
    const { onClose } = renderSheet()
    fireEvent.change(input('quote-price-input'), { target: { value: '120 €' } })
    fireEvent.change(input('quote-summary-input'), { target: { value: 'Leck prüfen' } })
    fireEvent.change(input('quote-assumptions-input'), { target: { value: 'bis 200 €' } })
    fireEvent.change(input('quote-validity-input'), { target: { value: '2026-12-31' } })
    act(() => { vi.advanceTimersByTime(350) })

    fireEvent.click(screen.getByTestId('quote-preview-button'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-submit-button'))
    })

    expect(onClose).not.toHaveBeenCalled()
    const stored = JSON.parse(memoryStorage.getItem(KEY)!) as Record<string, unknown>
    expect(stored.price).toBe('120 €')
  })

  // ── Block 2: send control-flow hardening ──────────────────────────────

  it('guards against double-submit — two rapid taps create only one offer', async () => {
    // Workflow stays pending so both taps land while the first is in flight —
    // the exact window the synchronous submittingRef guard defends (disabled=
    // busy has not painted yet between two synchronous clicks).
    let resolveWorkflow: (() => void) | undefined
    vi.mocked(createOfferWorkflow).mockImplementationOnce(
      () => new Promise<void>((res) => { resolveWorkflow = () => res(undefined) }),
    )
    const { onClose, onCreated } = renderSheet()
    fireEvent.change(input('quote-price-input'), { target: { value: '120 €' } })
    fireEvent.change(input('quote-summary-input'), { target: { value: 'Leck prüfen' } })
    fireEvent.change(input('quote-assumptions-input'), { target: { value: 'bis 200 €' } })
    fireEvent.change(input('quote-validity-input'), { target: { value: '2026-12-31' } })
    fireEvent.click(screen.getByTestId('quote-preview-button'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-submit-button'))
      fireEvent.click(screen.getByTestId('quote-submit-button'))
      resolveWorkflow?.()
    })
    expect(createOfferWorkflow).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('isolates an onCreated throw from send-failure handling — success still closes', async () => {
    // onCreated re-reads thread + artifacts and can throw; the offer is already
    // persisted, so a throw must NOT surface as "send failed" or strand the sheet.
    const onCreated = vi.fn(() => { throw new Error('thread re-read boom') })
    const { onClose } = renderSheet({ onCreated })
    fireEvent.change(input('quote-price-input'), { target: { value: '120 €' } })
    fireEvent.change(input('quote-summary-input'), { target: { value: 'Leck prüfen' } })
    fireEvent.change(input('quote-assumptions-input'), { target: { value: 'bis 200 €' } })
    fireEvent.change(input('quote-validity-input'), { target: { value: '2026-12-31' } })
    act(() => { vi.advanceTimersByTime(350) })
    fireEvent.click(screen.getByTestId('quote-preview-button'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-submit-button'))
    })
    expect(createOfferWorkflow).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    // Draft cleared on success; no error alert despite the callback throw.
    expect(memoryStorage.getItem(KEY)).toBe(null)
    expect(screen.queryByRole('alert')).toBe(null)
  })

  // ── Block 5: stored-empty vs no-draft ─────────────────────────────────

  it('does not re-prefill an explicitly cleared scopeSummary when a draft exists', () => {
    // Restored draft: the user cleared the diagnosis prefill but typed a price.
    memoryStorage.setItem(KEY, JSON.stringify({ price: '120 €', scopeSummary: '' }))
    renderSheet({ initialScopeSummary: 'Diagnose-Basis' })
    // hasDraft=true → neither the init seed nor the deferred effect may reinstate
    // the prefill over the user's cleared scope.
    expect(input('quote-summary-input').value).toBe('')
    expect(input('quote-price-input').value).toBe('120 €')
  })
})
