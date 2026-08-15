import { describe, it, expect, beforeEach, vi } from 'vitest'

const { fromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: fromMock,
  },
}))

import { listTeamHubAudit } from '../../src/lib/team/teamHubAudit'

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = () => chain
  chain.order = () => chain
  chain.limit = () => Promise.resolve(result)
  return chain
}

describe('listTeamHubAudit', () => {
  beforeEach(() => {
    fromMock.mockReset()
  })

  it('returns empty list when providerId is empty', async () => {
    const result = await listTeamHubAudit('', 5)
    expect(result).toEqual([])
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('queries both audit tables and merges sorted by createdAt desc', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'company_code_audit') {
        return makeChain({
          data: [
            { id: 'cc-1', rotated_at: '2026-05-04T10:00:00Z', reason: null },
            { id: 'cc-2', rotated_at: '2026-04-01T10:00:00Z', reason: 'leak' },
          ],
          error: null,
        })
      }
      if (table === 'team_member_audit') {
        return makeChain({
          data: [
            {
              id: 'tm-1',
              member_id: 'm-1',
              action: 'deactivate',
              old_values: { is_active: true },
              new_values: { is_active: false },
              created_at: '2026-05-05T10:00:00Z',
            },
            {
              id: 'tm-2',
              member_id: 'm-2',
              action: 'update',
              old_values: { full_name: 'Alt' },
              new_values: { full_name: 'Neu' },
              created_at: '2026-05-03T10:00:00Z',
            },
          ],
          error: null,
        })
      }
      return makeChain({ data: [], error: null })
    })

    const entries = await listTeamHubAudit('p-1', 10)

    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.id)).toEqual(['tm-1', 'cc-1', 'tm-2', 'cc-2'])
    expect(entries[0]).toMatchObject({ kind: 'member_action', action: 'deactivate' })
    expect(entries[1]).toMatchObject({ kind: 'code_rotation', id: 'cc-1' })
  })

  it('respects the limit after merging', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'company_code_audit') {
        return makeChain({
          data: Array.from({ length: 5 }, (_, i) => ({
            id: `cc-${i}`,
            rotated_at: `2026-05-0${5 - i}T10:00:00Z`,
            reason: null,
          })),
          error: null,
        })
      }
      return makeChain({
        data: Array.from({ length: 5 }, (_, i) => ({
          id: `tm-${i}`,
          member_id: 'm',
          action: 'update',
          old_values: null,
          new_values: null,
          created_at: `2026-04-0${5 - i}T10:00:00Z`,
        })),
        error: null,
      })
    })

    const entries = await listTeamHubAudit('p-1', 3)
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.kind === 'code_rotation')).toBe(true)
  })

  it('drops unknown action types silently', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'company_code_audit') {
        return makeChain({ data: [], error: null })
      }
      return makeChain({
        data: [
          {
            id: 'tm-1',
            member_id: 'm-1',
            action: 'mystery_action',
            old_values: null,
            new_values: null,
            created_at: '2026-05-01T10:00:00Z',
          },
          {
            id: 'tm-2',
            member_id: 'm-1',
            action: 'reactivate',
            old_values: null,
            new_values: null,
            created_at: '2026-05-02T10:00:00Z',
          },
        ],
        error: null,
      })
    })

    const entries = await listTeamHubAudit('p-1', 10)
    expect(entries.map((e) => e.id)).toEqual(['tm-2'])
  })

  it('returns empty list when both tables error', async () => {
    fromMock.mockImplementation(() => makeChain({ data: null, error: { message: 'denied' } }))
    const entries = await listTeamHubAudit('p-1', 10)
    expect(entries).toEqual([])
  })
})
