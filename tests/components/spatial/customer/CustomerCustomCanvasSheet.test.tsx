// @vitest-environment jsdom
/**
 * CustomerCustomCanvasSheet · Phase 3 B4-D3 dirty-guard contract.
 *
 * Hard contract: Save is unreachable until the customer has nudged at
 * least one stepper. The default 250×250×250 cm canvas can NEVER be
 * persisted unmodified (TBD #2 violation guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import CustomerCustomCanvasSheet from '../../../../src/components/spatial/customer/CustomerCustomCanvasSheet'

// `createCustomerCustomCanvas` is the production-side dispatch — mocked so we
// can assert call args without spinning the full workflow + supabase stack.
const workflowSpy = vi.fn()
vi.mock(
  '../../../../src/lib/spatial/workflow/createCustomerCustomCanvas',
  () => ({
    createCustomerCustomCanvas: (...args: unknown[]) => workflowSpy(...args),
  }),
)

// useToast is non-trivial in jsdom — stub it so tests don't depend on the
// real toast portal mount.
vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

beforeEach(() => {
  workflowSpy.mockReset()
})

describe('CustomerCustomCanvasSheet', () => {
  it('renders three steppers all initialised to 250 cm', () => {
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)

    expect(screen.getByText('Breite')).toBeTruthy()
    expect(screen.getByText('Länge')).toBeTruthy()
    expect(screen.getByText('Höhe')).toBeTruthy()
    expect(screen.getAllByText('250').length).toBe(3)
  })

  it('Save is disabled + aria-disabled while all axes are at 250 default', () => {
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const save = screen.getByRole('button', { name: /raum anlegen/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.getAttribute('aria-disabled')).toBe('true')
  })

  it('Save activates after width stepper is touched', () => {
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const plusButtons = screen.getAllByRole('button', { name: /vergrößern/i })
    fireEvent.click(plusButtons[0]!) // first plus = width
    const save = screen.getByRole('button', { name: /raum anlegen/i }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(save.getAttribute('aria-disabled')).toBe('false')
  })

  it('Save activates after height-only change too', () => {
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const minusButtons = screen.getAllByRole('button', { name: /verkleinern/i })
    fireEvent.click(minusButtons[2]!) // third minus = height
    const save = screen.getByRole('button', { name: /raum anlegen/i }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('Save tap fires createCustomerCustomCanvas with the adjusted dims (cm units)', async () => {
    workflowSpy.mockResolvedValue({ ok: true, sceneId: 's', scan: { id: 'x' } })
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const plusButtons = screen.getAllByRole('button', { name: /vergrößern/i })
    fireEvent.click(plusButtons[0]!) // width 250 → 260
    fireEvent.click(plusButtons[0]!) // width 260 → 270
    fireEvent.click(screen.getByRole('button', { name: /raum anlegen/i }))

    await waitFor(() => expect(workflowSpy).toHaveBeenCalledOnce())
    expect(workflowSpy).toHaveBeenCalledWith({
      widthCm: 270,
      lengthCm: 250,
      heightCm: 250,
    })
  })

  it('Save button references the helper text via aria-describedby', () => {
    render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const save = screen.getByRole('button', { name: /raum anlegen/i })
    const helperId = save.getAttribute('aria-describedby')
    expect(helperId).toBe('custom-canvas-helper')
    expect(document.getElementById(helperId!)?.textContent).toMatch(/passe min/i)
  })

  it('opening the sheet again resets dirty back to false', async () => {
    const { rerender } = render(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    const plusButtons = screen.getAllByRole('button', { name: /vergrößern/i })
    fireEvent.click(plusButtons[0]!)
    expect((screen.getByRole('button', { name: /raum anlegen/i }) as HTMLButtonElement).disabled).toBe(false)

    rerender(<CustomerCustomCanvasSheet open={false} onClose={() => {}} />)
    rerender(<CustomerCustomCanvasSheet open onClose={() => {}} />)
    // Reset happens on the microtask queue (see sheet effect) — flush it.
    await act(async () => {
      await Promise.resolve()
    })
    expect((screen.getByRole('button', { name: /raum anlegen/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
