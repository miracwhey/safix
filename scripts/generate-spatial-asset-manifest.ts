/**
 * Generate the Spatial binary-asset manifest.
 *
 * The catalog seeds reference Storage paths; the binary files behind those
 * paths are NOT in the bundle — they are CC0 downloads. This script derives,
 * from the TS catalog, the exact list of binaries to fetch and writes it to:
 *
 *   public/spatial-assets/asset-manifest.json
 *
 * `scripts/download-spatial-catalog.sh` consumes this manifest. Re-run after
 * a catalog change:
 *   npx tsx scripts/generate-spatial-asset-manifest.ts
 *
 * Blocks:
 *   - materials     — 31 ambientCG PBR sets (deterministic CC0 zip URLs).
 *   - hdris         — 8 Polyhaven HDRIs (deterministic CC0 EXR URLs).
 *   - polyPizzaModels — 14 poly.pizza CC0 GLBs (5 fixtures + 9 furniture,
 *     B-6). Deterministic `static.poly.pizza/{uuid}.glb` CDN URLs, no login.
 *     Downloaded raw to `_raw/`, then re-pivoted by `repivot-spatial-glb.ts`.
 *   - models        — remaining `glb` catalog slots without a poly.pizza
 *     source (the Polyhaven mirror) — manual visual sighting.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MATERIAL_CATALOG } from '../src/lib/spatial/canonical/catalog/material-catalog.ts'
import { ASSET_CATALOG } from '../src/lib/spatial/canonical/catalog/asset-catalog.ts'
import { LIGHTING_PRESETS } from '../src/lib/spatial/canonical/lighting/presets.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'public', 'spatial-assets')
const OUT_FILE = join(OUT_DIR, 'asset-manifest.json')

// ── B-6 · poly.pizza CC0 source map ───────────────────────────────────────────
//
// poly.pizza model-page id + the direct `static.poly.pizza/{uuid}.glb` CDN
// uuid (the page id and the CDN uuid differ). All verified 2026-05-21,
// magic-byte `676c5446` checked. `sanitary-sink-pedestal-classic` deliberately
// maps to the Kenney "Bathroom Sink" (iUz9JXhDE1) — the visual review found
// that model is the pedestal sink, not the wall-hung basin.

interface PolyPizzaSource {
  pageId: string
  glbUuid: string
  creator: 'Quaternius' | 'Kenney'
}

const POLY_PIZZA: Readonly<Record<string, PolyPizzaSource>> = {
  // Fixtures (5)
  'sanitary-toilet-standard-floor': {
    pageId: 'WAu50yGFVt',
    glbUuid: 'e3c404e8-3149-49ca-92dc-a81d972b71b8',
    creator: 'Quaternius',
  },
  'sanitary-sink-pedestal-classic': {
    pageId: 'iUz9JXhDE1',
    glbUuid: '6c0b7fe1-8e06-4940-98ba-52dd18df00b3',
    creator: 'Kenney',
  },
  'sanitary-bathtub-builtin-rectangle': {
    pageId: 'kVFRyNEn4F',
    glbUuid: '72c078cf-f0cb-45dc-b9b6-e732e980576e',
    creator: 'Kenney',
  },
  'kitchen-refrigerator-freestanding-tall': {
    pageId: '8sjRm8fnHh',
    glbUuid: 'f4b6db1d-0eed-48b1-9a59-df879aaee393',
    creator: 'Quaternius',
  },
  'kitchen-microwave-countertop': {
    pageId: 'vUsvf2HGDv',
    glbUuid: '69b6d111-3ae6-4f6d-8f23-4ded92a021ab',
    creator: 'Kenney',
  },
  // Furniture (9 — `furn-mirror-round-wall` has no CC0 match, stays Polyhaven)
  'furn-sofa-3seater-fabric-grey': {
    pageId: '6MoOyPtetL',
    glbUuid: '7ac6188b-72be-4c82-81c8-85deab020a1c',
    creator: 'Quaternius',
  },
  'furn-armchair-fabric-rounded': {
    pageId: 'ZOPP3KzNIk',
    glbUuid: '4e8fbbf3-9992-4068-8918-2126a0304127',
    creator: 'Quaternius',
  },
  'furn-coffee-table-round-wood': {
    pageId: '57W671WvS2',
    glbUuid: 'ac80f0dc-0763-4c8b-976a-5e26e9d6805e',
    creator: 'Quaternius',
  },
  'furn-dining-table-rectangle-6': {
    pageId: 'yYEEJzKxb4',
    glbUuid: 'f336a76f-4a55-49e5-916d-57151d7add56',
    creator: 'Quaternius',
  },
  'furn-dining-chair-wood-fabric': {
    pageId: 'iMNqRzPwwe',
    glbUuid: '84ecc6a3-2751-4f50-912a-b9f4ff033d7a',
    creator: 'Quaternius',
  },
  'furn-bed-double-frame-headboard': {
    pageId: 'BuRay4fVFr',
    glbUuid: 'c742a711-d307-4e30-ad86-83a0ddca850d',
    creator: 'Quaternius',
  },
  'furn-wardrobe-3door-tall': {
    pageId: 'BHEVb1DIuH',
    glbUuid: '87908291-7b01-45e9-90b9-fe41d63f511b',
    creator: 'Quaternius',
  },
  'furn-shelf-open-5tier-wood': {
    pageId: 'MTH8ZwnA27',
    glbUuid: '867fee8d-2b89-4383-92f9-58660a76d29a',
    creator: 'Kenney',
  },
  'furn-floor-lamp-tripod': {
    pageId: '8LiDIfXVLi',
    glbUuid: '98dd45a1-0682-4d44-83d1-32fa2a4fca5b',
    creator: 'Kenney',
  },
  // ── Batch-1 expansion 2026-05-28 · 8 high-priority gap-fillers ─────────────
  // Audit: 5 parallel Asset-Subagents + poly.pizza HEAD-verification 200 OK.
  // Closes Plan-Sub-Kategorien Nachttisch / Kommode / TV-Möbel / Schreibtisch /
  // Bürostuhl / Deckenleuchte / Pendelleuchte / Tischlampe.
  'furn-nightstand-2drawer': {
    pageId: 'A9vPgVUrF9',
    glbUuid: '1c26c1fe-7fb1-4511-b5f0-3dd73ea10c86',
    creator: 'Quaternius',
  },
  'furn-dresser-tall-3drawer': {
    pageId: 'T4uDbyP90C',
    glbUuid: 'cbb56f0d-6215-4b63-973b-a4ac146a9a9d',
    creator: 'Quaternius',
  },
  'furn-tv-cabinet-lowboard': {
    pageId: 'AL6wwiUgP3',
    glbUuid: '7281f563-73a5-4907-ae55-7ede647c4e0e',
    creator: 'Kenney',
  },
  'furn-desk-rectangular': {
    pageId: 'V86Go2rlnq',
    glbUuid: '91c2bf8d-0876-4801-abd3-8dd5d017ecbd',
    creator: 'Quaternius',
  },
  'furn-office-chair-modern': {
    pageId: 'CKSz6PB1vO',
    glbUuid: '64699642-a4c2-4850-9c4b-558a328ed1bf',
    creator: 'Kenney',
  },
  'furn-light-ceiling-flush-mount': {
    pageId: 'S3HkX8iTl2',
    glbUuid: '9c07c95e-c245-4db4-80eb-702fef5045ae',
    creator: 'Quaternius',
  },
  'furn-light-pendant-dome': {
    pageId: 'KGq88JUIJo',
    glbUuid: '892a636e-d8fe-4a49-a3bf-27c85575bce9',
    creator: 'Quaternius',
  },
  'furn-light-table-lamp': {
    pageId: 'auXnXwXD7S',
    glbUuid: 'a9a2edf1-20f0-4069-846a-f1fc4717c2e8',
    creator: 'Kenney',
  },
  'furn-plant-medium': {
    pageId: 'bfLOqIV5uP',
    glbUuid: '1683c0b1-4dd9-4d45-910e-cf3e46f163f5',
    creator: 'Quaternius',
  },
  // ── Phase 1.2 expansion 2026-05-28 · 19 bulk gap-fillers ───────────────────
  // Quaternius+Kenney via poly.pizza HEAD-200 verified. Closes Möbel-Bulk
  // (10 + 4 lighting), towel-rail, oven+cooktop, 2 decor-plants. Skipped:
  // 5 architecture doors/windows (existing arch-* is procedural by design,
  // catalog-comment §307-309) + 4 enum-extension-needing slugs
  // (washing_machine, toilet_paper_holder, curtains, fireplace) deferred
  // to Batch-2 with src/lib/spatial/canonical/types/objects.ts enum delta.
  'furn-bunk-bed': {
    pageId: 'XpysaEDXJQ',
    glbUuid: '08f2696d-8162-4539-9b10-00f7dfff23b9',
    creator: 'Quaternius',
  },
  'furn-bed-king': {
    pageId: '3kiLmRcb1o',
    glbUuid: '11aecce8-a04f-4e56-8076-9ed2033ce5c8',
    creator: 'Quaternius',
  },
  'furn-bed-single': {
    pageId: 'sn8az3odMR',
    glbUuid: '412f5303-86bc-48b2-aaeb-99393c0a4004',
    creator: 'Kenney',
  },
  'furn-stool-round': {
    pageId: 'TvaOenUAni',
    glbUuid: '6ee9a20a-99f8-4c05-a30c-248b102a16ec',
    creator: 'Quaternius',
  },
  'furn-table-round-small': {
    pageId: 'oEArSZykyi',
    glbUuid: 'c8fa18f9-e1e9-4aed-905d-cbc945cb44d9',
    creator: 'Quaternius',
  },
  'furn-table-round-large': {
    pageId: 'AXbvcMDC8j',
    glbUuid: 'edb7217c-389f-4233-bfa5-aca3fe649e7c',
    creator: 'Kenney',
  },
  'furn-couch-l-sectional': {
    pageId: '1kwsjhpY84',
    glbUuid: '7cf27481-8505-42f8-9172-ce209242de09',
    creator: 'Quaternius',
  },
  'furn-couch-2seater': {
    pageId: 'vRMLQC5Dfg',
    glbUuid: '00de7fa2-1b21-44c8-afe9-fb35b9fde5d1',
    creator: 'Quaternius',
  },
  'furn-cabinet-tall-storage': {
    pageId: 'dUd80gOqgO',
    glbUuid: '44d13b75-c154-4f11-8c4e-4e57ac3093f7',
    creator: 'Kenney',
  },
  'furn-sideboard-modern': {
    pageId: 'CBUx8ZMVAO',
    glbUuid: '23545cc3-34b7-42c2-bdcb-fb09f4933282',
    creator: 'Quaternius',
  },
  'furn-light-chandelier': {
    pageId: 'q3k8I8YYX9',
    glbUuid: '86ac4661-fcea-49d9-9871-c9836b8ddf19',
    creator: 'Quaternius',
  },
  'furn-light-wall-sconce': {
    pageId: '74FEuNrLJ5',
    glbUuid: '9bb14661-b467-4c18-9c25-f5dd37b8df06',
    creator: 'Kenney',
  },
  'furn-light-floor-arc': {
    pageId: 'eBQtooeh43',
    glbUuid: '19259c43-99cb-43c6-aaee-dcf8d1d36fdb',
    creator: 'Quaternius',
  },
  'furn-light-desk-task': {
    pageId: 'uJDWrSJGVH',
    glbUuid: '2e1ab34a-eab6-4751-930f-6e3b4f5319a8',
    creator: 'Quaternius',
  },
  'decor-cactus': {
    pageId: 'HsEJgRLQWX',
    glbUuid: 'c9bfa77b-fc43-402a-aee4-f34b2581b0f6',
    creator: 'Quaternius',
  },
  'decor-houseplant-tall': {
    pageId: 'MbhbP7JrTI',
    glbUuid: 'e2b7d78c-f237-4ee8-be1a-62a809097d64',
    creator: 'Quaternius',
  },
  'sanitary-towel-rack': {
    pageId: '8R9fXwL11r',
    glbUuid: '1748df2d-c41a-4815-81ef-a25a3ee29cbe',
    creator: 'Quaternius',
  },
  'kitchen-oven-standing': {
    pageId: 'VNjPRwui7t',
    glbUuid: '9da28115-a156-414e-ab66-159052279eaf',
    creator: 'Quaternius',
  },
  'kitchen-stove-cooktop': {
    pageId: 'kTJU2y4R15',
    glbUuid: '20ac0ba3-07c3-4ec5-ad2c-dc1b836c3006',
    creator: 'Kenney',
  },
  // ── Batch-2 expansion 2026-05-28 · 4 enum-extension slugs ──────────────────
  // washing_machine + toilet_paper_holder + curtains + fireplace — the slugs
  // deferred from Phase 1.2 (needed ObjectCategory enum delta, now landed).
  // All Quaternius CC0, HEAD-200 verified.
  'sanitary-washing-machine': {
    pageId: 'UFxsKNSl8W',
    glbUuid: 'e6b5e36e-6541-47be-992e-9b3bf0196321',
    creator: 'Quaternius',
  },
  'sanitary-toilet-paper-holder': {
    pageId: 'pZojeda7ye',
    glbUuid: '1a9ccc8f-c1b8-4974-adaa-1685f28c155d',
    creator: 'Quaternius',
  },
  'decor-curtains-double': {
    pageId: 'kkeII96j9N',
    glbUuid: 'cf707f1b-8d82-467d-b89e-e4c1322f4515',
    creator: 'Quaternius',
  },
  'decor-fireplace': {
    pageId: 'nzxZYIOCIr',
    glbUuid: '7841807d-cab9-46e2-95c2-1ca0bbee5736',
    creator: 'Quaternius',
  },
  'decor-rug': {
    pageId: '7H5qKjuxVY',
    glbUuid: '93588780-3405-40b7-acb4-9a87c88569f6',
    creator: 'Quaternius',
  },
}

// ── Materials — ambientCG CC0 ─────────────────────────────────────────────────

const materials = MATERIAL_CATALOG.filter((m) => !m.procedural && m.acgId).map((m) => ({
  slug: m.slug,
  acgId: m.acgId,
  /** Full PBR stack (Color/Normal/Roughness/AO/Displacement) — 1K JPG zip. */
  pbrZipUrl: `https://ambientcg.com/get?file=${m.acgId}_1K-JPG.zip`,
  /** Flat albedo preview — also the source for the 256² picker thumbnail. */
  albedoPreviewUrl:
    `https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/${m.acgId}/${m.acgId}_SQ_Color.jpg`,
  /** Raw JPG staging dir — `optimize-spatial-assets.ts` converts to KTX2. */
  stagingDir: `public/spatial-assets/materials/${m.slug}`,
  thumbnailTarget: `public/spatial-assets/materials/thumbnails/${m.slug}.jpg`,
  license: m.license,
}))

// ── HDRIs — Polyhaven CC0 ─────────────────────────────────────────────────────

const hdris = LIGHTING_PRESETS.map((p) => ({
  presetId: p.id,
  polyhavenSlug: p.polyhavenSlug,
  exr2kUrl: `https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/2k/${p.polyhavenSlug}_2k.exr`,
  exr1kUrl: `https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/1k/${p.polyhavenSlug}_1k.exr`,
  panoramaThumbUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${p.polyhavenSlug}.png?height=160`,
  exr2kTarget: `public/spatial-assets/hdri/${p.polyhavenSlug}_2k.exr`,
  exr1kTarget: `public/spatial-assets/hdri/${p.polyhavenSlug}_1k.exr`,
  /** Picker thumbnail — crop the panorama to 200×56 (sips), preview spheres out. */
  thumbnailTarget: `public/spatial-assets/hdri/thumbnails/${p.polyhavenSlug}.png`,
  license: 'CC0-1.0',
}))

// ── poly.pizza models — CC0 GLB, deterministic CDN URLs (B-6) ─────────────────

const glbAssets = ASSET_CATALOG.filter((a) => a.geometryKind === 'glb')

const polyPizzaModels = glbAssets
  .filter((a) => POLY_PIZZA[a.slug])
  .map((a) => {
    const src = POLY_PIZZA[a.slug]
    return {
      slug: a.slug,
      category: a.category,
      displayName: a.displayName,
      vendor: 'poly.pizza',
      creator: src.creator,
      polyPizzaId: src.pageId,
      sourceUrl: `https://poly.pizza/m/${src.pageId}`,
      /** Direct CDN GLB — no login, magic-byte `676c5446` verified. */
      glbUrl: `https://static.poly.pizza/${src.glbUuid}.glb`,
      /** Raw download target — `repivot-spatial-glb.ts` reads from here. */
      rawTarget: `public/spatial-assets/models/_raw/${a.slug}.glb`,
      /** Final re-pivoted + re-scaled model the renderer loads. */
      finalTarget: `public/spatial-assets/models/${a.slug}.glb`,
      license: a.license,
    }
  })

// ── Remaining GLB models without a poly.pizza source — manual sighting ────────

const models = glbAssets
  .filter((a) => !POLY_PIZZA[a.slug])
  .map((a) => ({
    slug: a.slug,
    category: a.category,
    displayName: a.displayName,
    target: `public/spatial-assets/models/${a.slug}.glb`,
    thumbnailTarget: `public/spatial-assets/thumbnails/${a.slug}.jpg`,
    source: 'polyhaven',
    /** No deterministic URL — pick the closest CC0 model + sight it visually. */
    searchHint: 'https://api.polyhaven.com/assets?type=models&categories=furniture',
    note:
      'Polyhaven CC0 — choose the closest furniture model, download the GLB, ' +
      'visually verify, then run optimize-spatial-assets.ts for Draco + LOD.',
    license: a.license,
  }))

// ── Procedural placeholders — no download ─────────────────────────────────────

const proceduralAssets = ASSET_CATALOG.filter((a) => a.geometryKind === 'procedural').map(
  (a) => a.slug,
)

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest = {
  $schema: 'spatial-asset-manifest/v1',
  generatedAt: new Date().toISOString().slice(0, 10),
  note:
    'GENERATED from src/lib/spatial/canonical/catalog/ — do not hand-edit. ' +
    'Materials + HDRIs + poly.pizza models have deterministic CC0 URLs ' +
    '(script-downloadable). poly.pizza GLBs are downloaded raw, then ' +
    're-pivoted + re-scaled by scripts/repivot-spatial-glb.ts. ' +
    `${proceduralAssets.length} procedural placeholder assets need NO download.`,
  counts: {
    materials: materials.length,
    hdris: hdris.length,
    polyPizzaModels: polyPizzaModels.length,
    models: models.length,
    proceduralAssets: proceduralAssets.length,
  },
  urlPatterns: {
    ambientcgPbrZip: 'https://ambientcg.com/get?file={ID}_1K-JPG.zip',
    ambientcgAlbedoPreview:
      'https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/{ID}/{ID}_SQ_Color.jpg',
    polyhavenHdriExr: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/exr/{res}/{slug}_{res}.exr',
    polyPizzaGlb: 'https://static.poly.pizza/{uuid}.glb',
    polyhavenModelsApi: 'https://api.polyhaven.com/assets?type=models&categories=furniture',
  },
  materials,
  hdris,
  polyPizzaModels,
  models,
  proceduralAssets,
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n')

console.log(
  `✓ asset manifest → ${OUT_FILE}\n` +
    `  ${materials.length} materials · ${hdris.length} HDRIs · ` +
    `${polyPizzaModels.length} poly.pizza models · ${models.length} other models · ` +
    `${proceduralAssets.length} procedural (no download)`,
)
