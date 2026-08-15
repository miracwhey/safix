// @vitest-environment jsdom
/**
 * Render tests for MaterialPickerSheet (Mockup 42) — the apply → close →
 * Undo-Toast flow + the dispute lock + Escape handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}))
vi.mock('../../../../src/hooks/useHaptics', () => ({
  useHaptics: () => ({ success: vi.fn(), error: vi.fn() }),
}))
// The catalog repository imports the Supabase client at module load; stub it
// (the picker runs the InMemory catalog — the client is never called).
vi.mock('../../../../src/lib/supabase', () => ({ supabase: {} }))

import { MaterialPickerSheet } from '../../../../src/components/spatial/edit/MaterialPickerSheet.tsx'
import { resetSpatialCatalogRepository } from '../../../../src/lib/spatial/canonical/repository/catalog-repository.ts'

const SURFACE = { id: 'wall-2', type: 'wall' as const, label: 'Wand 2 · Süden · 9,1 m²' }

function setup(overrides: Partial<Parameters<typeof MaterialPickerSheet>[0]> = {}) {
  const onApply = vi.fn()
  const onUndo = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <MaterialPickerSheet
      open
      surface={SURFACE}
      currentMaterialSlug={null}
      onApply={onApply}
      onUndo={onUndo}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onApply, onUndo, onClose, ...utils }
}

beforeEach(() => {
  cleanup() // guard against a prior test's tree lingering in document.body
  resetSpatialCatalogRepository()
})
afterEach(cleanup)

describe('MaterialPickerSheet', () => {
  it('renders the dialog with the surface label', async () => {
    setup()
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByText('Wand 2 · Süden · 9,1 m²')).toBeTruthy()
  })

  it('loads and shows the wall materials grouped into Typ-Sektionen', async () => {
    setup()
    expect(await screen.findByRole('button', { name: /Paint White/ })).toBeTruthy()
    // Section headers are <h3>s — unambiguous (the section name also appears
    // as each card's finish label).
    expect(screen.getByRole('heading', { name: 'Farbe & Putz' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fliesen' })).toBeTruthy()
  })

  it('tap-to-apply: tapping a material calls onApply + closes the sheet', async () => {
    const { onApply, onClose } = setup()
    const card = await screen.findByRole('button', { name: /Paint White/ })
    fireEvent.click(card)
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0][0].slug).toBe('wall-paint-white')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the Undo-Toast after an apply and survives the panel closing', async () => {
    const { rerender } = setup()
    const card = await screen.findByRole('button', { name: /Wandfliese Weiß/ })
    fireEvent.click(card)
    // The toast is identified by its unique "Rückgängig" button.
    await screen.findByRole('button', { name: 'Material-Änderung rückgängig machen' })
    // Host sets open=false after onClose — the toast must outlive the panel.
    rerender(
      <MaterialPickerSheet
        open={false}
        surface={SURFACE}
        currentMaterialSlug={null}
        onApply={vi.fn()}
        onUndo={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Material-Änderung rückgängig machen' }),
    ).toBeTruthy()
  })

  it('Undo-Toast "Rückgängig" calls onUndo', async () => {
    const { onUndo } = setup()
    fireEvent.click(await screen.findByRole('button', { name: /Paint White/ }))
    const undoButton = await screen.findByRole('button', {
      name: 'Material-Änderung rückgängig machen',
    })
    fireEvent.click(undoButton)
    expect(onUndo).toHaveBeenCalledTimes(1)
  })

  it('does not apply when the picker is dispute-locked', async () => {
    const { onApply } = setup({ lockReason: 'Im Streitfall · keine Material-Änderung' })
    const card = await screen.findByRole('button', { name: /Paint White/ })
    fireEvent.click(card)
    await Promise.resolve()
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByText(/Im Streitfall/)).toBeTruthy()
  })

  it('Escape closes the sheet', async () => {
    const { onClose } = setup()
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing visible when closed and never applied', () => {
    render(
      <MaterialPickerSheet
        open={false}
        surface={SURFACE}
        currentMaterialSlug={null}
        onApply={vi.fn()}
        onUndo={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(/angewendet/)).toBeNull()
  })
})
