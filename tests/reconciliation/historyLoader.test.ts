import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSelect, mockEq, mockOrder } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockOrder: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'dispute_status_history') {
        throw new Error(`unexpected table: ${table}`)
      }
      return {
        select: (cols: string) => {
          mockSelect(cols)
          return {
            eq: (col: string, val: string) => {
              mockEq(col, val)
              return {
                order: (
                  field: string,
                  options: { ascending: boolean },
                ) => {
                  mockOrder(field, options)
                  return Promise.resolve(mockResult)
                },
              }
            },
          }
        },
      }
    }),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
}))

let mockResult: { data: unknown; error: unknown }

beforeEach(() => {
  mockResult = { data: [], error: null }
  mockSelect.mockReset()
  mockEq.mockReset()
  mockOrder.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('loadDisputeHistory', () => {
  it('returns an empty array when the dispute id is empty', async () => {
    const { loadDisputeHistory } = await import(
      '../../src/lib/reconciliation/loaders/historyLoader'
    )
    const rows = await loadDisputeHistory('')
    expect(rows).toEqual([])
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('queries dispute_status_history and maps DTO columns to camelCase', async () => {
    mockResult = {
      data: [
        {
          id: 'h1',
          dispute_id: 'd1',
          previous_status: null,
          next_status: 'open',
          source: 'client',
          actor_user_id: 'user-c',
          note: 'Streitfall eröffnet',
          created_at: '2026-04-18T14:32:00.000Z',
        },
        {
          id: 'h2',
          dispute_id: 'd1',
          previous_status: 'open',
          next_status: 'under_review',
          source: 'admin',
          actor_user_id: null,
          note: null,
          created_at: '2026-04-19T09:15:00.000Z',
        },
      ],
      error: null,
    }
    const { loadDisputeHistory } = await import(
      '../../src/lib/reconciliation/loaders/historyLoader'
    )
    const rows = await loadDisputeHistory('d1')
    expect(mockEq).toHaveBeenCalledWith('dispute_id', 'd1')
    expect(mockOrder).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'h1',
      disputeId: 'd1',
      previousStatus: null,
      nextStatus: 'open',
      source: 'client',
      actorUserId: 'user-c',
    })
    expect(rows[1].source).toBe('admin')
  })

  it('skips rows with an unknown source or status', async () => {
    mockResult = {
      data: [
        {
          id: 'h1',
          dispute_id: 'd1',
          previous_status: null,
          next_status: 'unknown_state',
          source: 'client',
          actor_user_id: null,
          note: null,
          created_at: '2026-04-18T14:32:00.000Z',
        },
        {
          id: 'h2',
          dispute_id: 'd1',
          previous_status: null,
          next_status: 'open',
          source: 'random',
          actor_user_id: null,
          note: null,
          created_at: '2026-04-19T09:15:00.000Z',
        },
        {
          id: 'h3',
          dispute_id: 'd1',
          previous_status: null,
          next_status: 'open',
          source: 'system',
          actor_user_id: null,
          note: null,
          created_at: '2026-04-20T09:15:00.000Z',
        },
      ],
      error: null,
    }
    const { loadDisputeHistory } = await import(
      '../../src/lib/reconciliation/loaders/historyLoader'
    )
    const rows = await loadDisputeHistory('d1')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('h3')
  })

  it('returns an empty array when supabase reports an error', async () => {
    mockResult = { data: null, error: { message: 'boom' } }
    const { loadDisputeHistory } = await import(
      '../../src/lib/reconciliation/loaders/historyLoader'
    )
    const rows = await loadDisputeHistory('d1')
    expect(rows).toEqual([])
  })
})
