/**
 * Portfolio Item Service — Source-of-Truth Contract
 *
 * Freezes the canonical data contracts in portfolioItemService.ts so future
 * changes cannot silently break the published/unpublished visibility split,
 * the provider_media table source, or the delete safety guard.
 *
 * Frozen invariants:
 *   A. Both read functions query provider_media with kind='portfolio'
 *   B. fetchPublicPortfolio filters published=true (public view: no drafts)
 *   C. fetchOwnerPortfolio does NOT filter by published (owner sees all)
 *   D. deletePortfolioItem: portfolio-owned asset paths → delete storage files
 *   E. deletePortfolioItem: non-portfolio asset paths → skip storage delete
 *   F. Both create paths insert kind='portfolio' into provider_media
 *   G. No writes to media_uploads (old showcase system)
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/lib/providerMedia/portfolioItemService.ts'),
  'utf-8',
)

// ─── A. Table source ─────────────────────────────────────────────────────────

describe('portfolioItemService: table source', () => {
  it("all queries target 'provider_media' or 'provider_media_assets' tables", () => {
    // M1: assets are read/written via provider_media_assets; parent rows via provider_media
    const allowed = new Set(['provider_media', 'provider_media_assets'])
    const fromCalls = source.match(/\.from\(['"`](\w+)['"`]\)/g) ?? []
    const tables = fromCalls.map((c) => c.replace(/\.from\(['"`]|['"`]\)/g, ''))
    const unexpected = tables.filter((t) => !allowed.has(t))
    expect(unexpected).toEqual([])
  })

  it("PORTFOLIO_COLUMNS includes 'kind'", () => {
    expect(source).toContain("'kind'")
  })

  it("PORTFOLIO_COLUMNS includes 'h264_url' (Block 0 transcode fallback)", () => {
    expect(source).toContain("'h264_url'")
  })

  it("rowToPortfolioItem sets kind to 'portfolio'", () => {
    expect(source).toContain("kind: 'portfolio'")
  })

  it('rowToPortfolioItem maps row.h264_url → item.h264Url', () => {
    expect(source).toContain('h264Url: row.h264_url ?? null')
  })
})

// ─── B. fetchPublicPortfolio: published=true filter ──────────────────────────

describe('portfolioItemService: fetchPublicPortfolio', () => {
  // Isolate the fetchPublicPortfolio function body
  const publicFnStart = source.indexOf('export async function fetchPublicPortfolio')
  const publicFnEnd = source.indexOf('\nexport ', publicFnStart + 1)
  const publicFnBody = source.slice(publicFnStart, publicFnEnd > -1 ? publicFnEnd : undefined)

  it('filters by kind=portfolio', () => {
    expect(publicFnBody).toContain(".eq('kind', 'portfolio')")
  })

  it("filters by published=true", () => {
    expect(publicFnBody).toContain(".eq('published', true)")
  })

  it('orders by sort_order descending (newest first)', () => {
    // Inserts use sort_order = Date.now(); a larger value means "more recent".
    // Reading DESC therefore puts the freshest publish at the head of the
    // Reels grid. See portfolioItemService for the M1 refresh-block comment.
    expect(publicFnBody).toContain("order('sort_order'")
    expect(publicFnBody).toContain('ascending: false')
  })
})

// ─── C. fetchOwnerPortfolio: no published filter ─────────────────────────────

describe('portfolioItemService: fetchOwnerPortfolio', () => {
  const ownerFnStart = source.indexOf('export async function fetchOwnerPortfolio')
  const ownerFnEnd = source.indexOf('\nexport ', ownerFnStart + 1)
  const ownerFnBody = source.slice(ownerFnStart, ownerFnEnd > -1 ? ownerFnEnd : undefined)

  it('filters by kind=portfolio', () => {
    expect(ownerFnBody).toContain(".eq('kind', 'portfolio')")
  })

  it('does NOT filter by published (owner sees all)', () => {
    expect(ownerFnBody).not.toContain(".eq('published'")
    expect(ownerFnBody).not.toContain(".eq(\"published\"")
  })

  it('orders by sort_order descending (newest first)', () => {
    // Mirrors fetchPublicPortfolio so owner and customer see the same
    // ordering — newest publish at the head of the grid.
    expect(ownerFnBody).toContain("order('sort_order'")
    expect(ownerFnBody).toContain('ascending: false')
  })
})

// ─── D & E. deletePortfolioItem: storage guard ───────────────────────────────

describe('portfolioItemService: delete storage guard', () => {
  const deleteFnStart = source.indexOf('export async function deletePortfolioItem')
  const deleteFnBody = source.slice(deleteFnStart)

  it("deletes storage only when path starts with 'portfolio/' (M2: iterates asset array)", () => {
    expect(deleteFnBody).toContain("startsWith('portfolio/')")
  })

  it('always deletes the DB row regardless of storage paths', () => {
    // The DB delete is unconditional — it must appear OUTSIDE the storage guard
    const guardEnd = deleteFnBody.indexOf("// Always delete the DB row")
    expect(guardEnd).toBeGreaterThan(-1)
    const afterGuard = deleteFnBody.slice(guardEnd)
    expect(afterGuard).toContain('.delete()')
    expect(afterGuard).toContain(".eq('kind', 'portfolio')")
  })

  it('guards DB delete with eq kind=portfolio (prevents cross-kind deletes)', () => {
    expect(deleteFnBody).toContain(".eq('kind', 'portfolio')")
  })

  it('treats not-found storage errors as safe (no throw on 404)', () => {
    expect(deleteFnBody).toContain('isNotFound')
    expect(deleteFnBody).toContain('not.?found')
  })

  it('M2: accepts assets array and removes all portfolio-owned paths in one call', () => {
    // deletePortfolioItem now takes PortfolioAsset[] not a single storagePath
    expect(deleteFnBody).toContain('assets: PortfolioAsset[]')
    expect(deleteFnBody).toContain('.remove(portfolioPaths)')
  })
})

// ─── F. Create paths insert kind='portfolio' ─────────────────────────────────

describe('portfolioItemService: create paths', () => {
  it("createPortfolioItemFromUpload inserts kind: 'portfolio'", () => {
    const uploadFnStart = source.indexOf('export async function createPortfolioItemFromUpload')
    const uploadFnEnd = source.indexOf('\nexport ', uploadFnStart + 1)
    const uploadFnBody = source.slice(uploadFnStart, uploadFnEnd)
    expect(uploadFnBody).toContain("kind: 'portfolio'")
  })

  it("createPortfolioItemFromJob inserts kind: 'portfolio'", () => {
    const jobFnStart = source.indexOf('export async function createPortfolioItemFromJob')
    const jobFnEnd = source.indexOf('\nexport ', jobFnStart + 1)
    const jobFnBody = source.slice(jobFnStart, jobFnEnd)
    expect(jobFnBody).toContain("kind: 'portfolio'")
  })

  it('orphan cleanup on DB failure after upload', () => {
    // createPortfolioItemFromUpload must roll back the just-uploaded
    // record if the provider_media insert fails. Phase-2 routes the
    // rollback through the shared helper instead of duplicating the
    // string-matched logic here.
    expect(source).toContain('rollbackOrphanedUpload(')
    expect(source).toContain("from './uploadRollback'")
    // M2: deletePortfolioItem uses .remove(portfolioPaths) for N-asset bulk delete.
    expect(source).toContain('.remove(portfolioPaths)')
  })
})

// ─── G. No writes to media_uploads ───────────────────────────────────────────

describe('portfolioItemService: no media_uploads writes', () => {
  it("does not write to 'media_uploads' table", () => {
    // Any insert/update targeting media_uploads would be a regression to the old system
    const insertCalls = source.match(/\.from\(['"`]media_uploads['"`]\)\s*\.(insert|update|upsert)/g)
    expect(insertCalls ?? []).toHaveLength(0)
  })
})

// ─── H. exploreProfileService: public portfolio source ───────────────────────

describe('exploreProfileService: public portfolio delegation', () => {
  const exploreSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/lib/explore/exploreProfileService.ts'),
    'utf-8',
  )

  it('imports fetchPublicPortfolio from portfolioItemService', () => {
    expect(exploreSource).toContain('fetchPublicPortfolio')
    expect(exploreSource).toContain('portfolioItemService')
  })

  it('does NOT import fetchOwnerPortfolio', () => {
    expect(exploreSource).not.toContain('fetchOwnerPortfolio')
  })

  it("public portfolio query also uses kind='portfolio' guard", () => {
    expect(exploreSource).toContain("eq('kind', 'portfolio')")
  })

  it('public portfolio only includes published=true items', () => {
    // Either via fetchPublicPortfolio (which filters) or inline
    const usesFetchPublic = exploreSource.includes('fetchPublicPortfolio')
    const filtersPublished = exploreSource.includes(".eq('published', true)")
    expect(usesFetchPublic || filtersPublished).toBe(true)
  })
})
