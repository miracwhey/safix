// @vitest-environment jsdom
/**
 * Spatial V1.6.1 · Item #3 · CaptureResumeSheet
 *
 * 3 actions (Fortsetzen / Verwerfen / Schließen) + the 2-tap discard
 * inline-confirm pattern (mirrors HW ResumePendingScanSheet).
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CaptureResumeSheet from '../../../../src/components/spatial/customer/CaptureResumeSheet'

describe('CaptureResumeSheet', () => {
  it('returns null when open=false', () => {
    const { container } = render(
      <CaptureResumeSheet
        open={false}
        onResume={() => {}}
        onDiscard={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog with headline + body + 3 CTAs when open', () => {
    render(
      <CaptureResumeSheet
        open
        startedLabel="vor 3 Min"
        roomLabel="Eigenes Aufmaß"
        onResume={() => {}}
        onDiscard={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: /letzten scan fortsetzen/i })).toBeTruthy()
    expect(screen.getByText(/du hast einen scan-versuch begonnen/i)).toBeTruthy()
    expect(screen.getByText(/eigenes aufmaß/i)).toBeTruthy()
    expect(screen.getByText(/vor 3 min/i)).toBeTruthy()
    expect(screen.getByTestId('capture-resume-primary')).toBeTruthy()
    expect(screen.getByTestId('capture-resume-discard')).toBeTruthy()
    expect(screen.getByTestId('capture-resume-dismiss')).toBeTruthy()
  })

  it('falls back to default copy when started / roomLabel are null', () => {
    render(
      <CaptureResumeSheet
        open
        startedLabel={null}
        roomLabel={null}
        onResume={() => {}}
        onDiscard={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/dein 3d-aufmaß/i)).toBeTruthy()
    expect(screen.getByText(/begonnen vorhin/i)).toBeTruthy()
  })

  it('Fortsetzen fires onResume exactly once', () => {
    const onResume = vi.fn()
    const onDiscard = vi.fn()
    const onDismiss = vi.fn()
    render(
      <CaptureResumeSheet
        open
        onResume={onResume}
        onDiscard={onDiscard}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('capture-resume-primary'))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onDiscard).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('Verwerfen requires a second tap before firing onDiscard (inline-confirm)', () => {
    const onResume = vi.fn()
    const onDiscard = vi.fn()
    render(
      <CaptureResumeSheet
        open
        onResume={onResume}
        onDiscard={onDiscard}
        onDismiss={() => {}}
      />,
    )
    const discardBtn = screen.getByTestId('capture-resume-discard')
    fireEvent.click(discardBtn)
    expect(onDiscard).not.toHaveBeenCalled()
    // Button switches into the armed-state copy.
    expect(discardBtn.textContent).toMatch(/wirklich/i)
    expect(discardBtn.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(discardBtn)
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('Schließen fires onDismiss without persisting', () => {
    const onResume = vi.fn()
    const onDiscard = vi.fn()
    const onDismiss = vi.fn()
    render(
      <CaptureResumeSheet
        open
        onResume={onResume}
        onDiscard={onDiscard}
        onDismiss={onDismiss}
      />,
    )
    fireEvent.click(screen.getByTestId('capture-resume-dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('primary + discard CTAs are disabled while resuming=true', () => {
    render(
      <CaptureResumeSheet
        open
        resuming
        onResume={() => {}}
        onDiscard={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect((screen.getByTestId('capture-resume-primary') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('capture-resume-discard') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('capture-resume-primary').textContent).toMatch(/wird hochgeladen/i)
  })
})
