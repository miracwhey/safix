import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryPresalesProjectRepository } from '../../../src/lib/presales/repository/InMemoryPresalesProjectRepository'
import {
  resetPresalesProjectRepository,
  setPresalesProjectRepository,
} from '../../../src/lib/presales/repository/registry'
import { createProviderPresalesProject } from '../../../src/lib/presales/workflow/createProviderPresalesProject'
import { createJobFromPresalesProject } from '../../../src/lib/presales/workflow/createJobFromPresalesProject'
import * as sessionMod from '../../../src/lib/session'
import * as providerOrgMod from '../../../src/lib/spatial/canonical/workflow/resolveProviderOrg'
import * as timelineMod from '../../../src/lib/timeline/timelineService'
import { setJobRepository } from '../../../src/lib/jobs/repository'
import { InMemoryJobRepository } from '../../../src/lib/jobs/repository/InMemoryJobRepository'

const ORG = 'aaaaaaaa-org0-0000-0000-000000000001'
const UID = 'uuuuuuuu-0000-0000-0000-000000000001'

function stubSession(uid: string | null) {
  vi.spyOn(sessionMod, 'getSession').mockReturnValue({
    user: uid ? ({ id: uid } as { id: string }) : null,
    role: null,
    sessionValidated: true,
  } as ReturnType<typeof sessionMod.getSession>)
}

function stubProviderOrg(orgId: string | null, failed = false) {
  vi.spyOn(providerOrgMod, 'resolveProviderOrg').mockResolvedValue({ orgId, failed })
}

describe('createProviderPresalesProject', () => {
  let repo: InMemoryPresalesProjectRepository

  beforeEach(() => {
    vi.restoreAllMocks()
    repo = new InMemoryPresalesProjectRepository()
    setPresalesProjectRepository(repo)
  })

  it('creates a draft with default title when none given', async () => {
    stubSession(UID)
    stubProviderOrg(ORG)

    const result = await createProviderPresalesProject({})

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.providerOrgId).toBe(ORG)
    expect(result.project.createdByUserId).toBe(UID)
    expect(result.project.status).toBe('draft')
    expect(result.project.title).toMatch(/^Aufmaß · \d{1,2}\. \w+ · \d{2}:\d{2}$/)
  })

  it('uses custom title + location when provided', async () => {
    stubSession(UID)
    stubProviderOrg(ORG)

    const result = await createProviderPresalesProject({
      title: 'Bad Schmidt',
      locationHint: 'Hannover Linden',
      customerNameDraft: 'Maria Schmidt',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.title).toBe('Bad Schmidt')
    expect(result.project.locationHint).toBe('Hannover Linden')
    expect(result.project.customerNameDraft).toBe('Maria Schmidt')
  })

  it('rejects unauthenticated callers', async () => {
    stubSession(null)
    stubProviderOrg(ORG)

    const result = await createProviderPresalesProject({})

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_authenticated')
  })

  it('rejects callers without provider-org membership', async () => {
    stubSession(UID)
    stubProviderOrg(null)

    const result = await createProviderPresalesProject({})

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_provider_member')
  })

  it('surfaces org-resolve failures distinctly', async () => {
    stubSession(UID)
    stubProviderOrg(null, true)

    const result = await createProviderPresalesProject({})

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('org_resolve_failed')
  })

  it('trims whitespace from input fields', async () => {
    stubSession(UID)
    stubProviderOrg(ORG)

    const result = await createProviderPresalesProject({
      title: '  Bad Müller  ',
      locationHint: '   ',
      notes: 'Bemerkung',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.project.title).toBe('Bad Müller')
    expect(result.project.locationHint).toBeNull()
    expect(result.project.notes).toBe('Bemerkung')
  })
})

describe('createJobFromPresalesProject', () => {
  let repo: InMemoryPresalesProjectRepository
  let jobRepo: InMemoryJobRepository

  beforeEach(async () => {
    vi.restoreAllMocks()
    repo = new InMemoryPresalesProjectRepository()
    setPresalesProjectRepository(repo)
    jobRepo = new InMemoryJobRepository()
    setJobRepository(jobRepo)
    stubSession(UID)
    stubProviderOrg(ORG)
  })

  async function seedPresales(status: 'draft' | 'scanned' | 'quoted' | 'archived' = 'scanned') {
    const presales = await repo.create({
      providerOrgId: ORG,
      createdByUserId: UID,
      title: 'Bad Schmidt',
      locationHint: 'Hannover',
      notes: 'Whirlpool gewünscht',
    })
    if (status === 'archived') {
      await repo.update(presales.id, { status: 'scanned' })
      await repo.update(presales.id, { status: 'archived' })
    } else if (status !== 'draft') {
      await repo.update(presales.id, { status: 'scanned' })
      if (status === 'quoted') await repo.update(presales.id, { status: 'quoted' })
    }
    return presales
  }

  it('converts a scanned presales into a job with customer data', async () => {
    const presales = await seedPresales('scanned')

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria Schmidt',
      customerEmail: 'maria@example.com',
      dateLabel: 'Mo, 27. Mai',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const job = jobRepo.getById(result.jobId)
    expect(job).toBeDefined()
    expect(job?.customer).toBe('Maria Schmidt')
    expect(job?.title).toBe('Bad Schmidt')
    expect(job?.location).toBe('Hannover')
    expect(job?.description).toBe('Whirlpool gewünscht')
    expect(job?.status).toBe('new')
    expect(job?.providerId).toBe(ORG)
    expect(job?.craftsmanUserId).toBe(UID)

    const updated = await repo.findById(presales.id)
    expect(updated?.status).toBe('converted')
    expect(updated?.convertedToJobId).toBe(result.jobId)
    expect(updated?.convertedAt).toBeTruthy()
  })

  it('is idempotent on double-tap (returns existing jobId)', async () => {
    const presales = await seedPresales('scanned')

    const first = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })
    const second = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.jobId).toBe(first.jobId)
    expect(second.alreadyExisted).toBe(true)
  })

  it('rejects archived presales', async () => {
    const presales = await seedPresales('archived')

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('presales_archived')
  })

  it('rejects empty customer name', async () => {
    const presales = await seedPresales('scanned')

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: '   ',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_input')
  })

  it('rejects non-existent presales', async () => {
    const result = await createJobFromPresalesProject({
      presalesProjectId: 'does-not-exist',
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('presales_not_found')
  })

  it('uses defaults when optional input is omitted', async () => {
    const presales = await seedPresales('scanned')

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const job = jobRepo.getById(result.jobId)
    expect(job?.dateLabel).toBe('Termin offen')
    expect(job?.paymentState).toBe('deposit_required')
    expect(job?.amount).toBe('')
    expect(job?.documentationStatus).toBe('Noch keine Dokumentation')
  })

  // ── B-P4: workflow-layer RBAC + timeline event ────────────────────────────

  it('rejects unauthenticated callers (Phase B-P4)', async () => {
    const presales = await seedPresales('scanned')
    stubSession(null)

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_authenticated')
  })

  it('rejects callers without provider-org membership (Phase B-P4)', async () => {
    const presales = await seedPresales('scanned')
    stubProviderOrg(null)

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not_provider_member')
  })

  it('cross-org callers are denied — Provider-B cannot convert Provider-A presales (Phase B-P4)', async () => {
    // Seed under Provider-A (default stub).
    const presalesA = await seedPresales('scanned')

    // Switch session to a different provider-org BEFORE the convert call.
    const OTHER_ORG = 'bbbbbbbb-org0-0000-0000-000000000002'
    stubProviderOrg(OTHER_ORG)

    const result = await createJobFromPresalesProject({
      presalesProjectId: presalesA.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('cross_org_denied')

    // Presales remains untouched — no conversion side-effect leaked across the org boundary.
    const stillThere = await repo.findById(presalesA.id)
    expect(stillThere?.status).toBe('scanned')
    expect(stillThere?.convertedToJobId).toBeNull()
  })

  it('emits presales_converted timeline event on success (Phase B-P4)', async () => {
    const presales = await seedPresales('scanned')
    const addSpy = vi.spyOn(timelineMod, 'addTimelineEvent').mockImplementation(() => {})

    const result = await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(addSpy).toHaveBeenCalledTimes(1)
    const event = addSpy.mock.calls[0][0]
    expect(event.type).toBe('presales_converted')
    expect(event.jobId).toBe(result.jobId)
    expect(event.entityId).toBe(presales.id)
  })

  it('does not emit timeline event when conversion fails (Phase B-P4)', async () => {
    const addSpy = vi.spyOn(timelineMod, 'addTimelineEvent').mockImplementation(() => {})

    const result = await createJobFromPresalesProject({
      presalesProjectId: 'missing',
      customerName: 'Maria',
    })

    expect(result.ok).toBe(false)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('emits exactly one event on idempotent double-tap (Phase B-P4)', async () => {
    const presales = await seedPresales('scanned')
    const addSpy = vi.spyOn(timelineMod, 'addTimelineEvent').mockImplementation(() => {})

    await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })
    await createJobFromPresalesProject({
      presalesProjectId: presales.id,
      customerName: 'Maria',
    })

    // Second call short-circuits via `alreadyExisted` BEFORE the timeline emit.
    expect(addSpy).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  resetPresalesProjectRepository()
  setJobRepository(new InMemoryJobRepository())
})
