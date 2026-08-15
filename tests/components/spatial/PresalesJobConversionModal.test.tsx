// @vitest-environment jsdom
/**
 * Tests for {@link PresalesJobConversionModal} — happy path + invalid_input
 * branch + idempotent return.
 *
 * createJobFromPresalesProject is mocked (workflow is exercised in
 * `tests/lib/presales/workflows.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
const hapticsSpies = { selection: vi.fn(), success: vi.fn(), error: vi.fn() }

vi.mock('../../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../../src/hooks/useHaptics', () => ({ useHaptics: () => hapticsSpies }))

const createMock = vi.fn()
vi.mock('../../../src/lib/presales/workflow/createJobFromPresalesProject', () => ({
  createJobFromPresalesProject: (...args: unknown[]) => createMock(...args),
}))

import { PresalesJobConversionModal } from '../../../src/components/spatial/PresalesJobConversionModal'
import type { PresalesProject } from '../../../src/domain/presales/presalesProjectTypes'

const baseProject: PresalesProject = {
  id: 'pp-1',
  providerOrgId: 'org-1',
  createdByUserId: 'usr-1',
  title: 'Bad Schmidt',
  locationHint: 'Hannover Linden',
  customerNameDraft: 'Maria Schmidt',
  customerEmailDraft: null,
  customerPhoneDraft: null,
  notes: 'Komplettrenovierung',
  status: 'scanned',
  scannedAt: '2026-05-20T10:00:00Z',
  quotedAt: null,
  convertedAt: null,
  convertedToJobId: null,
  createdAt: '2026-05-20T09:00:00Z',
  updatedAt: '2026-05-20T10:00:00Z',
}

beforeEach(() => {
  Object.values(toastSpies).forEach((s) => s.mockReset())
  Object.values(hapticsSpies).forEach((s) => s.mockReset())
  createMock.mockReset()
})
afterEach(cleanup)

describe('PresalesJobConversionModal', () => {
  it('prefills form from project drafts', () => {
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    )
    expect((screen.getByLabelText(/Kundenname/) as HTMLInputElement).value).toBe('Maria Schmidt')
    expect((screen.getByLabelText(/Beschreibung/) as HTMLTextAreaElement).placeholder).toContain(
      'Komplettrenovierung',
    )
  })

  it('submits happy path → calls workflow + onSuccess(jobId, alreadyExisted=false)', async () => {
    createMock.mockResolvedValueOnce({ ok: true, jobId: 'job-7', alreadyExisted: false })
    const onSuccess = vi.fn()
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={() => {}}
        onSuccess={onSuccess}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Telefon/), { target: { value: '0511 123456' } })
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1)
    })
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        presalesProjectId: 'pp-1',
        customerName: 'Maria Schmidt',
        customerPhone: '0511 123456',
      }),
    )
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('job-7', false)
    })
    expect(hapticsSpies.success).toHaveBeenCalled()
  })

  it('idempotent return → onSuccess(jobId, alreadyExisted=true)', async () => {
    createMock.mockResolvedValueOnce({ ok: true, jobId: 'job-prev', alreadyExisted: true })
    const onSuccess = vi.fn()
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={() => {}}
        onSuccess={onSuccess}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('job-prev', true)
    })
  })

  it('blocks submit when name is whitespace and shows inline error', async () => {
    const onSuccess = vi.fn()
    render(
      <PresalesJobConversionModal
        project={{ ...baseProject, customerNameDraft: null }}
        onClose={() => {}}
        onSuccess={onSuccess}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    expect(await screen.findByText(/Kundenname ist erforderlich/)).toBeTruthy()
    expect(createMock).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
    expect(hapticsSpies.error).toHaveBeenCalled()
  })

  it('invalid_input from workflow surfaces inline name error', async () => {
    createMock.mockResolvedValueOnce({
      ok: false,
      reason: 'invalid_input',
      message: 'Kundenname ist erforderlich.',
    })
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    expect(await screen.findByText(/Kundenname ist erforderlich/)).toBeTruthy()
    expect(toastSpies.error).not.toHaveBeenCalled()
  })

  it('non-validation failure shows toast.error', async () => {
    createMock.mockResolvedValueOnce({
      ok: false,
      reason: 'job_create_failed',
      message: 'Projekt konnte nicht angelegt werden.',
    })
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    await waitFor(() => {
      expect(toastSpies.error).toHaveBeenCalledWith('Projekt konnte nicht angelegt werden.')
    })
  })

  it('cancel button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <PresalesJobConversionModal
        project={baseProject}
        onClose={onClose}
        onSuccess={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
