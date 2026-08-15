// @vitest-environment jsdom
/**
 * Tests for {@link CraftsmanPresalesProjectsScreen} — list rendering with
 * conversion-CTA, archive-CTA, "Zum Auftrag" for converted, and the empty
 * state when the hook returns zero projects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const toastSpies = { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
const hapticsSpies = { selection: vi.fn(), success: vi.fn(), error: vi.fn() }
const navigateMock = vi.fn()
const refreshMock = vi.fn()
const startPresalesMock = vi.fn()
const updateMock = vi.fn().mockResolvedValue(undefined)
const confirmMock = vi.fn().mockReturnValue(true)

vi.mock('../../src/hooks/useToast', () => ({ useToast: () => toastSpies }))
vi.mock('../../src/hooks/useHaptics', () => ({ useHaptics: () => hapticsSpies }))
vi.mock('../../src/hooks/useSession', () => ({
  useSession: () => ({ user: { id: 'uid-1' }, role: 'craftsman' }),
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

import type { PresalesProject } from '../../src/domain/presales/presalesProjectTypes'

let projectsFixture: PresalesProject[] = []
let loadingFixture = false
let errorFixture: string | null = null
vi.mock('../../src/lib/presales/workflow/useProviderPresalesProjects', () => ({
  useProviderPresalesProjects: () => ({
    loading: loadingFixture,
    error: errorFixture,
    projects: projectsFixture,
    refresh: refreshMock,
  }),
}))

vi.mock('../../src/hooks/useStartPresalesRoomScan', () => ({
  useStartPresalesRoomScan: () => ({
    startPresalesScan: startPresalesMock,
    busy: false,
    lidarAvailable: true,
  }),
}))

vi.mock('../../src/lib/presales/repository/registry', () => ({
  getPresalesProjectRepository: () => ({ update: updateMock }),
  setPresalesProjectRepository: () => {},
  resetPresalesProjectRepository: () => {},
}))

vi.mock('../../src/lib/observability', () => ({ logError: vi.fn() }))

vi.mock('../../src/components/AppShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../../src/components/system/ScreenSkeleton', () => ({
  default: () => <div data-testid="skeleton" />,
}))
// Modal renders heavy form — replace with a stub button that triggers onSuccess
// so the screen-level wiring is what's under test, not the modal internals.
vi.mock('../../src/components/spatial/PresalesJobConversionModal', () => ({
  PresalesJobConversionModal: ({
    project,
    onSuccess,
    onClose,
  }: {
    project: { id: string }
    onSuccess: (id: string, already: boolean) => void
    onClose: () => void
  }) => (
    <div data-testid="convert-modal">
      <span>modal-for-{project.id}</span>
      <button onClick={() => onSuccess(`job-${project.id}`, false)}>convert-ok</button>
      <button onClick={onClose}>convert-cancel</button>
    </div>
  ),
}))

import CraftsmanPresalesProjectsScreen from '../../src/screens/CraftsmanPresalesProjectsScreen'

const sampleProject: PresalesProject = {
  id: 'p-1',
  providerOrgId: 'org-1',
  createdByUserId: 'uid-1',
  title: 'Bad Schmidt',
  locationHint: 'Hannover Linden',
  customerNameDraft: 'Maria Schmidt',
  customerEmailDraft: null,
  customerPhoneDraft: null,
  notes: null,
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
  navigateMock.mockReset()
  refreshMock.mockReset()
  startPresalesMock.mockReset()
  updateMock.mockReset().mockResolvedValue(undefined)
  confirmMock.mockReset().mockReturnValue(true)
  vi.stubGlobal('confirm', confirmMock)
  projectsFixture = []
  loadingFixture = false
  errorFixture = null
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen() {
  return render(
    <MemoryRouter>
      <CraftsmanPresalesProjectsScreen />
    </MemoryRouter>,
  )
}

describe('CraftsmanPresalesProjectsScreen', () => {
  it('renders empty state with "Erstes Aufmaß aufnehmen"', () => {
    renderScreen()
    expect(screen.getByText(/Noch keine Aufmaße/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Erstes Aufmaß aufnehmen/ }))
    expect(startPresalesMock).toHaveBeenCalled()
  })

  it('renders project card with Als-Projekt-anlegen + Archivieren CTAs', () => {
    projectsFixture = [sampleProject]
    renderScreen()
    expect(screen.getByText('Bad Schmidt')).toBeTruthy()
    expect(screen.getByText('Maria Schmidt')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Als Projekt anlegen/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Archivieren/ })).toBeTruthy()
  })

  it('Als Projekt anlegen opens modal; success navigates to job-spatial + refreshes', async () => {
    projectsFixture = [sampleProject]
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: /Als Projekt anlegen/ }))
    expect(screen.getByText('modal-for-p-1')).toBeTruthy()
    fireEvent.click(screen.getByText('convert-ok'))
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/craftsman/jobs/job-p-1/spatial?tab=3d')
    })
    expect(refreshMock).toHaveBeenCalled()
    expect(toastSpies.success).toHaveBeenCalledWith('Projekt angelegt.')
  })

  it('archive flow confirms + updates repo + refreshes list', async () => {
    projectsFixture = [sampleProject]
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: /Archivieren/ }))
    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith('p-1', { status: 'archived' })
    })
    expect(refreshMock).toHaveBeenCalled()
    expect(toastSpies.success).toHaveBeenCalledWith('Projekt archiviert.')
  })

  it('declining confirm skips repo update', async () => {
    projectsFixture = [sampleProject]
    confirmMock.mockReturnValueOnce(false)
    renderScreen()
    fireEvent.click(screen.getByRole('button', { name: /Archivieren/ }))
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('converted project renders "Zum Auftrag" link', () => {
    projectsFixture = [
      {
        ...sampleProject,
        status: 'converted',
        convertedToJobId: 'job-42',
        convertedAt: '2026-05-22T08:00:00Z',
      },
    ]
    renderScreen()
    const link = screen.getByRole('button', { name: /Zum Auftrag/ })
    fireEvent.click(link)
    expect(navigateMock).toHaveBeenCalledWith('/craftsman/jobs/job-42/spatial?tab=3d')
  })

  it('error from hook surfaces banner', () => {
    errorFixture = 'Boom kaputt'
    renderScreen()
    expect(screen.getByText('Boom kaputt')).toBeTruthy()
  })
})
