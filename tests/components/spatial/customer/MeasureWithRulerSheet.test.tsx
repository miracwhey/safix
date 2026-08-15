// @vitest-environment jsdom
/**
 * MeasureWithRulerSheet · Phase 4 first-run coaching sheet.
 *
 * Auto-skip when flag is set, dual exit paths (Verstanden + Skip) both
 * persist the flag, returning user sees nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'

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

import MeasureWithRulerSheet, {
  MEASURE_RULER_STORAGE_KEY,
} from '../../../../src/components/spatial/customer/MeasureWithRulerSheet'

beforeEach(() => {
  memoryStorage.clear()
})

describe('MeasureWithRulerSheet', () => {
  it('first-run: renders 3 step headings + Skip + Verstanden CTAs', () => {
    render(<MeasureWithRulerSheet open onDone={() => {}} onSkip={() => {}} />)
    expect(screen.getByText(/1\.\s*breite messen/i)).toBeTruthy()
    expect(screen.getByText(/2\.\s*länge messen/i)).toBeTruthy()
    expect(screen.getByText(/3\.\s*höhe messen/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /überspringen/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /verstanden/i })).toBeTruthy()
  })

  it('"Verstanden" persists the flag AND fires onDone', () => {
    const onDone = vi.fn()
    render(<MeasureWithRulerSheet open onDone={onDone} onSkip={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /verstanden/i }))
    expect(memoryStorage.getItem(MEASURE_RULER_STORAGE_KEY)).toBe('1')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('Skip-Button persists the flag AND fires onSkip', () => {
    const onSkip = vi.fn()
    render(<MeasureWithRulerSheet open onDone={() => {}} onSkip={onSkip} />)
    fireEvent.click(screen.getByRole('button', { name: /überspringen/i }))
    expect(memoryStorage.getItem(MEASURE_RULER_STORAGE_KEY)).toBe('1')
    expect(onSkip).toHaveBeenCalledOnce()
  })

  it('flag already set: sheet does not render anything', () => {
    memoryStorage.setItem(MEASURE_RULER_STORAGE_KEY, '1')
    const { container } = render(
      <MeasureWithRulerSheet open onDone={() => {}} onSkip={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('flag already set: auto-fires onDone on mount (so caller can proceed)', async () => {
    memoryStorage.setItem(MEASURE_RULER_STORAGE_KEY, '1')
    const onDone = vi.fn()
    render(<MeasureWithRulerSheet open onDone={onDone} onSkip={() => {}} />)
    await act(async () => { await Promise.resolve() })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('open=false: never renders nor fires callbacks', async () => {
    const onDone = vi.fn()
    const onSkip = vi.fn()
    const { container } = render(
      <MeasureWithRulerSheet open={false} onDone={onDone} onSkip={onSkip} />,
    )
    expect(container.firstChild).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(onDone).not.toHaveBeenCalled()
    expect(onSkip).not.toHaveBeenCalled()
  })
})
