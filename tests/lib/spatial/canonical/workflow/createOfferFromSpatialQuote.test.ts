/**
 * Spatial C-10 · C10.3 · Workflow `createOfferFromSpatialQuote` tests.
 *
 * Result-typed coverage — happy path, all four failure reasons, idempotency
 * via local cache + via RPC-side return-existing, BoM → QuoteLineItem +
 * spatial_metadata mapping, conversation-id resolution priority, and
 * documentType pass-through.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { createOfferFromSpatialQuote } from '../../../../../src/lib/spatial/canonical/workflow/createOfferFromSpatialQuote'
import type { CreateOfferFromSpatialQuoteInput } from '../../../../../src/lib/spatial/canonical/workflow/createOfferFromSpatialQuote'
import { InMemoryOfferRepository } from '../../../../../src/lib/offers/repository/InMemoryOfferRepository'
import type { OfferRepository } from '../../../../../src/lib/offers/repository/OfferRepository'
import type {
  SpatialScene,
  SpatialSceneRepository,
} from '../../../../../src/lib/spatial/canonical/repository/SpatialSceneRepository'
import type { BomItem } from '../../../../../src/lib/spatial/canonical/workflow/bomModel'
import * as jobsStore from '../../../../../src/lib/jobs/jobsStore'
import type { Job } from '../../../../../src/lib/jobs/types'
import * as timelineModule from '../../../../../src/lib/timeline'

const SCENE_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = 'e1000000-0000-4000-8000-000000000001'
const CONV_ID = 'c1000000-0000-4000-8000-000000000001'
const CUSTOMER_ID = 'a1000000-0000-4000-8000-000000000001'
const PROVIDER_ORG_ID = 'b1000000-0000-4000-8000-000000000001'

function buildScene(overrides: Partial<SpatialScene> = {}): SpatialScene {
  return {
    id: SCENE_ID,
    sourceScanId: null,
    sourceJobId: JOB_ID,
    parametricStoragePath: 'path/p.bin',
    parametricSha256: null,
    parametricSizeBytes: null,
    parametricUploadedAt: null,
    schemaVersion: '1.0',
    validationState: 'pending',
    validationReport: null,
    isRenderable: false,
    requiresUserConfirmation: false,
    providerId: null,
    providerOrgId: PROVIDER_ORG_ID,
    customerId: CUSTOMER_ID,
    customerVerifyState: null,
    customerVerifyChanges: null,
    customerVerifyAt: null,
    customerVerifyClientGeneration: null,
    customerVerifyClientGenerationAt: null,
    customerVerifyServerGeneration: null,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    parentSceneId: null,
    ...overrides,
  } as SpatialScene
}

function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    projectId: 'proj-1',
    title: 'Bad-Sanierung',
    customer: 'Max Mustermann',
    location: 'Berlin',
    dateLabel: 'KW 22',
    status: 'booked',
    amount: '0',
    description: '',
    paymentState: 'none',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    customerUserId: CUSTOMER_ID,
    sourceConversationId: CONV_ID,
    ...overrides,
  } as Job
}

function buildItems(): BomItem[] {
  return [
    {
      id: 'li-auto-1',
      position: 1,
      description: 'Bodenfliesen',
      category: 'Boden',
      quantity: 12,
      unit: 'm2',
      unitPriceCents: 5000,
      source: 'auto',
      nodeId: 'wall-floor-1',
    },
    {
      id: 'li-manual-1',
      position: 2,
      description: 'Anfahrt + Material-Transport',
      category: 'Sonstiges',
      quantity: 1,
      unit: 'pcs',
      unitPriceCents: 9000,
      source: 'manual',
    },
  ]
}

function buildInput(overrides: Partial<CreateOfferFromSpatialQuoteInput> = {}): CreateOfferFromSpatialQuoteInput {
  return {
    sceneId: SCENE_ID,
    documentType: 'binding_offer',
    totals: { netCents: 69_000, vatCents: 13_110, grossCents: 82_110 },
    vatRatePct: 19,
    lineItems: buildItems(),
    description: 'Bad-Sanierung mit Aufmaß',
    ...overrides,
  }
}

// Lightweight SpatialSceneRepository mock — only the methods this workflow uses.
function buildSceneRepo(scene: SpatialScene | null): SpatialSceneRepository {
  return {
    findById: vi.fn().mockResolvedValue(scene),
  } as unknown as SpatialSceneRepository
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('createOfferFromSpatialQuote · happy path', () => {
  it('maps BoM → QuoteLineItem + spatial_metadata and creates a binding_offer', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())

    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.alreadyExisted).toBe(false)
    expect(result.offer.sourceSpatialSceneId).toBe(SCENE_ID)
    expect(result.offer.documentType).toBe('binding_offer')
    expect(result.offer.conversationId).toBe(CONV_ID)
    expect(result.offer.spatialMetadata?.lineItems).toEqual([
      { lineItemId: 'li-auto-1', source: 'auto', nodeId: 'wall-floor-1' },
      { lineItemId: 'li-manual-1', source: 'manual' },
    ])
    expect(result.offer.lineItems).toEqual([
      {
        id: 'li-auto-1',
        label: 'Bodenfliesen',
        category: 'material',
        netAmount: 60_000,
        quantity: 12,
        unit: 'm2',
      },
      {
        id: 'li-manual-1',
        label: 'Anfahrt + Material-Transport',
        category: 'other',
        netAmount: 9_000,
        quantity: 1,
        unit: 'pcs',
      },
    ])
  })

  it('forwards documentType=cost_estimate when chosen via the UI toggle', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())

    const result = await createOfferFromSpatialQuote(
      buildInput({ documentType: 'cost_estimate' }),
      { offerRepo, sceneRepo },
    )
    if (!result.ok) throw new Error('expected ok')
    expect(result.offer.documentType).toBe('cost_estimate')
    expect(result.offer.contextType).toBe('conversation') // conv-id resolved → 'conversation'
  })

  it('honors explicit conversationId=null (anchors to scene + job, no thread)', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())

    const result = await createOfferFromSpatialQuote(
      buildInput({ conversationId: null }),
      { offerRepo, sceneRepo },
    )
    if (!result.ok) throw new Error('expected ok')
    expect(result.offer.conversationId).toBeNull()
    expect(result.offer.contextType).toBe('project')
  })

  it('falls back to job.sourceConversationId when no explicit override', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob({ sourceConversationId: 'fallback-conv' }))
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())

    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!result.ok) throw new Error('expected ok')
    expect(result.offer.conversationId).toBe('fallback-conv')
  })

  it('NULL conv-id when both override absent and job.sourceConversationId missing', async () => {
    const jobNoConv: Job = { ...buildJob() }
    delete (jobNoConv as { sourceConversationId?: string }).sourceConversationId
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(jobNoConv)
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())

    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!result.ok) throw new Error('expected ok')
    expect(result.offer.conversationId).toBeNull()
  })
})

describe('createOfferFromSpatialQuote · failure reasons', () => {
  it('scene_not_found when sceneRepo returns null', async () => {
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(null)
    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'scene_not_found' }))
  })

  it('scene_missing_job when scene.sourceJobId is null', async () => {
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene({ sourceJobId: null }))
    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'scene_missing_job' }))
  })

  it('job_not_found when getJobById returns undefined', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(undefined)
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const sceneRepo = buildSceneRepo(buildScene())
    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'job_not_found' }))
  })

  it('rpc_rejected when the offerRepo throws (e.g. server 42501)', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const sceneRepo = buildSceneRepo(buildScene())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    // Replace the repo method to simulate a server-side RBAC reject.
    offerRepo.createViaSpatialQuoteRpc = vi
      .fn()
      .mockRejectedValue(new Error('create_spatial_offer: caller X not authorized'))

    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'rpc_rejected',
        message: expect.stringContaining('not authorized'),
      }),
    )
  })
})

describe('createOfferFromSpatialQuote · idempotency', () => {
  it('short-circuits via local cache when a pending offer for the scene already exists', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const sceneRepo = buildSceneRepo(buildScene())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    // First call creates the offer.
    const first = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!first.ok) throw new Error('expected ok')
    const initialCalls = (sceneRepo.findById as ReturnType<typeof vi.fn>).mock.calls.length

    // Second call should NOT re-query the scene repo — cache short-circuit.
    const second = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!second.ok) throw new Error('expected ok')
    expect(second.alreadyExisted).toBe(true)
    expect(second.offer.id).toBe(first.offer.id)
    expect((sceneRepo.findById as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls)
  })

  it('fires `offer_sent` timeline event on first create, NOT on idempotent return', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const sceneRepo = buildSceneRepo(buildScene())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    const ensureSpy = vi.spyOn(timelineModule, 'ensureTimelineEvent')

    const first = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!first.ok) throw new Error('expected ok')
    expect(ensureSpy).toHaveBeenCalledWith({
      jobId: JOB_ID,
      type: 'offer_sent',
      entityId: first.offer.id,
    })
    expect(ensureSpy).toHaveBeenCalledTimes(1)

    // Idempotent second call → no additional event (alreadyExisted=true short-circuits).
    const second = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!second.ok) throw new Error('expected ok')
    expect(ensureSpy).toHaveBeenCalledTimes(1)
  })

  it('flags alreadyExisted=true when the RPC returns a different id (server-side dedupe)', async () => {
    vi.spyOn(jobsStore, 'getJobById').mockReturnValue(buildJob())
    const sceneRepo = buildSceneRepo(buildScene())
    const offerRepo: OfferRepository = new InMemoryOfferRepository()
    // Pre-seed a different offer for the same scene (simulates "another client
    // already created one") and short-circuit the RPC stub to return it.
    const preseeded = await offerRepo.createViaSpatialQuoteRpc({
      id: 'preseeded-id',
      sceneId: SCENE_ID,
      documentType: 'binding_offer',
      price: 1,
      netTotal: 1,
      grossTotal: 1,
      vatAmount: 0,
      vatRate: 0,
    })
    // Clear cache so the workflow does NOT short-circuit on its own pre-check
    // — this simulates the RPC-side return-existing path (cache out-of-sync).
    offerRepo.reset()
    offerRepo.createViaSpatialQuoteRpc = vi.fn().mockResolvedValue(preseeded)

    const result = await createOfferFromSpatialQuote(buildInput(), { offerRepo, sceneRepo })
    if (!result.ok) throw new Error('expected ok')
    expect(result.alreadyExisted).toBe(true)
    expect(result.offer.id).toBe('preseeded-id')
  })
})
