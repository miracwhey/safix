import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/lib/supabase', () => {
  const getUser = vi.fn()
  return {
    supabase: {
      auth: { getUser },
    },
    __mockGetUser: getUser,
  }
})

vi.mock('../../../../src/lib/spatial/repository/registry', () => {
  const listCustomerVisibleScans = vi.fn()
  return {
    getSpatialRepository: () => ({ listCustomerVisibleScans }),
    __mockList: listCustomerVisibleScans,
  }
})

// Re-grab the mock handles after `vi.mock` registration completes.
async function getMocks() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = (await import('../../../../src/lib/supabase')) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (await import('../../../../src/lib/spatial/repository/registry')) as any
  return { getUser: sb.__mockGetUser as ReturnType<typeof vi.fn>, list: reg.__mockList as ReturnType<typeof vi.fn> }
}

import {
  listCustomerScans,
  NotAuthenticatedError,
} from '../../../../src/lib/spatial/workflow/listCustomerScans'

describe('listCustomerScans (Block 3 workflow)', () => {
  beforeEach(async () => {
    const { getUser, list } = await getMocks()
    getUser.mockReset()
    list.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('throws NotAuthenticatedError when no user', async () => {
    const { getUser } = await getMocks()
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(listCustomerScans()).rejects.toBeInstanceOf(NotAuthenticatedError)
  })

  it('rethrows supabase auth error', async () => {
    const { getUser } = await getMocks()
    const boom = new Error('jwt expired')
    getUser.mockResolvedValue({ data: { user: null }, error: boom })
    await expect(listCustomerScans()).rejects.toBe(boom)
  })

  it('calls repo with user id when authenticated', async () => {
    const { getUser, list } = await getMocks()
    getUser.mockResolvedValue({
      data: { user: { id: 'customer_42' } },
      error: null,
    })
    list.mockResolvedValue([{ id: 'scan_1' }, { id: 'scan_2' }])
    const result = await listCustomerScans()
    expect(list).toHaveBeenCalledWith('customer_42')
    expect(result).toHaveLength(2)
  })
})
