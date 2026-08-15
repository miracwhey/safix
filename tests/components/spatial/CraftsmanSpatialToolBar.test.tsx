// @vitest-environment jsdom
/**
 * CraftsmanSpatialToolBar · V1.6.1 morph + iOS dedupe contract.
 *
 * The HW trade palette is a single-container width-morph (collapsed "Auswahl"-
 * anchor ↔ full tool-strip) ported from CustomerSpatialToolBar. These tests
 * lock: the morph/a11y contract, the toggle-to-deselect behaviour, the count
 * badges, and — the device-audit fix (P3) — that a single iOS tap (touch
 * pointer-up + the synthetic click iOS replays after it) selects a tool exactly
 * ONCE instead of toggling it straight back off.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import CraftsmanSpatialToolBar from '../../../src/components/spatial/CraftsmanSpatialToolBar'

const noop = () => {}

describe('CraftsmanSpatialToolBar', () => {
  // aria-expanded lives on the anchor button (valid for role=button), NOT on
  // the role=toolbar root (unsupported state there).
  it('renders collapsed (anchor only) by default', () => {
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={noop} />)
    expect(screen.getByRole('toolbar', { name: /werkzeuge/i })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /werkzeuge öffnen/i }).getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('expands on anchor click and collapses on a second click', () => {
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    expect(
      screen.getByRole('button', { name: /werkzeuge schließen/i }).getAttribute('aria-expanded'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge schließen/i }))
    expect(
      screen.getByRole('button', { name: /werkzeuge öffnen/i }).getAttribute('aria-expanded'),
    ).toBe('false')
  })

  it('Escape collapses an expanded bar', () => {
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /werkzeuge öffnen/i })).toBeTruthy()
  })

  it('click outside collapses an expanded bar (bubble-phase)', () => {
    render(
      <div>
        <CraftsmanSpatialToolBar activeTool={null} onSelectTool={noop} />
        <div data-testid="outside" />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByTestId('outside'))
    expect(screen.getByRole('button', { name: /werkzeuge öffnen/i })).toBeTruthy()
  })

  it('selects a tool on click', () => {
    const onSelectTool = vi.fn()
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={onSelectTool} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Tür' }))
    expect(onSelectTool).toHaveBeenCalledTimes(1)
    expect(onSelectTool).toHaveBeenCalledWith('door')
  })

  it('toggles the active tool back off (→ Auswahl) on re-tap', () => {
    const onSelectTool = vi.fn()
    render(<CraftsmanSpatialToolBar activeTool="door" onSelectTool={onSelectTool} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Tür' }))
    expect(onSelectTool).toHaveBeenCalledWith(null)
  })

  it('marks the activeTool with aria-pressed=true', () => {
    render(<CraftsmanSpatialToolBar activeTool="outlet" onSelectTool={noop} />)
    expect(screen.getByRole('button', { name: 'Steckdose' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect(screen.getByRole('button', { name: 'Tür' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('folds the count into the chip accessible name when counts[tool].count > 0', () => {
    render(
      <CraftsmanSpatialToolBar
        activeTool={null}
        onSelectTool={noop}
        counts={{ outlet: { count: 3 } }}
      />,
    )
    expect(screen.getByRole('button', { name: /steckdose, 3 platziert/i })).toBeTruthy()
  })

  it('collapsed anchor reflects the armed tool instead of reading "Auswahl"', () => {
    const { rerender } = render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={noop} />)
    expect(screen.getByText('Auswahl')).toBeTruthy()
    // Arming a tool (e.g. after a failed placement that left it armed) must not
    // leave the collapsed pill lying "Auswahl".
    rerender(<CraftsmanSpatialToolBar activeTool="door" onSelectTool={noop} />)
    expect(screen.queryByText('Auswahl')).toBeNull()
  })

  it('P3 dedupe: a touch pointer-up + synthetic click selects ONCE, not toggled off', () => {
    const onSelectTool = vi.fn()
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={onSelectTool} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    const tuer = screen.getByRole('button', { name: 'Tür' })
    // iOS replays a synthetic click right after the touch pointer-up.
    fireEvent.pointerUp(tuer, { pointerType: 'touch' })
    fireEvent.click(tuer)
    expect(onSelectTool).toHaveBeenCalledTimes(1)
    expect(onSelectTool).toHaveBeenCalledWith('door')
  })

  it('mouse pointer-up does not double-fire the click path', () => {
    const onSelectTool = vi.fn()
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={onSelectTool} />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    const tuer = screen.getByRole('button', { name: 'Tür' })
    fireEvent.pointerUp(tuer, { pointerType: 'mouse' })
    fireEvent.click(tuer)
    expect(onSelectTool).toHaveBeenCalledTimes(1)
    expect(onSelectTool).toHaveBeenCalledWith('door')
  })

  it('disabled blocks tool selection', () => {
    const onSelectTool = vi.fn()
    render(<CraftsmanSpatialToolBar activeTool={null} onSelectTool={onSelectTool} disabled />)
    fireEvent.click(screen.getByRole('button', { name: /werkzeuge öffnen/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Tür' }))
    expect(onSelectTool).not.toHaveBeenCalled()
  })
})
