import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitBuilderProject } from '../../src/screens/submitBuilderProject'
import { createProjectFromBuilderWorkflow } from '../../src/lib/workflow/projectBuilderWorkflow'
import { isValidProjectId } from '../../src/lib/projects/projectId'
import { setProjectRepository } from '../../src/lib/projects/repository/registry'
import { SupabaseProjectRepository } from '../../src/lib/projects/repository/SupabaseProjectRepository'

const supabaseSpies = vi.hoisted(() => {
  const insertSpy = vi.fn()
  const fromSpy = vi.fn(() => ({
    insert: insertSpy,
    update: vi.fn(),
    select: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    eq: vi.fn(),
  }))
  const authGetSessionSpy = vi.fn()
  return { insertSpy, fromSpy, authGetSessionSpy }
})

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: supabaseSpies.authGetSessionSpy,
    },
    from: supabaseSpies.fromSpy,
  },
}))

vi.mock('../../src/lib/customer/customerContextStore', () => ({
  getCustomerContext: () => ({ displayName: 'Builder Test User' }),
}))

vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: { id: 'store-user-1' },
    role: null,
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    error: null,
    errorKind: null,
  }),
}))

describe('builder submit → Supabase persistence path', () => {
  beforeEach(() => {
    supabaseSpies.insertSpy.mockReset()
    supabaseSpies.fromSpy.mockClear()
    supabaseSpies.authGetSessionSpy.mockResolvedValue({
      data: { session: { user: { id: 'auth-user-1' }, access_token: 'token' } },
      error: null,
    })
    setProjectRepository(new SupabaseProjectRepository())
  })

  it('persists builder submissions with a UUID project id', async () => {
    supabaseSpies.insertSpy.mockResolvedValue({ error: null })

    const navigate = vi.fn()
    const setSubmitting = vi.fn()
    const setSubmitError = vi.fn()

    const input = {
      category: 'Elektrik',
      description: 'Sicherung prüfen',
      location: 'Berlin',
      requestedBudget: undefined,
      requestedTiming: undefined,
    }

    const result = await submitBuilderProject(input, {
      createProject: createProjectFromBuilderWorkflow,
      navigate,
      setSubmitting,
      setSubmitError,
    })

    expect(supabaseSpies.insertSpy).toHaveBeenCalledTimes(1)
    const insertedRow = supabaseSpies.insertSpy.mock.calls[0][0]
    expect(isValidProjectId(insertedRow.id)).toBe(true)
    expect(insertedRow.id).not.toMatch(/^project_builder_/)
    expect(insertedRow.source_job_id).toBeNull()
    expect(insertedRow.customer_user_id).toBe('auth-user-1')
    expect(insertedRow.craftsman_user_id).toBeNull()
    // Builder identity fields must survive the Supabase insert so they are
    // available after reload (reload re-reads the row from the DB).
    expect(insertedRow.category).toBe('Elektrik')
    expect(insertedRow.source).toBe('builder')
    expect(insertedRow.description).toBe('Sicherung prüfen')
    expect(result).not.toBeNull()
  })
})
