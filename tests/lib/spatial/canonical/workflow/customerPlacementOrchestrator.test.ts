/**
 * Host-aware Katalog-Platzierung — placeCatalogAsset.
 *
 * Lockt den Vertrag: ein gewähltes Asset landet an seinem AUTORITATIVEN Host
 * (snapRule.target_host), nicht mehr in der „gehört an Wand"-Sackgasse. Deckt
 * Boden/Wand/Decke + Override-Fälle (Stehlampe: category 'lamp' aber host
 * 'floor') + falsche-Fläche-Hinweis (Tool bleibt scharf) + counter-defer ab.
 */
import { describe, expect, it } from 'vitest'

import { placeCatalogAsset } from '../../../../../src/lib/spatial/canonical/workflow/customerPlacementOrchestrator.ts'
import { makeRoom } from '../__helpers__/sceneFactory.ts'

const NOW = '2026-05-31T00:00:00.000Z'

function asset(overrides: Partial<Parameters<typeof placeCatalogAsset>[0]['asset']> = {}) {
  return {
    slug: 'furn-chair',
    objectCategory: 'chair' as const,
    dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 0.8 },
    host: 'floor' as const,
    displayName: 'Stuhl',
    ...overrides,
  }
}

describe('placeCatalogAsset — floor host', () => {
  it('places a floor asset on a floor tap into floor_mounted', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset(),
      newId: 'a',
      generatedAt: NOW,
      tappedKind: 'floor',
      surfaceId: 'floor',
      worldXyz: { x: 1.5, y: 0, z: 1.5 },
    })
    expect(r.kind).toBe('placed')
    if (r.kind !== 'placed') return
    expect(r.host).toBe('floor')
    expect(r.scene.floor.floor_mounted.map((o) => o.id)).toEqual(['a'])
    expect(r.scene.floor.floor_mounted[0].host).toBe('floor')
  })

  it('REGRESSION: a floor-host OVERRIDE asset (Stehlampe: category lamp) is NOT rejected', () => {
    // category 'lamp' defaults to 'ceiling' in CATEGORY_DEFAULT_HOST, but the
    // catalog snapRule overrides the floor lamp to host 'floor'. The orchestrator
    // must trust the authoritative host and place it (placeFurniture would have
    // re-derived 'ceiling' and rejected — the old bug).
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ slug: 'furn-floor-lamp', objectCategory: 'lamp', host: 'floor', displayName: 'Stehlampe', dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 1.6 } }),
      newId: 'lamp',
      generatedAt: NOW,
      tappedKind: 'floor',
      surfaceId: 'floor',
      worldXyz: { x: 2, y: 0, z: 1.5 },
    })
    expect(r.kind).toBe('placed')
  })

  it('floor asset on a WALL tap → wrong-surface, nothing placed, tool stays armed', () => {
    const scene = makeRoom()
    const r = placeCatalogAsset({
      scene,
      asset: asset(),
      newId: 'a',
      generatedAt: NOW,
      tappedKind: 'wall',
      surfaceId: 'w_s',
      worldXyz: { x: 2, y: 0.5, z: 0 },
    })
    expect(r.kind).toBe('wrong-surface')
    expect(scene.floor.floor_mounted).toHaveLength(0)
  })
})

describe('placeCatalogAsset — wall host', () => {
  it('places a wall asset on a wall tap into wall_mounted at tap offset/height', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ slug: 'furn-mirror', objectCategory: 'mirror', host: 'wall', displayName: 'Spiegel', dimensions: { width_m: 0.6, depth_m: 0.05, height_m: 0.8 } }),
      newId: 'm',
      generatedAt: NOW,
      tappedKind: 'wall',
      surfaceId: 'w_s',
      worldXyz: { x: 2, y: 1.4, z: 0 },
    })
    expect(r.kind).toBe('placed')
    if (r.kind !== 'placed') return
    expect(r.host).toBe('wall')
    expect(r.wallId).toBe('w_s')
    const wall = r.scene.walls.find((w) => w.id === 'w_s')!
    expect(wall.wall_mounted.map((o) => o.id)).toEqual(['m'])
    const obj = wall.wall_mounted[0]
    expect(obj.host).toBe('wall')
    // Tap-Y 1.4 ist CENTER → bottom ≈ 1.4 − 0.8/2 = 1.0.
    expect(obj.height_from_floor_m).toBeCloseTo(1.0, 2)
    // Tap-X 2 (Wand entlang X von 0..4) → left edge ≈ 2 − 0.6/2 = 1.7.
    expect(obj.offset_along_wall_m).toBeCloseTo(1.7, 1)
  })

  it('wall asset WITHOUT tap-Y uses the category default center height (Spiegel 1.55)', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ slug: 'furn-mirror', objectCategory: 'mirror', host: 'wall', displayName: 'Spiegel', dimensions: { width_m: 0.6, depth_m: 0.05, height_m: 0.8 } }),
      newId: 'm',
      generatedAt: NOW,
      tappedKind: 'wall',
      surfaceId: 'w_s',
      // no worldXyz → no tap-Y → default center 1.55 → bottom ≈ 1.15
    })
    expect(r.kind).toBe('placed')
    if (r.kind !== 'placed') return
    const obj = r.scene.walls.find((w) => w.id === 'w_s')!.wall_mounted[0]
    expect(obj.height_from_floor_m).toBeCloseTo(1.15, 2)
  })

  it('wall asset on a FLOOR tap → wrong-surface', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ objectCategory: 'mirror', host: 'wall', displayName: 'Spiegel' }),
      newId: 'm',
      generatedAt: NOW,
      tappedKind: 'floor',
      surfaceId: 'floor',
      worldXyz: { x: 1.5, y: 0, z: 1.5 },
    })
    expect(r.kind).toBe('wrong-surface')
  })
})

describe('placeCatalogAsset — ceiling host', () => {
  it('places a ceiling asset from a FLOOR tap into ceiling_mounted (mount above)', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ slug: 'furn-ceiling-lamp', objectCategory: 'lamp', host: 'ceiling', displayName: 'Deckenleuchte', dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.3 } }),
      newId: 'c',
      generatedAt: NOW,
      tappedKind: 'floor',
      surfaceId: 'floor',
      worldXyz: { x: 2, y: 0, z: 1.5 },
    })
    expect(r.kind).toBe('placed')
    if (r.kind !== 'placed') return
    expect(r.host).toBe('ceiling')
    expect(r.scene.ceiling.ceiling_mounted.map((o) => o.id)).toEqual(['c'])
    const obj = r.scene.ceiling.ceiling_mounted[0]
    expect(obj.host).toBe('ceiling')
    // X/Z aus dem Boden-Tap übernommen (Lampe hängt darüber).
    expect(obj.transform.position.x).toBeCloseTo(2, 5)
    expect(obj.transform.position.z).toBeCloseTo(1.5, 5)
  })

  it('ceiling asset on a WALL tap → wrong-surface', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ objectCategory: 'lamp', host: 'ceiling', displayName: 'Deckenleuchte' }),
      newId: 'c',
      generatedAt: NOW,
      tappedKind: 'wall',
      surfaceId: 'w_s',
      worldXyz: { x: 2, y: 1, z: 0 },
    })
    expect(r.kind).toBe('wrong-surface')
  })
})

describe('placeCatalogAsset — counter/corner host (deferred)', () => {
  it('counter host → unsupported (table lamp)', () => {
    const r = placeCatalogAsset({
      scene: makeRoom(),
      asset: asset({ objectCategory: 'lamp', host: 'counter', displayName: 'Tischlampe' }),
      newId: 't',
      generatedAt: NOW,
      tappedKind: 'floor',
      surfaceId: 'floor',
      worldXyz: { x: 1.5, y: 0, z: 1.5 },
    })
    expect(r.kind).toBe('unsupported')
  })
})
