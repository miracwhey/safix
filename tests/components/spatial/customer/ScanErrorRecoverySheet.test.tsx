// @vitest-environment jsdom
/**
 * ScanErrorRecoverySheet · Phase 4 3-variant recovery flow.
 *
 * Mockup 12 binding · cancelled/loop-fail = orange · max-retries = red.
 * Wording lock: "Unterbrochen" + "klappt heute nicht", never "Fehler".
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import ScanErrorRecoverySheet from '../../../../src/components/spatial/customer/ScanErrorRecoverySheet'

describe('ScanErrorRecoverySheet', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <ScanErrorRecoverySheet
        open={false}
        variant="cancelled"
        attempt={1}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('cancelled variant: headline "Unterbrochen" + badge 1/3 + 2 button CTAs', () => {
    render(
      <ScanErrorRecoverySheet
        open
        variant="cancelled"
        attempt={1}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /unterbrochen/i })).toBeTruthy()
    expect(screen.getByTestId('recovery-retry-badge').textContent).toMatch(/1\s*\/\s*3/)
    expect(screen.getByRole('button', { name: /nochmal scannen/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /selbst messen/i })).toBeTruthy()
  })

  it('loop-fail variant: 3 coaching bullets present', () => {
    render(
      <ScanErrorRecoverySheet
        open
        variant="loop-fail"
        attempt={2}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(screen.getByText(/geh langsam/i)).toBeTruthy()
    expect(screen.getByText(/beleuchtung/i)).toBeTruthy()
    expect(screen.getByText(/umrunde/i)).toBeTruthy()
    expect(screen.getByTestId('recovery-retry-badge').textContent).toMatch(/2\s*\/\s*3/)
  })

  it('max-retries variant: red badge 3/3 + primary "Mit Vorlage messen" + text-link "Trotzdem nochmal"', () => {
    render(
      <ScanErrorRecoverySheet
        open
        variant="max-retries"
        attempt={3}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /klappt heute nicht/i })).toBeTruthy()
    expect(screen.getByTestId('recovery-retry-badge').textContent).toMatch(/3\s*\/\s*3/)
    const primary = screen.getByTestId('recovery-primary-cta')
    expect(primary.textContent).toMatch(/mit vorlage messen/i)
    const secondary = screen.getByTestId('recovery-secondary-cta')
    expect(secondary.textContent).toMatch(/trotzdem nochmal/i)
  })

  it('cancelled retry-tap fires onRetry, NOT onSwitchToPreset', () => {
    const onRetry = vi.fn()
    const onSwitchToPreset = vi.fn()
    render(
      <ScanErrorRecoverySheet
        open
        variant="cancelled"
        attempt={1}
        onClose={() => {}}
        onRetry={onRetry}
        onSwitchToPreset={onSwitchToPreset}
      />,
    )
    fireEvent.click(screen.getByTestId('recovery-primary-cta'))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onSwitchToPreset).not.toHaveBeenCalled()
  })

  it('cancelled secondary-tap fires onSwitchToPreset', () => {
    const onRetry = vi.fn()
    const onSwitchToPreset = vi.fn()
    render(
      <ScanErrorRecoverySheet
        open
        variant="cancelled"
        attempt={1}
        onClose={() => {}}
        onRetry={onRetry}
        onSwitchToPreset={onSwitchToPreset}
      />,
    )
    fireEvent.click(screen.getByTestId('recovery-secondary-cta'))
    expect(onSwitchToPreset).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('max-retries primary fires onSwitchToPreset (the safe off-ramp)', () => {
    const onRetry = vi.fn()
    const onSwitchToPreset = vi.fn()
    render(
      <ScanErrorRecoverySheet
        open
        variant="max-retries"
        attempt={3}
        onClose={() => {}}
        onRetry={onRetry}
        onSwitchToPreset={onSwitchToPreset}
      />,
    )
    fireEvent.click(screen.getByTestId('recovery-primary-cta'))
    expect(onSwitchToPreset).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('max-retries text-link fires onRetry (persistent-user escape hatch)', () => {
    const onRetry = vi.fn()
    render(
      <ScanErrorRecoverySheet
        open
        variant="max-retries"
        attempt={3}
        onClose={() => {}}
        onRetry={onRetry}
        onSwitchToPreset={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('recovery-secondary-cta'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('attempt counter is clamped to [1, maxAttempts]', () => {
    const { rerender } = render(
      <ScanErrorRecoverySheet
        open
        variant="cancelled"
        attempt={0}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(screen.getByTestId('recovery-retry-badge').textContent).toMatch(/1\s*\/\s*3/)
    rerender(
      <ScanErrorRecoverySheet
        open
        variant="cancelled"
        attempt={99}
        onClose={() => {}}
        onRetry={() => {}}
        onSwitchToPreset={() => {}}
      />,
    )
    expect(screen.getByTestId('recovery-retry-badge').textContent).toMatch(/3\s*\/\s*3/)
  })
})
