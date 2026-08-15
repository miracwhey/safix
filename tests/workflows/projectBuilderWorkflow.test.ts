import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createProjectFromBuilderWorkflow } from '../../src/lib/workflow/projectBuilderWorkflow'
import { isValidProjectId } from '../../src/lib/projects/projectId'

const mockAddProject = vi.fn()
const mockGetCustomerContext = vi.fn()
const mockGetSession = vi.fn()
const mockGetSessionAuth = vi.fn()

vi.mock('../../src/lib/projects/projectsStore', () => ({
  addProject: (...args: unknown[]) => mockAddProject(...args),
}))

vi.mock('../../src/lib/customer/customerContextStore', () => ({
  getCustomerContext: () => mockGetCustomerContext(),
}))

vi.mock('../../src/lib/session', () => ({
  getSession: () => mockGetSession(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSessionAuth(...args),
    },
  },
}))

describe('createProjectFromBuilderWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCustomerContext.mockReturnValue({ displayName: 'Customer Test' })
    mockAddProject.mockResolvedValue(undefined)
    mockGetSession.mockReturnValue({
      user: null,
      role: null,
      craftsmanRole: null,
      isOperator: false,
      loading: false,
      error: null,
      errorKind: null,
    })
    mockGetSessionAuth.mockResolvedValue({
      data: { session: { user: { id: 'auth-user-1' }, access_token: 'token' } },
      error: null,
    })
  })

  it('creates a UUID primary id and keeps a builderId for the UI context', async () => {
    await createProjectFromBuilderWorkflow({
      category: 'Elektrik',
      description: 'Sicherung prüfen',
      location: 'Berlin',
      requestedBudget: undefined,
      requestedTiming: undefined,
    })

    expect(mockAddProject).toHaveBeenCalledTimes(1)
    const payload = mockAddProject.mock.calls[0][0]
    expect(isValidProjectId(payload.id)).toBe(true)
    expect(payload.builderId).toMatch(/^project_builder_/)
  })

  it('stamps the authenticated customer user id onto the new project', async () => {
    await createProjectFromBuilderWorkflow({
      category: 'Elektrik',
      description: 'Sicherung prüfen',
      location: 'Berlin',
      requestedBudget: undefined,
      requestedTiming: undefined,
    })

    expect(mockAddProject).toHaveBeenCalledTimes(1)
    const payload = mockAddProject.mock.calls[0][0]
    expect(payload.customerUserId).toBe('auth-user-1')
  })

  it('falls back to session store user id when Supabase session is empty', async () => {
    mockGetSessionAuth.mockResolvedValue({ data: { session: null }, error: null })
    mockGetSession.mockReturnValue({
      user: { id: 'store-user-1' },
      role: null,
      craftsmanRole: null,
      isOperator: false,
      loading: false,
      error: null,
      errorKind: null,
    })

    await createProjectFromBuilderWorkflow({
      category: 'Malerarbeiten',
      description: 'Wand streichen',
      location: 'Hamburg',
      requestedBudget: undefined,
      requestedTiming: undefined,
    })

    const payload = mockAddProject.mock.calls[0][0]
    expect(payload.customerUserId).toBe('store-user-1')
  })

  it('throws a descriptive error when no auth session is available', async () => {
    mockGetSessionAuth.mockResolvedValue({ data: { session: null }, error: null })
    mockGetSession.mockReturnValue({
      user: null,
      role: null,
      craftsmanRole: null,
      isOperator: false,
      loading: false,
      error: null,
      errorKind: null,
    })

    await expect(
      createProjectFromBuilderWorkflow({
        category: 'Bad',
        description: 'Umbau',
        location: 'Köln',
        requestedBudget: undefined,
        requestedTiming: undefined,
      })
    ).rejects.toThrow(/Keine aktive Anmeldung/)
    expect(mockAddProject).not.toHaveBeenCalled()
  })
})
