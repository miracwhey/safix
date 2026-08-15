import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryPresalesProjectRepository } from '../../../src/lib/presales/repository/InMemoryPresalesProjectRepository'
import { canTransition } from '../../../src/domain/presales/presalesProjectTypes'

const PROVIDER_ORG = 'pppppppp-org0-0000-0000-000000000001'
const OTHER_ORG = 'pppppppp-org0-0000-0000-000000000002'
const USER = 'uuuuuuuu-0000-0000-0000-000000000001'

describe('PresalesProject FSM', () => {
  it('allows forward transitions per lifecycle', () => {
    expect(canTransition('draft', 'scanned')).toBe(true)
    expect(canTransition('scanned', 'quoted')).toBe(true)
    expect(canTransition('scanned', 'converted')).toBe(true)
    expect(canTransition('quoted', 'converted')).toBe(true)
    expect(canTransition('draft', 'archived')).toBe(true)
    expect(canTransition('quoted', 'archived')).toBe(true)
  })

  it('blocks backward transitions', () => {
    expect(canTransition('scanned', 'draft')).toBe(false)
    expect(canTransition('quoted', 'scanned')).toBe(false)
    expect(canTransition('converted', 'quoted')).toBe(false)
  })

  it('treats converted + archived as terminal', () => {
    expect(canTransition('converted', 'archived')).toBe(false)
    expect(canTransition('archived', 'draft')).toBe(false)
  })

  it('blocks skip-transitions from draft', () => {
    expect(canTransition('draft', 'quoted')).toBe(false)
    expect(canTransition('draft', 'converted')).toBe(false)
  })
})

describe('InMemoryPresalesProjectRepository', () => {
  let repo: InMemoryPresalesProjectRepository

  beforeEach(() => {
    repo = new InMemoryPresalesProjectRepository()
  })

  it('creates a draft project with sane defaults', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'Aufmaß Bad Schmidt',
    })

    expect(row.id).toBeTruthy()
    expect(row.providerOrgId).toBe(PROVIDER_ORG)
    expect(row.createdByUserId).toBe(USER)
    expect(row.title).toBe('Aufmaß Bad Schmidt')
    expect(row.status).toBe('draft')
    expect(row.scannedAt).toBeNull()
    expect(row.convertedToJobId).toBeNull()
  })

  it('finds by id', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'X',
    })
    const found = await repo.findById(row.id)
    expect(found).toEqual(row)
  })

  it('returns null when not found', async () => {
    const found = await repo.findById('non-existent')
    expect(found).toBeNull()
  })

  it('updates patchable fields without touching others', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'Original',
      notes: 'first',
    })
    const updated = await repo.update(row.id, { title: 'Updated' })
    expect(updated.title).toBe('Updated')
    expect(updated.notes).toBe('first')
    expect(updated.providerOrgId).toBe(PROVIDER_ORG)
    expect(updated.updatedAt >= row.updatedAt).toBe(true)
  })

  it('enforces FSM on status transitions', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'X',
    })
    await expect(
      repo.update(row.id, { status: 'converted' }),
    ).rejects.toThrow(/status transition not allowed/)

    const scanned = await repo.update(row.id, { status: 'scanned' })
    expect(scanned.status).toBe('scanned')
  })

  it('scopes list by providerOrgId', async () => {
    await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'A' })
    await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'B' })
    await repo.create({ providerOrgId: OTHER_ORG, createdByUserId: USER, title: 'C' })

    const mine = await repo.list({ providerOrgId: PROVIDER_ORG })
    const others = await repo.list({ providerOrgId: OTHER_ORG })

    expect(mine).toHaveLength(2)
    expect(others).toHaveLength(1)
    expect(mine.every((p) => p.providerOrgId === PROVIDER_ORG)).toBe(true)
  })

  it('filters list by status', async () => {
    const a = await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'A' })
    await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'B' })
    await repo.update(a.id, { status: 'scanned' })

    const drafts = await repo.list({ providerOrgId: PROVIDER_ORG, status: 'draft' })
    const scanned = await repo.list({ providerOrgId: PROVIDER_ORG, status: 'scanned' })

    expect(drafts).toHaveLength(1)
    expect(scanned).toHaveLength(1)
    expect(drafts[0].title).toBe('B')
    expect(scanned[0].title).toBe('A')
  })

  it('excludes archived when requested', async () => {
    const a = await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'A' })
    await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'B' })
    await repo.update(a.id, { status: 'archived' })

    const active = await repo.list({ providerOrgId: PROVIDER_ORG, excludeArchived: true })
    const all = await repo.list({ providerOrgId: PROVIDER_ORG })

    expect(active).toHaveLength(1)
    expect(all).toHaveLength(2)
  })

  it('removes a project', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'X',
    })
    await repo.remove(row.id)
    expect(await repo.findById(row.id)).toBeNull()
  })

  it('sorts list newest-first', async () => {
    const a = await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'A' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await repo.create({ providerOrgId: PROVIDER_ORG, createdByUserId: USER, title: 'B' })

    const list = await repo.list({ providerOrgId: PROVIDER_ORG })
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it('records conversion metadata', async () => {
    const row = await repo.create({
      providerOrgId: PROVIDER_ORG,
      createdByUserId: USER,
      title: 'X',
    })
    await repo.update(row.id, { status: 'scanned' })
    await repo.update(row.id, { status: 'quoted' })
    const converted = await repo.update(row.id, {
      status: 'converted',
      convertedAt: '2026-05-23T18:30:00.000Z',
      convertedToJobId: 'job-uuid',
    })

    expect(converted.status).toBe('converted')
    expect(converted.convertedAt).toBe('2026-05-23T18:30:00.000Z')
    expect(converted.convertedToJobId).toBe('job-uuid')
  })
})
