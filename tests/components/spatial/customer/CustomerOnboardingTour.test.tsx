// @vitest-environment jsdom
/**
 * CustomerOnboardingTour · Phase 4 4-step tour.
 *
 * Mockup 08 binding · skip hidden on Step 1, ESC + backdrop hard-gated on
 * Step 1, skip visible Step 2-4, "Los geht's" finishes on Step 4.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CustomerOnboardingTour from '../../../../src/components/spatial/customer/CustomerOnboardingTour'

describe('CustomerOnboardingTour', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <CustomerOnboardingTour open={false} onDone={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('opens on Step 1 — Skip-Button hidden, Weiter visible', () => {
    render(<CustomerOnboardingTour open onDone={() => {}} />)
    expect(screen.getByText(/dein raum in 3d/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /überspringen/i })).toBeNull()
    expect(screen.getByRole('button', { name: /weiter/i })).toBeTruthy()
  })

  it('Step 1 ESC does not dismiss (hard-gated)', () => {
    const onDone = vi.fn()
    render(<CustomerOnboardingTour open onDone={onDone} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByText(/dein raum in 3d/i)).toBeTruthy()
  })

  it('Weiter advances Step 1 → 2 and Skip-Button becomes visible', () => {
    render(<CustomerOnboardingTour open onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    expect(screen.getByText(/3 wege/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /überspringen/i })).toBeTruthy()
  })

  it('Skip on Step 2 fires onDone (caller persists flag)', () => {
    const onDone = vi.fn()
    render(<CustomerOnboardingTour open onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    fireEvent.click(screen.getByRole('button', { name: /überspringen/i }))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('Step 2 ESC counts as Skip — fires onDone', () => {
    const onDone = vi.fn()
    render(<CustomerOnboardingTour open onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('Step 4 CTA reads "Los geht\'s" and fires onDone exactly once', () => {
    const onDone = vi.fn()
    render(<CustomerOnboardingTour open onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: /weiter/i })) // 1→2
    fireEvent.click(screen.getByRole('button', { name: /weiter/i })) // 2→3
    fireEvent.click(screen.getByRole('button', { name: /weiter/i })) // 3→4
    const finalCta = screen.getByRole('button', { name: /los geht/i })
    fireEvent.click(finalCta)
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('Back button appears Step 2+ and steps backward', () => {
    render(<CustomerOnboardingTour open onDone={() => {}} />)
    expect(screen.queryByRole('button', { name: /zurück/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    expect(screen.getByText(/3 wege/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /zurück/i }))
    expect(screen.getByText(/dein raum in 3d/i)).toBeTruthy()
  })

  it('progress-dot count is 4 across all steps', () => {
    render(<CustomerOnboardingTour open onDone={() => {}} />)
    const dots = screen.getByRole('tablist')
    expect(dots.children.length).toBe(4)
  })

  it('Step 3 includes "Pro-iPhone" inclusive wording', () => {
    render(<CustomerOnboardingTour open onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    fireEvent.click(screen.getByRole('button', { name: /weiter/i }))
    expect(screen.getByText(/ohne pro-iphone/i)).toBeTruthy()
  })
})
