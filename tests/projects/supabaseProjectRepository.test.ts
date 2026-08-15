import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupabaseProjectRepository } from '../../src/lib/projects/repository/SupabaseProjectRepository'
import { supabase } from '../../src/lib/supabase'
import type { Project } from '../../src/lib/projects/projectTypes'

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
}))

const baseProject: Project = {
  id: '11111111-1111-1111-1111-111111111111',
  sourceJobId: '',
  title: 'Test Project',
  customer: 'Kunde',
  craftsman: '',
  location: 'Berlin',
  dateLabel: 'Termin offen',
  price: '',
  status: 'request',
  paymentState: 'deposit_required',
  messageCount: 0,
  noteCount: 0,
  photoCount: 0,
  createdAt: 1,
  updatedAt: 1,
  source: 'builder',
  category: 'Elektrik',
  description: 'Strom prüfen',
  requestedBudget: '500 €',
  requestedTiming: 'schnell',
  customerUserId: 'user-1',
  craftsmanUserId: 'craftsman-1',
}

describe('SupabaseProjectRepository.add()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token', user: { id: 'user-1' } } },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>)
  })

  it('keeps the optimistic insert when Supabase insert succeeds', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabase.from>)

    await repo.add(baseProject)

    expect(supabase.from).toHaveBeenCalledWith('projects')
    expect(repo.getAll()).toEqual([baseProject])
  })

  it('converts timestamptz strings from Supabase into millisecond numbers', async () => {
    const repo = new SupabaseProjectRepository()
    const rowCreated = '2024-01-02T03:04:05.123Z'
    const rowUpdated = '2024-02-03T04:05:06.789Z'

    const query: Record<string, unknown> = {
      select: vi.fn(),
      or: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
    }
    query.select = vi.fn().mockReturnValue(query)
    query.or = vi.fn().mockReturnValue(query)
    query.order = vi.fn().mockReturnValue(query)
    // @ts-expect-error loose typing for test double
    query.limit = vi.fn().mockResolvedValue({
      data: [
        {
          id: baseProject.id,
          source_job_id: baseProject.sourceJobId,
          title: baseProject.title,
          location: baseProject.location,
          status: baseProject.status,
          created_at: rowCreated,
          updated_at: rowUpdated,
          customer_user_id: null,
          craftsman_user_id: null,
        },
      ],
      error: null,
    })

    vi.mocked(supabase.from).mockReturnValue(query as unknown as ReturnType<typeof supabase.from>)

    await repo.initialize()

    const project = repo.getAll()[0]
    expect(project.createdAt).toBe(new Date(rowCreated).getTime())
    expect(project.updatedAt).toBe(new Date(rowUpdated).getTime())
  })

  it('persists all domain fields on add() including payment_state, source, description, budget, timing', async () => {
    const repo = new SupabaseProjectRepository()
    const insert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValue({
      insert,
    } as unknown as ReturnType<typeof supabase.from>)

    await repo.add(baseProject)

    const payload = insert.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toStrictEqual({
      id: baseProject.id,
      source_job_id: null,
      title: baseProject.title,
      customer_profile_id: baseProject.customerUserId,
      customer_user_id: baseProject.customerUserId,
      craftsman_user_id: baseProject.craftsmanUserId,
      location: baseProject.location,
      status: baseProject.status,
      created_at: new Date(baseProject.createdAt).toISOString(),
      updated_at: new Date(baseProject.updatedAt).toISOString(),
      // These fields must be included on insert so a reload before the first
      // update() doesn't revert to wrong DB defaults.
      payment_state: baseProject.paymentState,
      source: baseProject.source ?? null,
      description: baseProject.description ?? null,
      requested_budget: baseProject.requestedBudget ?? null,
      requested_timing: baseProject.requestedTiming ?? null,
      category: baseProject.category ?? null,
    })
  })

  it('writes realistic ms-epoch timestamps as ISO 8601 strings, not raw numbers', async () => {
    const repo = new SupabaseProjectRepository()
    const insert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValue({
      insert,
    } as unknown as ReturnType<typeof supabase.from>)

    const realisticMs = 1774821480509
    await repo.add({ ...baseProject, createdAt: realisticMs, updatedAt: realisticMs })

    const payload = insert.mock.calls[0][0] as Record<string, unknown>
    // Must be an ISO string, never a raw number — raw numbers cause
    // "timestamp out of range" errors in timestamptz columns.
    expect(typeof payload.created_at).toBe('string')
    expect(typeof payload.updated_at).toBe('string')
    expect(payload.created_at).toBe(new Date(realisticMs).toISOString())
    expect(payload.updated_at).toBe(new Date(realisticMs).toISOString())
  })

  it('normalizes optional UUID columns to null instead of empty strings', async () => {
    const repo = new SupabaseProjectRepository()
    const insert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(supabase.from).mockReturnValue({
      insert,
    } as unknown as ReturnType<typeof supabase.from>)

    await repo.add({
      ...baseProject,
      sourceJobId: '',
      customerUserId: '',
      craftsmanUserId: '',
    })

    const payload = insert.mock.calls[0][0] as Record<string, unknown>
    expect(payload.source_job_id).toBeNull()
    expect(payload.customer_profile_id).toBeNull()
    expect(payload.customer_user_id).toBeNull()
    expect(payload.craftsman_user_id).toBeNull()
  })

  it('rolls back the optimistic insert when Supabase insert fails', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: new Error('RLS denied') }),
    } as unknown as ReturnType<typeof supabase.from>)

    await expect(repo.add(baseProject)).rejects.toThrow('RLS denied')

    expect(repo.getAll()).toEqual([])
  })

  it('rolls back the optimistic insert when Supabase insert rejects', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as ReturnType<typeof supabase.from>)

    await expect(repo.add(baseProject)).rejects.toThrow('network down')

    expect(repo.getAll()).toEqual([])
  })

  it('throws a session-specific error when no authenticated session is present', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.getSession>>)

    await expect(repo.add(baseProject)).rejects.toThrow(/missing authenticated session/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects non-UUID project ids before attempting persistence', async () => {
    const repo = new SupabaseProjectRepository()
    const insert = vi.fn()
    vi.mocked(supabase.from).mockReturnValue({
      insert,
    } as unknown as ReturnType<typeof supabase.from>)

    await expect(repo.add({ ...baseProject, id: 'project-builder-legacy' })).rejects.toThrow(
      /valid uuid/i
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('surfaces Supabase error details instead of a generic message', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        error: { code: '42501', message: 'RLS denied', hint: 'customer_profile_id required' },
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    await expect(repo.add(baseProject)).rejects.toThrow(/RLS denied/)
    expect(repo.getAll()).toEqual([])
  })

  it('keeps the optimistic insert when Supabase reports a duplicate key', async () => {
    const repo = new SupabaseProjectRepository()
    vi.mocked(supabase.from).mockReturnValue({
      insert: vi.fn().mockResolvedValue({
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      }),
    } as unknown as ReturnType<typeof supabase.from>)

    await expect(repo.add(baseProject)).resolves.toBeUndefined()

    expect(repo.getAll()).toEqual([baseProject])
  })
})
