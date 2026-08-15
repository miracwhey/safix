import { describe, it, expect } from 'vitest'
import {
  composerTilesFor,
  groupComposerTiles,
} from '../../src/components/chat/composerTiles'

describe('composerTilesFor', () => {
  it('craftsman has 3 offer subtypes + change-order + photo + document + video', () => {
    const tiles = composerTilesFor('craftsman')
    const ids = tiles.map((t) => t.id)
    expect(ids).toContain('offer-binding')
    expect(ids).toContain('offer-estimate')
    expect(ids).toContain('offer-diagnosis')
    expect(ids).toContain('change-order')
    expect(ids).toContain('photo')
    expect(ids).toContain('document')
    expect(ids).toContain('video')
    expect(ids).toHaveLength(7)
  })

  it('craftsman tiles map to canonical OfferDocumentType', () => {
    const offers = composerTilesFor('craftsman').filter((t) => t.kind.type === 'offer')
    const docTypes = offers.flatMap((t) => (t.kind.type === 'offer' ? [t.kind.documentType] : []))
    expect(docTypes).toEqual(['binding_offer', 'estimate', 'diagnosis'])
  })

  it('customer gets project-attach + media tiles only — no offer tiles', () => {
    const tiles = composerTilesFor('customer')
    const ids = tiles.map((t) => t.id)
    expect(ids).toEqual(['project-attach', 'photo', 'document', 'video'])
    expect(tiles.some((t) => t.kind.type === 'offer')).toBe(false)
  })

  it('worker gets only photo + document + video', () => {
    const tiles = composerTilesFor('worker')
    expect(tiles.map((t) => t.id)).toEqual(['photo', 'document', 'video'])
  })

  it('owner / admin inherit the craftsman tile set', () => {
    expect(composerTilesFor('owner')).toEqual(composerTilesFor('craftsman'))
    expect(composerTilesFor('admin')).toEqual(composerTilesFor('craftsman'))
  })

  it('every tile carries label, hint and an iconKey', () => {
    for (const role of ['customer', 'craftsman', 'worker'] as const) {
      for (const tile of composerTilesFor(role)) {
        expect(tile.label.length).toBeGreaterThan(0)
        expect(tile.hint.length).toBeGreaterThan(0)
        expect(tile.iconKey.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('groupComposerTiles', () => {
  it('splits craftsman tiles into 4 workflow + 3 attachment', () => {
    const sections = groupComposerTiles(composerTilesFor('craftsman'))
    expect(sections.workflow.map((t) => t.id)).toEqual([
      'offer-binding',
      'offer-estimate',
      'offer-diagnosis',
      'change-order',
    ])
    expect(sections.attachment.map((t) => t.id)).toEqual(['photo', 'document', 'video'])
  })

  it('customer has exactly 1 workflow tile and 3 attachment tiles', () => {
    const sections = groupComposerTiles(composerTilesFor('customer'))
    expect(sections.workflow).toHaveLength(1)
    expect(sections.attachment).toHaveLength(3)
  })

  it('worker has no workflow tiles', () => {
    const sections = groupComposerTiles(composerTilesFor('worker'))
    expect(sections.workflow).toHaveLength(0)
    expect(sections.attachment).toHaveLength(3)
  })

  it('preserves the order of tiles inside each section', () => {
    const tiles = composerTilesFor('craftsman')
    const sections = groupComposerTiles(tiles)
    const all = [...sections.workflow, ...sections.attachment]
    const ids = all.map((t) => t.id)
    expect(ids[0]).toBe('offer-binding')
    expect(ids[ids.length - 1]).toBe('video')
  })
})
