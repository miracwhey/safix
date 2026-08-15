// @vitest-environment jsdom
/**
 * Component tests for the Block-3.8 `VerifyStageConfirm` stage.
 *
 * Covers:
 *   - the change-summary card renders the three buckets (and the empty path),
 *   - "Provider anfragen" needs the inline confirm before it commits,
 *   - "Erstmal speichern" commits directly,
 *   - the multi-click double-submit guard on BOTH actions,
 *   - a failed submit re-enables the CTAs for a retry.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

import { VerifyStageConfirm } from '../../../src/components/spatial/verify/VerifyStageConfirm'
import type { VerifyChangeSummary } from '../../../src/lib/spatial/workflow/verifyChangeSummary'

afterEach(cleanup)

function changeSummary(overrides: Partial<VerifyChangeSummary> = {}): VerifyChangeSummary {
  const base: VerifyChangeSummary = {
    measurements: [],
    layout: [],
    pins: [],
    totalChanges: 0,
    isEmpty: true,
  }
  const merged = { ...base, ...overrides }
  merged.totalChanges =
    merged.measurements.length + merged.layout.length + merged.pins.length
  merged.isEmpty = merged.totalChanges === 0
  return merged
}

const fullSummary = changeSummary({
  measurements: [
    { wallId: 'w', wallName: 'Eingangswand', heightBeforeM: 2.5, heightAfterM: 2.8 },
  ],
  layout: [{ kind: 'wall_deleted', nodeId: 'w2', label: 'Wand entfernt' }],
  pins: [{ pinId: 'p', pinType: 'wish', title: 'Neue Dusche' }],
})

function setup(props: Partial<Parameters<typeof VerifyStageConfirm>[0]> = {}) {
  return render(
    <VerifyStageConfirm
      summary={props.summary ?? fullSummary}
      preview={<div data-testid="preview" />}
      onRequestProvider={props.onRequestProvider ?? vi.fn(async () => ({ ok: true, message: 'ok' }))}
      onSaveOnly={props.onSaveOnly ?? vi.fn(async () => ({ ok: true, message: 'saved' }))}
    />,
  )
}

describe('VerifyStageConfirm — change summary', () => {
  it('renders the three change buckets', () => {
    setup()
    expect(screen.getByTestId('verify-confirm-measurements')).toBeTruthy()
    expect(screen.getByTestId('verify-confirm-layout')).toBeTruthy()
    expect(screen.getByTestId('verify-confirm-pins')).toBeTruthy()
  })

  it('renders the empty-summary copy when nothing changed', () => {
    setup({ summary: changeSummary() })
    expect(screen.getByTestId('verify-confirm-empty')).toBeTruthy()
    expect(screen.queryByTestId('verify-confirm-changes')).toBeNull()
  })
})

describe('VerifyStageConfirm — Provider anfragen', () => {
  it('shows the inline confirm panel before committing', () => {
    const onRequestProvider = vi.fn(async () => ({ ok: true }))
    setup({ onRequestProvider })
    fireEvent.click(screen.getByTestId('verify-confirm-request-provider'))
    expect(screen.getByTestId('verify-confirm-inquiry-panel')).toBeTruthy()
    expect(onRequestProvider).not.toHaveBeenCalled()
  })

  it('commits on the second tap (confirm panel)', async () => {
    const onRequestProvider = vi.fn(async () => ({ ok: true }))
    setup({ onRequestProvider })
    fireEvent.click(screen.getByTestId('verify-confirm-request-provider'))
    fireEvent.click(screen.getByTestId('verify-confirm-inquiry-commit'))
    await waitFor(() => expect(onRequestProvider).toHaveBeenCalledTimes(1))
  })

  it('the confirm panel can be cancelled', () => {
    setup()
    fireEvent.click(screen.getByTestId('verify-confirm-request-provider'))
    fireEvent.click(screen.getByTestId('verify-confirm-inquiry-cancel'))
    expect(screen.queryByTestId('verify-confirm-inquiry-panel')).toBeNull()
    expect(screen.getByTestId('verify-confirm-request-provider')).toBeTruthy()
  })

  it('a double-tapped inquiry-commit fires onRequestProvider exactly once', async () => {
    const onRequestProvider = vi.fn(async () => ({ ok: true }))
    setup({ onRequestProvider })
    fireEvent.click(screen.getByTestId('verify-confirm-request-provider'))
    const commit = screen.getByTestId('verify-confirm-inquiry-commit')
    fireEvent.click(commit)
    fireEvent.click(commit)
    await waitFor(() => expect(onRequestProvider).toHaveBeenCalled())
    expect(onRequestProvider).toHaveBeenCalledTimes(1)
  })
})

describe('VerifyStageConfirm — Erstmal speichern', () => {
  it('commits directly (no confirm panel)', async () => {
    const onSaveOnly = vi.fn(async () => ({ ok: true, message: 'saved' }))
    setup({ onSaveOnly })
    fireEvent.click(screen.getByTestId('verify-confirm-save-only'))
    await waitFor(() => expect(onSaveOnly).toHaveBeenCalledTimes(1))
  })

  it('a double-tapped save fires onSaveOnly exactly once', async () => {
    const onSaveOnly = vi.fn(async () => ({ ok: true, message: 'saved' }))
    setup({ onSaveOnly })
    const cta = screen.getByTestId('verify-confirm-save-only')
    fireEvent.click(cta)
    fireEvent.click(cta)
    await waitFor(() => expect(onSaveOnly).toHaveBeenCalled())
    expect(onSaveOnly).toHaveBeenCalledTimes(1)
  })
})

describe('VerifyStageConfirm — failure handling', () => {
  it('a failed save re-enables the CTA for a retry', async () => {
    const onSaveOnly = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'Fehler' })
      .mockResolvedValueOnce({ ok: true, message: 'saved' })
    setup({ onSaveOnly })
    fireEvent.click(screen.getByTestId('verify-confirm-save-only'))
    await waitFor(() => expect(screen.getByTestId('verify-confirm-feedback')).toBeTruthy())
    // The CTA is enabled again — a retry is possible.
    const cta = screen.getByTestId('verify-confirm-save-only')
    expect(cta.hasAttribute('disabled')).toBe(false)
    fireEvent.click(cta)
    await waitFor(() => expect(onSaveOnly).toHaveBeenCalledTimes(2))
  })
})
