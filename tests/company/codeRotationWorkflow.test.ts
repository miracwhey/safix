import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mockCustomerSession, mockOwnerSession, mockWorkerSession } from '../helpers/mockSession'
import { RbacError } from '../../src/lib/auth/rbacGuards'

const { rotateMock } = vi.hoisted(() => ({ rotateMock: vi.fn() }))

vi.mock('../../src/lib/company/codeRotation', () => ({
  rotateCompanyCode: rotateMock,
}))

import { rotateCompanyCodeWorkflow } from '../../src/lib/workflow/companyCodeWorkflow'

describe('rotateCompanyCodeWorkflow — owner gate', () => {
  beforeEach(() => {
    rotateMock.mockReset()
  })

  it('throws RbacError when caller is a worker', async () => {
    await expect(
      rotateCompanyCodeWorkflow('p-1', undefined, mockWorkerSession('u-1')),
    ).rejects.toBeInstanceOf(RbacError)
    expect(rotateMock).not.toHaveBeenCalled()
  })

  it('throws RbacError when caller is a customer', async () => {
    await expect(
      rotateCompanyCodeWorkflow('p-1', undefined, mockCustomerSession('u-1')),
    ).rejects.toBeInstanceOf(RbacError)
    expect(rotateMock).not.toHaveBeenCalled()
  })

  it('delegates to rotateCompanyCode for owner caller', async () => {
    rotateMock.mockResolvedValueOnce({ ok: true, newCode: 'ABC123', newCodeId: 'id-1' })
    const result = await rotateCompanyCodeWorkflow('p-1', 'leak', mockOwnerSession('u-1'))
    expect(result).toEqual({ ok: true, newCode: 'ABC123', newCodeId: 'id-1' })
    expect(rotateMock).toHaveBeenCalledWith('p-1', 'leak')
  })

  it('propagates server-side errors as result objects (no throw)', async () => {
    rotateMock.mockResolvedValueOnce({
      ok: false,
      code: 'rate_limit_exceeded',
      error: 'Du hast das tägliche Limit (5 Rotationen) erreicht. Bitte morgen erneut versuchen.',
    })
    const result = await rotateCompanyCodeWorkflow('p-1', undefined, mockOwnerSession('u-1'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('rate_limit_exceeded')
  })
})
