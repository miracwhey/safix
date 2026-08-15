// @vitest-environment jsdom
/**
 * CustomerSpatialToolBar · Phase 1c morph + a11y contract.
 *
 * The bar is a single-container width-morph: anchor-only collapsed (134px)
 * vs full-strip expanded. State machine + tool selection are parent-
 * controlled so Phase 1d's edit-mode wiring reads the same source of truth.
 * Tests lock the visible contract before Phase 1d builds on top of it.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CustomerSpatialToolBar from '../../../../src/components/spatial/customer/CustomerSpatialToolBar'

describe('CustomerSpatialToolBar', () => {
  it('renders the anchor pill in the collapsed state by default', () => {
    render(<CustomerSpatialToolBar />)
    const toolbar = screen.getByRole('toolbar', { name: /werkzeuge/i })
    expect(toolbar.getAttribute('aria-expanded')).toBe('false')
    expect(
      screen.getByRole('button', { name: /werkzeuge öffnen/i }),
    ).toBeTruthy()
  })

  it('flips aria-expanded when the anchor is clicked', () => {
    render(<CustomerSpatialToolBar />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    expect(
      screen
        .getByRole('toolbar', { name: /werkzeuge/i })
        .getAttribute('aria-expanded'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: /werkzeuge schließen/i }),
    ).toBeTruthy()
  })

  it('collapses again on second anchor click', () => {
    render(<CustomerSpatialToolBar />)
    const anchor = screen.getByRole('button', { name: /werkzeuge öffnen/i })
    fireEvent.click(anchor)
    fireEvent.click(
      screen.getByRole('button', { name: /werkzeuge schließen/i }),
    )
    expect(
      screen
        .getByRole('toolbar', { name: /werkzeuge/i })
        .getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('Escape collapses an expanded bar', () => {
    render(<CustomerSpatialToolBar />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen
        .getByRole('toolbar', { name: /werkzeuge/i })
        .getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('click outside collapses an expanded bar', () => {
    // V1.6.1 Hub-Refactor: outside-detection moved from `pointerdown`
    // (capture-phase) to `click` (bubble-phase) so a sibling button's
    // own onClick fires FIRST, and the tool-bar collapse is the second
    // visible UI change — never both for the same tap (device-test
    // 2026-05-27 reported "ein Tap löst zwei UI-Änderungen aus").
    render(
      <div>
        <CustomerSpatialToolBar />
        <div data-testid="outside" />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByTestId('outside'))
    expect(
      screen
        .getByRole('toolbar', { name: /werkzeuge/i })
        .getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('calls onToolSelect with the tool key when a tool button is clicked', () => {
    const onToolSelect = vi.fn()
    render(<CustomerSpatialToolBar onToolSelect={onToolSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByRole('button', { name: /tür markieren/i }))
    expect(onToolSelect).toHaveBeenCalledWith('door')
  })

  it('marks the activeTool prop with aria-pressed=true on the matching button', () => {
    render(<CustomerSpatialToolBar activeTool="window" />)
    const windowBtn = screen.getByRole('button', { name: /fenster markieren/i })
    expect(windowBtn.getAttribute('aria-pressed')).toBe('true')
    const doorBtn = screen.getByRole('button', { name: /tür markieren/i })
    expect(doorBtn.getAttribute('aria-pressed')).toBe('false')
  })

  it('renders the count badge when counts[tool].count > 0', () => {
    render(<CustomerSpatialToolBar counts={{ heating: { count: 3 } }} />)
    expect(screen.getByLabelText('3')).toBeTruthy()
  })

  it('disables anchor + tool buttons when disabled=true', () => {
    const onToolSelect = vi.fn()
    render(<CustomerSpatialToolBar disabled onToolSelect={onToolSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByRole('button', { name: /tür markieren/i }))
    expect(onToolSelect).not.toHaveBeenCalled()
  })
})
