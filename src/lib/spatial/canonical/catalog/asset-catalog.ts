/**
 * Spatial · Canonical · Catalog · Asset Catalog
 *
 * The 78-entry 3D-asset catalog (13 sanitary + 10 kitchen + 17 architecture +
 * 38 furniture · 36 V1 base + 9 batch-1 + 19 phase-1.2 + 9 phase-2 + 5 batch-2
 * gap-fillers added 2026-05-28). This TS constant is the source of truth:
 * the InMemory catalog repository serves it directly and the
 * `20260520120021_spatial_assets_seed.sql` + B-6 delta migration
 * `20260520120045_spatial_assets_glb_upgrade.sql` + batch-1 delta
 * `20260528210000_spatial_assets_batch1_furniture_lighting.sql` mirror it
 * row-for-row.
 *
 * Geometry split (asset-source-map §0 · B-6 catalog upgrade):
 *   - 21 procedural L1 box-placeholders (`geometry_kind = 'procedural'`, no
 *     GLB) — architecture + the fixture slots whose only CC0 match is a
 *     freestanding appliance while the catalog models a built-in component
 *     (induction cooktop, wall oven, undermount sink, dishwasher), plus the
 *     orientation-sensitive wall / corner mounts (hood, corner shower) whose
 *     facing cannot be verified headless.
 *   - 15 real CC0 GLB (`geometry_kind = 'glb'`): 10 furniture + 5 fixtures
 *     (toilet / pedestal sink / built-in tub / fridge / countertop microwave),
 *     low-poly Quaternius / Kenney models from poly.pizza, re-pivoted +
 *     re-scaled to the catalog `dimensions` by `repivot-spatial-glb.ts`.
 *
 * Procedural dimensions / pivot / polycount are derived from the actual
 * placeholder mesh so the catalog can never drift from the geometry. GLB
 * entries carry the dimensions explicitly — the binary is re-scaled to them.
 *
 * Pure data: no three.js / React / DOM.
 */

import type { PivotType, SnapRule } from '../types/asset.ts'
import type { ObjectCategory } from '../types/objects.ts'
import type { AssetCategory } from '../snap/asset-snap.ts'
import { DEFAULT_SNAP_RULE } from '../snap/asset-snap.ts'
import { buildProceduralAsset } from '../geometry/procedural-assets.ts'
import { buildLodProfile } from './lod.ts'
import type { CatalogAsset } from './types.ts'

const CC0 = 'CC0-1.0'

/** Snap rule for architectural openings (doors / windows) — they fill a wall. */
const OPENING_SNAP_RULE: SnapRule = Object.freeze({
  target_host: 'wall',
  align_to_normal: true,
})

/**
 * Build a procedural-placeholder catalog entry. Dimensions, pivot and
 * polycount come straight from `buildProceduralAsset` — single source of truth.
 */
function proceduralAsset(args: {
  slug: string
  displayName: string
  category: AssetCategory
  objectCategory: ObjectCategory | null
  tags: string[]
  snapRule?: SnapRule
  /** True for vanity / counter assets that host other objects on their top. */
  isCounterHost?: boolean
}): CatalogAsset {
  const built = buildProceduralAsset(args.slug)
  const snapRule =
    args.snapRule ??
    (args.objectCategory ? DEFAULT_SNAP_RULE[args.objectCategory] : OPENING_SNAP_RULE)
  return {
    slug: args.slug,
    displayName: args.displayName,
    category: args.category,
    objectCategory: args.objectCategory,
    geometryKind: 'procedural',
    gltfStoragePath: null,
    thumbnailStoragePath: null,
    dimensions: built.dimensions,
    pivot: built.pivot,
    snapRule,
    polycountLod0: built.triangles,
    lodLevels: null,
    license: CC0,
    attribution: null,
    vendor: 'procedural',
    sourceUrl: null,
    isCounterHost: args.isCounterHost ?? false,
    published: true,
    tags: args.tags,
  }
}

/** Build a real-GLB catalog entry (furniture + B-6 fixture upgrades). */
function glbAsset(args: {
  slug: string
  displayName: string
  category: AssetCategory
  objectCategory: ObjectCategory
  dimensions: { width_m: number; depth_m: number; height_m: number }
  pivot: PivotType
  polycountLod0: number
  tags: string[]
  /**
   * Explicit placement rule — overrides the ObjectCategory default. Needed
   * when the fine category's default host is wrong for this asset (e.g. a
   * tripod FLOOR lamp whose `lamp` category defaults to `ceiling`).
   */
  snapRule?: SnapRule
  /** Canonical source URL for provenance / `LICENSES.md` (B-6 fills these). */
  sourceUrl?: string
  /** True for counter / worktop assets that host other objects on their top. */
  isCounterHost?: boolean
  /**
   * Source vendor. Defaults to `'polyhaven'` for the legacy furniture slots;
   * the B-6 catalog upgrade passes `'poly.pizza'` for the new CC0 models.
   */
  vendor?: string
  /**
   * SPDX license id. Defaults to CC0-1.0 (the V1 catalog baseline). The L0-#3
   * wall-fixture GLBs (radiator / outlet / switch) have no scriptable CC0
   * source, so they ship as `'CC-BY-3.0'` WITH a mandatory `attribution`.
   */
  license?: string
  /** Required credit string when `license` is an attribution license (CC-BY). */
  attribution?: string
}): CatalogAsset {
  const gltfStoragePath = `spatial-assets/models/${args.slug}.glb`
  return {
    slug: args.slug,
    displayName: args.displayName,
    category: args.category,
    objectCategory: args.objectCategory,
    geometryKind: 'glb',
    gltfStoragePath,
    thumbnailStoragePath: `spatial-assets/thumbnails/${args.slug}.jpg`,
    dimensions: args.dimensions,
    pivot: args.pivot,
    snapRule: args.snapRule ?? DEFAULT_SNAP_RULE[args.objectCategory],
    polycountLod0: args.polycountLod0,
    lodLevels: buildLodProfile(gltfStoragePath, args.polycountLod0),
    license: args.license ?? CC0,
    attribution: args.attribution ?? null,
    vendor: args.vendor ?? 'polyhaven',
    sourceUrl: args.sourceUrl ?? null,
    isCounterHost: args.isCounterHost ?? false,
    published: true,
    tags: args.tags,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanitary · 10  (B-6: toilet · pedestal sink · built-in tub → real CC0 GLB)
// ─────────────────────────────────────────────────────────────────────────────

const SANITARY: CatalogAsset[] = [
  glbAsset({
    slug: 'sanitary-toilet-standard-floor',
    displayName: 'Stand-WC',
    category: 'sanitary',
    objectCategory: 'toilet',
    dimensions: { width_m: 0.37, depth_m: 0.7, height_m: 0.63 },
    pivot: 'bottom_center',
    polycountLod0: 402,
    tags: ['wc', 'toilette', 'toilet', 'klo', 'stand'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/WAu50yGFVt',
  }),
  proceduralAsset({
    slug: 'sanitary-toilet-wall-hung',
    displayName: 'Wand-WC',
    category: 'sanitary',
    objectCategory: 'toilet',
    tags: ['wc', 'toilette', 'toilet', 'wandhängend', 'wall hung'],
  }),
  glbAsset({
    slug: 'sanitary-sink-pedestal-classic',
    displayName: 'Standwaschbecken',
    category: 'sanitary',
    objectCategory: 'sink',
    dimensions: { width_m: 0.5, depth_m: 0.42, height_m: 0.91 },
    pivot: 'bottom_center',
    polycountLod0: 632,
    tags: ['waschbecken', 'sink', 'becken', 'standsäule', 'pedestal'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/iUz9JXhDE1',
  }),
  proceduralAsset({
    slug: 'sanitary-sink-vanity-rectangle',
    displayName: 'Waschtisch mit Unterschrank',
    category: 'sanitary',
    objectCategory: 'sink',
    tags: ['waschtisch', 'waschbecken', 'sink', 'vanity', 'unterschrank'],
    isCounterHost: true,
  }),
  proceduralAsset({
    slug: 'sanitary-sink-double-vanity',
    displayName: 'Doppelwaschtisch',
    category: 'sanitary',
    objectCategory: 'sink',
    tags: ['waschtisch', 'doppel', 'double', 'vanity', 'sink'],
    isCounterHost: true,
  }),
  proceduralAsset({
    slug: 'sanitary-bathtub-freestanding-oval',
    displayName: 'Freistehende Badewanne',
    category: 'sanitary',
    objectCategory: 'bathtub',
    tags: ['badewanne', 'wanne', 'bathtub', 'freistehend', 'oval'],
  }),
  glbAsset({
    slug: 'sanitary-bathtub-builtin-rectangle',
    displayName: 'Einbau-Badewanne',
    category: 'sanitary',
    objectCategory: 'bathtub',
    dimensions: { width_m: 1.7, depth_m: 0.75, height_m: 0.56 },
    pivot: 'bottom_center',
    polycountLod0: 1204,
    tags: ['badewanne', 'wanne', 'bathtub', 'einbau', 'builtin'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/kVFRyNEn4F',
  }),
  proceduralAsset({
    slug: 'sanitary-shower-walkin-corner',
    displayName: 'Eck-Walk-in-Dusche',
    category: 'sanitary',
    objectCategory: 'shower',
    tags: ['dusche', 'shower', 'walk-in', 'ecke', 'corner'],
  }),
  proceduralAsset({
    slug: 'sanitary-shower-enclosure-square',
    displayName: 'Duschkabine',
    category: 'sanitary',
    objectCategory: 'shower',
    tags: ['dusche', 'shower', 'kabine', 'enclosure', 'glas'],
  }),
  proceduralAsset({
    slug: 'sanitary-bidet-floor-standing',
    displayName: 'Stand-Bidet',
    category: 'sanitary',
    objectCategory: 'bidet',
    tags: ['bidet', 'stand'],
  }),
  // ── Phase 1.2 · 1 ─────────────────────────────────────────────────────────
  glbAsset({
    slug: 'sanitary-towel-rack',
    displayName: 'Handtuchhalter',
    category: 'sanitary',
    objectCategory: 'towel_rail',
    dimensions: { width_m: 0.6, depth_m: 0.08, height_m: 0.4 },
    pivot: 'wall_back_center',
    polycountLod0: 200,
    tags: ['handtuchhalter', 'towel rack', 'towel rail', 'halter'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/8R9fXwL11r',
  }),
  // ── Batch-2 · 2 (enum-extension: washing_machine + toilet_paper_holder) ─────
  glbAsset({
    slug: 'sanitary-washing-machine',
    displayName: 'Waschmaschine',
    category: 'sanitary',
    objectCategory: 'washing_machine',
    dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 600,
    tags: ['waschmaschine', 'washing machine', 'washer', 'wäsche', 'frontlader'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/UFxsKNSl8W',
  }),
  glbAsset({
    slug: 'sanitary-toilet-paper-holder',
    displayName: 'Toilettenpapierhalter',
    category: 'sanitary',
    objectCategory: 'toilet_paper_holder',
    dimensions: { width_m: 0.16, depth_m: 0.1, height_m: 0.12 },
    pivot: 'wall_back_center',
    polycountLod0: 200,
    tags: ['toilettenpapierhalter', 'toilet paper holder', 'klopapierhalter', 'papierhalter'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/pZojeda7ye',
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Kitchen · 8  (B-6: fridge · countertop microwave → real CC0 GLB)
// ─────────────────────────────────────────────────────────────────────────────

const KITCHEN: CatalogAsset[] = [
  proceduralAsset({
    slug: 'kitchen-sink-undermount-double',
    displayName: 'Unterbau-Spüle (Doppelbecken)',
    category: 'kitchen',
    objectCategory: 'kitchen_sink',
    tags: ['spüle', 'sink', 'becken', 'unterbau', 'doppel'],
  }),
  proceduralAsset({
    slug: 'kitchen-stove-induction-60cm',
    displayName: 'Induktionskochfeld 60 cm',
    category: 'kitchen',
    objectCategory: 'cooktop',
    tags: ['kochfeld', 'herd', 'cooktop', 'induktion', 'stove'],
  }),
  proceduralAsset({
    slug: 'kitchen-oven-builtin-60cm',
    displayName: 'Einbau-Backofen 60 cm',
    category: 'kitchen',
    objectCategory: 'oven',
    tags: ['backofen', 'ofen', 'oven', 'einbau'],
  }),
  glbAsset({
    slug: 'kitchen-refrigerator-freestanding-tall',
    displayName: 'Standkühlschrank',
    category: 'kitchen',
    objectCategory: 'refrigerator',
    dimensions: { width_m: 0.7, depth_m: 0.76, height_m: 1.85 },
    pivot: 'bottom_center',
    polycountLod0: 404,
    tags: ['kühlschrank', 'fridge', 'refrigerator', 'kühl'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/8sjRm8fnHh',
  }),
  proceduralAsset({
    slug: 'kitchen-dishwasher-builtin-60cm',
    displayName: 'Einbau-Geschirrspüler 60 cm',
    category: 'kitchen',
    objectCategory: 'dishwasher',
    tags: ['geschirrspüler', 'spülmaschine', 'dishwasher', 'einbau'],
  }),
  proceduralAsset({
    slug: 'kitchen-extractor-hood-wall-mounted',
    displayName: 'Wand-Dunstabzugshaube',
    category: 'kitchen',
    objectCategory: 'range_hood',
    tags: ['dunstabzug', 'haube', 'hood', 'abzug'],
  }),
  glbAsset({
    slug: 'kitchen-microwave-countertop',
    displayName: 'Mikrowelle',
    category: 'kitchen',
    objectCategory: 'oven',
    dimensions: { width_m: 0.5, depth_m: 0.405, height_m: 0.3 },
    pivot: 'bottom_center',
    polycountLod0: 256,
    tags: ['mikrowelle', 'microwave'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/vUsvf2HGDv',
  }),
  proceduralAsset({
    slug: 'kitchen-faucet-pullout-tall',
    displayName: 'Küchenarmatur mit Auszug',
    category: 'kitchen',
    objectCategory: 'kitchen_faucet',
    tags: ['armatur', 'wasserhahn', 'faucet', 'hahn', 'auszug'],
  }),
  // ── Phase 1.2 · 2 ─────────────────────────────────────────────────────────
  glbAsset({
    slug: 'kitchen-oven-standing',
    displayName: 'Backofen Standgerät',
    category: 'kitchen',
    objectCategory: 'oven',
    dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 500,
    tags: ['backofen', 'ofen', 'oven', 'standgerät', 'küche'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/VNjPRwui7t',
  }),
  glbAsset({
    slug: 'kitchen-stove-cooktop',
    displayName: 'Herd mit Kochfeld',
    category: 'kitchen',
    objectCategory: 'cooktop',
    dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 350,
    tags: ['herd', 'kochfeld', 'cooktop', 'stove', 'küche'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/kTJU2y4R15',
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Architecture · 8  (doors / windows / electrics — procedural is the correct
// choice: parametric openings re-scale per wall, GLB would distort)
// ─────────────────────────────────────────────────────────────────────────────

const ARCHITECTURE: CatalogAsset[] = [
  proceduralAsset({
    slug: 'arch-door-single-leaf-standard',
    displayName: 'Innentür einflügelig',
    category: 'architecture',
    objectCategory: null,
    tags: ['tür', 'door', 'innentür', 'einflügelig'],
  }),
  proceduralAsset({
    slug: 'arch-door-double-french',
    displayName: 'Doppeltür (französisch)',
    category: 'architecture',
    objectCategory: null,
    tags: ['tür', 'door', 'doppeltür', 'french', 'französisch'],
  }),
  proceduralAsset({
    slug: 'arch-window-double-hung-standard',
    displayName: 'Schiebefenster',
    category: 'architecture',
    objectCategory: null,
    tags: ['fenster', 'window', 'schiebefenster', 'double hung'],
  }),
  proceduralAsset({
    slug: 'arch-window-casement-2-pane',
    displayName: 'Drehflügelfenster (2-flügelig)',
    category: 'architecture',
    objectCategory: null,
    tags: ['fenster', 'window', 'drehflügel', 'casement'],
  }),
  proceduralAsset({
    slug: 'arch-radiator-panel-wall',
    displayName: 'Flachheizkörper',
    category: 'architecture',
    objectCategory: 'radiator',
    tags: ['heizkörper', 'heizung', 'radiator', 'flach'],
  }),
  proceduralAsset({
    slug: 'arch-radiator-towel-bath',
    displayName: 'Handtuchheizkörper',
    category: 'architecture',
    objectCategory: 'radiator',
    tags: ['heizkörper', 'handtuchheizung', 'radiator', 'towel', 'bad'],
  }),
  proceduralAsset({
    slug: 'arch-outlet-socket-double',
    displayName: 'Doppelsteckdose',
    category: 'architecture',
    objectCategory: 'electrical_outlet',
    tags: ['steckdose', 'outlet', 'socket', 'strom', 'doppel'],
  }),
  proceduralAsset({
    slug: 'arch-light-switch-single',
    displayName: 'Lichtschalter',
    category: 'architecture',
    objectCategory: 'light_switch',
    tags: ['schalter', 'lichtschalter', 'switch', 'licht'],
  }),
  // ── Phase 2 · 8 DE-Hero refined procedural-Generators (2026-05-28) ─────────
  // brand-neutral DIN-conform refinements of existing slugs (panel-typ22 vs
  // panel-wall, schuko-de vs socket-double, switch-rocker-55 vs switch-single)
  // plus 5 new infrastructure items (Konvektor, Sicherungskasten, Abzweigdose,
  // Spiegelschrank). Existing arch-* slugs stay for backward-compat with
  // already-placed objects.
  glbAsset({
    slug: 'arch-radiator-panel-typ22',
    displayName: 'Plattenheizkörper Typ-22',
    category: 'architecture',
    objectCategory: 'radiator',
    // Dims match the customer mutator's placed wall_mounted radiator
    // (buildDefaultWallMountedObject: 100×60×8 cm) so the GLB renders at the
    // exact placed/validated size. Wall pivot → glbPivotOffset re-anchors.
    dimensions: { width_m: 1.0, depth_m: 0.08, height_m: 0.6 },
    pivot: 'wall_back_center',
    polycountLod0: 3600,
    tags: ['heizkörper', 'plattenheizkörper', 'typ-22', 'radiator', 'din'],
    vendor: 'poly.pizza',
    license: 'CC-BY-3.0',
    attribution: 'Radiator – Poly by Google (CC-BY 3.0)',
    sourceUrl: 'https://poly.pizza/m/4XJ-DH66eKY',
  }),
  proceduralAsset({
    slug: 'arch-radiator-convector-floor',
    displayName: 'Bodenkonvektor',
    category: 'architecture',
    objectCategory: 'radiator',
    tags: ['konvektor', 'boden', 'heizung', 'bodenkonvektor', 'radiator'],
  }),
  glbAsset({
    slug: 'arch-outlet-schuko-de',
    displayName: 'Schuko-Steckdose (DIN 49441)',
    category: 'architecture',
    objectCategory: 'electrical_outlet',
    dimensions: { width_m: 0.08, depth_m: 0.022, height_m: 0.08 },
    pivot: 'wall_back_center',
    polycountLod0: 374,
    tags: ['steckdose', 'schuko', 'outlet', 'din 49441', 'einzel'],
    vendor: 'poly.pizza',
    license: 'CC-BY-3.0',
    attribution: 'EU Outlet – J-Toastie (CC-BY 3.0)',
    sourceUrl: 'https://poly.pizza/m/MCMUq7R1w5',
  }),
  proceduralAsset({
    slug: 'arch-outlet-schuko-de-double',
    displayName: 'Schuko-Doppelsteckdose',
    category: 'architecture',
    objectCategory: 'electrical_outlet',
    tags: ['steckdose', 'schuko', 'doppel', '2-fach', 'outlet'],
  }),
  glbAsset({
    slug: 'arch-switch-rocker-55',
    displayName: 'Wippschalter 55',
    category: 'architecture',
    objectCategory: 'light_switch',
    dimensions: { width_m: 0.08, depth_m: 0.022, height_m: 0.08 },
    pivot: 'wall_back_center',
    polycountLod0: 156,
    tags: ['schalter', 'wippschalter', 'system-55', 'switch', 'licht'],
    vendor: 'poly.pizza',
    license: 'CC-BY-3.0',
    attribution: 'Light switch – Poly by Google (CC-BY 3.0)',
    sourceUrl: 'https://poly.pizza/m/8sR1PkyAg-F',
  }),
  proceduralAsset({
    slug: 'arch-switch-rocker-double',
    displayName: 'Doppel-Wippschalter',
    category: 'architecture',
    objectCategory: 'light_switch',
    tags: ['schalter', 'doppel', '2-fach', 'wipp', 'switch'],
  }),
  proceduralAsset({
    slug: 'arch-distribution-box-hager',
    displayName: 'Sicherungskasten',
    category: 'architecture',
    objectCategory: null,
    tags: ['sicherungskasten', 'verteilerkasten', 'ls-schalter', 'unterverteilung'],
  }),
  proceduralAsset({
    slug: 'arch-junction-box-cylinder',
    displayName: 'Abzweigdose',
    category: 'architecture',
    objectCategory: null,
    tags: ['abzweigdose', 'verbindungsdose', 'kaiser', 'unterputz'],
  }),
  proceduralAsset({
    slug: 'arch-mirror-cabinet-led',
    displayName: 'Spiegelschrank mit LED',
    category: 'architecture',
    objectCategory: 'mirror',
    tags: ['spiegelschrank', 'spiegel', 'led', 'cabinet', 'bad'],
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// Furniture · 10 — real CC0 GLB. B-6: 9 slots moved from Polyhaven PBR to
// low-poly Quaternius / Kenney (poly.pizza) for a consistent stylized look
// (locked decision 2026-05-20). `furn-mirror-round-wall` has no CC0 match and
// stays on the Polyhaven model.
// ─────────────────────────────────────────────────────────────────────────────

const FURNITURE: CatalogAsset[] = [
  glbAsset({
    slug: 'furn-sofa-3seater-fabric-grey',
    displayName: '3-Sitzer-Sofa',
    category: 'furniture',
    objectCategory: 'sofa',
    dimensions: { width_m: 2.1, depth_m: 0.92, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 1460,
    tags: ['sofa', 'couch', 'sitzgelegenheit', '3-sitzer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/6MoOyPtetL',
  }),
  glbAsset({
    slug: 'furn-armchair-fabric-rounded',
    displayName: 'Sessel',
    category: 'furniture',
    objectCategory: 'armchair',
    dimensions: { width_m: 0.85, depth_m: 0.85, height_m: 0.95 },
    pivot: 'bottom_center',
    polycountLod0: 852,
    tags: ['sessel', 'armchair', 'stuhl'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/ZOPP3KzNIk',
  }),
  glbAsset({
    slug: 'furn-coffee-table-round-wood',
    displayName: 'Couchtisch rund',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 0.9, depth_m: 0.9, height_m: 0.42 },
    pivot: 'bottom_center',
    polycountLod0: 592,
    tags: ['couchtisch', 'tisch', 'table', 'rund'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/57W671WvS2',
  }),
  glbAsset({
    slug: 'furn-dining-table-rectangle-6',
    displayName: 'Esstisch (6 Personen)',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 1.8, depth_m: 0.9, height_m: 0.75 },
    pivot: 'bottom_center',
    polycountLod0: 1500,
    tags: ['esstisch', 'tisch', 'table', 'dining'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/yYEEJzKxb4',
  }),
  glbAsset({
    slug: 'furn-dining-chair-wood-fabric',
    displayName: 'Esszimmerstuhl',
    category: 'furniture',
    objectCategory: 'chair',
    dimensions: { width_m: 0.46, depth_m: 0.52, height_m: 0.9 },
    pivot: 'bottom_center',
    polycountLod0: 216,
    tags: ['stuhl', 'chair', 'esszimmerstuhl'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/iMNqRzPwwe',
  }),
  glbAsset({
    slug: 'furn-bed-double-frame-headboard',
    displayName: 'Doppelbett mit Kopfteil',
    category: 'furniture',
    objectCategory: 'bed',
    dimensions: { width_m: 1.6, depth_m: 2.1, height_m: 1.0 },
    pivot: 'bottom_center',
    polycountLod0: 4712,
    tags: ['bett', 'bed', 'doppelbett'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/BuRay4fVFr',
  }),
  glbAsset({
    slug: 'furn-wardrobe-3door-tall',
    displayName: 'Kleiderschrank',
    category: 'furniture',
    objectCategory: 'wardrobe',
    dimensions: { width_m: 1.5, depth_m: 0.6, height_m: 2.1 },
    pivot: 'bottom_center',
    polycountLod0: 2988,
    tags: ['schrank', 'kleiderschrank', 'wardrobe'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/BHEVb1DIuH',
  }),
  glbAsset({
    slug: 'furn-shelf-open-5tier-wood',
    displayName: 'Offenes Regal',
    category: 'furniture',
    objectCategory: 'bookshelf',
    dimensions: { width_m: 0.9, depth_m: 0.35, height_m: 1.8 },
    pivot: 'bottom_center',
    polycountLod0: 320,
    tags: ['regal', 'shelf', 'bücherregal', 'bookshelf'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/MTH8ZwnA27',
  }),
  glbAsset({
    slug: 'furn-mirror-round-wall',
    displayName: 'Wandspiegel rund',
    category: 'furniture',
    objectCategory: 'mirror',
    dimensions: { width_m: 0.8, depth_m: 0.05, height_m: 0.8 },
    pivot: 'wall_back_center',
    polycountLod0: 1000,
    tags: ['spiegel', 'mirror', 'wandspiegel', 'rund'],
  }),
  glbAsset({
    slug: 'furn-floor-lamp-tripod',
    displayName: 'Stehlampe',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 1.6 },
    pivot: 'bottom_center',
    polycountLod0: 152,
    tags: ['lampe', 'stehlampe', 'lamp', 'tripod', 'licht'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/8LiDIfXVLi',
    // `lamp` defaults to a ceiling host — a floor lamp stands on
    // the floor (asset-source-map §4: "Floor-Footprint-Center").
    snapRule: { target_host: 'floor', align_to_normal: false, min_distance_to_corner_m: 0.05 },
  }),
  // ── Batch-1 expansion 2026-05-28 · 8 high-priority gap-fillers ─────────────
  // Closes Sub-Kategorien Nachttisch / Kommode / TV-Möbel / Schreibtisch /
  // Bürostuhl / Deckenleuchte / Pendelleuchte / Tischlampe.
  // All Quaternius / Kenney CC0 via poly.pizza CDN (magic-byte + HEAD-200 verified).
  glbAsset({
    slug: 'furn-nightstand-2drawer',
    displayName: 'Nachttisch (2 Schubladen)',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 0.5, depth_m: 0.4, height_m: 0.55 },
    pivot: 'bottom_center',
    polycountLod0: 800,
    tags: ['nachttisch', 'nightstand', 'tisch', 'bedside', 'schlafzimmer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/A9vPgVUrF9',
  }),
  glbAsset({
    slug: 'furn-dresser-tall-3drawer',
    displayName: 'Kommode (3 Schubladen)',
    category: 'furniture',
    objectCategory: 'wardrobe',
    dimensions: { width_m: 0.9, depth_m: 0.45, height_m: 1.1 },
    pivot: 'bottom_center',
    polycountLod0: 600,
    tags: ['kommode', 'dresser', 'drawer', 'schrank', 'schubladen'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/T4uDbyP90C',
  }),
  glbAsset({
    slug: 'furn-tv-cabinet-lowboard',
    displayName: 'TV-Lowboard',
    category: 'furniture',
    objectCategory: 'tv_cabinet',
    dimensions: { width_m: 1.6, depth_m: 0.45, height_m: 0.5 },
    pivot: 'bottom_center',
    polycountLod0: 500,
    tags: ['tv-möbel', 'lowboard', 'cabinet', 'fernsehmöbel', 'medienschrank'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/AL6wwiUgP3',
  }),
  glbAsset({
    slug: 'furn-desk-rectangular',
    displayName: 'Schreibtisch',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 1.4, depth_m: 0.7, height_m: 0.75 },
    pivot: 'bottom_center',
    polycountLod0: 600,
    tags: ['schreibtisch', 'desk', 'arbeitsplatz', 'büro', 'tisch'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/V86Go2rlnq',
  }),
  glbAsset({
    slug: 'furn-office-chair-modern',
    displayName: 'Bürostuhl',
    category: 'furniture',
    objectCategory: 'chair',
    dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 1.1 },
    pivot: 'bottom_center',
    polycountLod0: 700,
    tags: ['bürostuhl', 'office chair', 'desk chair', 'arbeitsstuhl', 'rollstuhl'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/CKSz6PB1vO',
  }),
  glbAsset({
    slug: 'furn-light-ceiling-flush-mount',
    displayName: 'Deckenleuchte',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.12 },
    pivot: 'ceiling_top_center',
    polycountLod0: 200,
    tags: ['deckenleuchte', 'ceiling light', 'flush mount', 'lampe', 'licht'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/S3HkX8iTl2',
  }),
  glbAsset({
    slug: 'furn-light-pendant-dome',
    displayName: 'Pendelleuchte',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.35, depth_m: 0.35, height_m: 0.5 },
    pivot: 'ceiling_top_center',
    polycountLod0: 300,
    tags: ['pendelleuchte', 'pendant', 'hängelampe', 'lampe', 'licht'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/KGq88JUIJo',
  }),
  glbAsset({
    slug: 'furn-light-table-lamp',
    displayName: 'Tischlampe',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.25, depth_m: 0.25, height_m: 0.45 },
    pivot: 'bottom_center',
    polycountLod0: 250,
    tags: ['tischlampe', 'table lamp', 'lampe', 'licht', 'desk lamp'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/auXnXwXD7S',
    // `lamp` defaults to ceiling-host — a table lamp sits on a counter / desk top.
    snapRule: { target_host: 'counter', align_to_normal: false, min_distance_to_corner_m: 0.02 },
  }),
  glbAsset({
    slug: 'furn-plant-medium',
    displayName: 'Zimmerpflanze',
    category: 'furniture',
    objectCategory: 'plant',
    dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.8 },
    pivot: 'bottom_center',
    polycountLod0: 400,
    tags: ['pflanze', 'plant', 'houseplant', 'zimmerpflanze', 'topfpflanze'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/bfLOqIV5uP',
  }),
  // ── Phase 1.2 expansion 2026-05-28 · 16 furniture + lighting + decor ──────
  // Bulk closing of Sub-Kategorien Etagen-/King-/Einzelbett, Hocker, Rundtisch
  // klein/groß, L-Couch + 2-Sitzer, Schrank schmal + Sideboard, Kronleuchter +
  // Wandleuchte + Bogenlampe + Schreibtischlampe, Kaktus + Pflanze hoch.
  // All Quaternius/Kenney CC0 via poly.pizza CDN (HEAD-200 verified).
  glbAsset({
    slug: 'furn-bunk-bed',
    displayName: 'Etagenbett',
    category: 'furniture',
    objectCategory: 'bed',
    dimensions: { width_m: 1.0, depth_m: 2.0, height_m: 1.65 },
    pivot: 'bottom_center',
    polycountLod0: 1500,
    tags: ['etagenbett', 'bunk bed', 'doppelstockbett', 'bett', 'kinder'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/XpysaEDXJQ',
  }),
  glbAsset({
    slug: 'furn-bed-king',
    displayName: 'King-Size-Bett',
    category: 'furniture',
    objectCategory: 'bed',
    dimensions: { width_m: 1.8, depth_m: 2.1, height_m: 1.0 },
    pivot: 'bottom_center',
    polycountLod0: 4000,
    tags: ['king-size', 'bett', 'bed', 'doppelbett groß'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/3kiLmRcb1o',
  }),
  glbAsset({
    slug: 'furn-bed-single',
    displayName: 'Einzelbett',
    category: 'furniture',
    objectCategory: 'bed',
    dimensions: { width_m: 0.9, depth_m: 2.0, height_m: 0.8 },
    pivot: 'bottom_center',
    polycountLod0: 400,
    tags: ['einzelbett', 'single bed', 'bett', 'jugendbett'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/sn8az3odMR',
  }),
  glbAsset({
    slug: 'furn-stool-round',
    displayName: 'Hocker',
    category: 'furniture',
    objectCategory: 'chair',
    dimensions: { width_m: 0.4, depth_m: 0.4, height_m: 0.45 },
    pivot: 'bottom_center',
    polycountLod0: 744,
    tags: ['hocker', 'stool', 'sitzhocker'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/TvaOenUAni',
  }),
  glbAsset({
    slug: 'furn-table-round-small',
    displayName: 'Beistelltisch rund',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 0.55, depth_m: 0.55, height_m: 0.45 },
    pivot: 'bottom_center',
    polycountLod0: 500,
    tags: ['beistelltisch', 'side table', 'tisch', 'rund', 'klein'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/oEArSZykyi',
  }),
  glbAsset({
    slug: 'furn-table-round-large',
    displayName: 'Esstisch rund',
    category: 'furniture',
    objectCategory: 'table',
    dimensions: { width_m: 1.2, depth_m: 1.2, height_m: 0.75 },
    pivot: 'bottom_center',
    polycountLod0: 400,
    tags: ['esstisch', 'dining table', 'tisch', 'rund', 'groß'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/AXbvcMDC8j',
  }),
  glbAsset({
    slug: 'furn-couch-l-sectional',
    displayName: 'Eck-Sofa (L-Form)',
    category: 'furniture',
    objectCategory: 'sofa',
    dimensions: { width_m: 2.4, depth_m: 1.8, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 2000,
    tags: ['eck-sofa', 'l-couch', 'sectional', 'sofa', 'wohnzimmer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/1kwsjhpY84',
  }),
  glbAsset({
    slug: 'furn-couch-2seater',
    displayName: '2-Sitzer-Sofa',
    category: 'furniture',
    objectCategory: 'sofa',
    dimensions: { width_m: 1.5, depth_m: 0.9, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 1200,
    tags: ['2-sitzer', 'couch', 'sofa', 'loveseat'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/vRMLQC5Dfg',
  }),
  glbAsset({
    slug: 'furn-cabinet-tall-storage',
    displayName: 'Schrank schmal hoch',
    category: 'furniture',
    objectCategory: 'wardrobe',
    dimensions: { width_m: 0.8, depth_m: 0.4, height_m: 1.9 },
    pivot: 'bottom_center',
    polycountLod0: 400,
    tags: ['schrank', 'cabinet', 'tall storage', 'hoch'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/dUd80gOqgO',
  }),
  glbAsset({
    slug: 'furn-sideboard-modern',
    displayName: 'Sideboard',
    category: 'furniture',
    objectCategory: 'wardrobe',
    dimensions: { width_m: 1.6, depth_m: 0.45, height_m: 0.85 },
    pivot: 'bottom_center',
    polycountLod0: 600,
    tags: ['sideboard', 'kommode', 'anrichte', 'wohnzimmer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/CBUx8ZMVAO',
  }),
  glbAsset({
    slug: 'furn-light-chandelier',
    displayName: 'Kronleuchter',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.6, depth_m: 0.6, height_m: 0.7 },
    pivot: 'ceiling_top_center',
    polycountLod0: 1500,
    tags: ['kronleuchter', 'chandelier', 'lampe', 'licht', 'decke'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/q3k8I8YYX9',
  }),
  glbAsset({
    slug: 'furn-light-wall-sconce',
    displayName: 'Wandleuchte',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.22, depth_m: 0.18, height_m: 0.32 },
    pivot: 'wall_back_center',
    polycountLod0: 200,
    tags: ['wandleuchte', 'wall sconce', 'lampe', 'licht', 'wand'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/74FEuNrLJ5',
    // `lamp` defaults to ceiling-host — a sconce is wall-mounted.
    snapRule: { target_host: 'wall', align_to_normal: true },
  }),
  glbAsset({
    slug: 'furn-light-floor-arc',
    displayName: 'Bogen-Stehlampe',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.5, depth_m: 1.2, height_m: 1.8 },
    pivot: 'bottom_center',
    polycountLod0: 400,
    tags: ['stehlampe', 'bogenlampe', 'floor lamp', 'arc', 'lampe'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/eBQtooeh43',
    // `lamp` defaults to ceiling-host — a floor lamp sits on the floor.
    snapRule: { target_host: 'floor', align_to_normal: false, min_distance_to_corner_m: 0.05 },
  }),
  glbAsset({
    slug: 'furn-light-desk-task',
    displayName: 'Schreibtischlampe',
    category: 'furniture',
    objectCategory: 'lamp',
    dimensions: { width_m: 0.2, depth_m: 0.35, height_m: 0.45 },
    pivot: 'bottom_center',
    polycountLod0: 300,
    tags: ['schreibtischlampe', 'desk lamp', 'task light', 'lampe', 'büro'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/uJDWrSJGVH',
    // `lamp` defaults to ceiling-host — a task light sits on a desk top.
    snapRule: { target_host: 'counter', align_to_normal: false, min_distance_to_corner_m: 0.02 },
  }),
  glbAsset({
    slug: 'decor-cactus',
    displayName: 'Kaktus',
    category: 'furniture',
    objectCategory: 'plant',
    dimensions: { width_m: 0.25, depth_m: 0.25, height_m: 0.45 },
    pivot: 'bottom_center',
    polycountLod0: 300,
    tags: ['kaktus', 'cactus', 'pflanze', 'topfpflanze'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/HsEJgRLQWX',
  }),
  glbAsset({
    slug: 'decor-houseplant-tall',
    displayName: 'Pflanze hoch',
    category: 'furniture',
    objectCategory: 'plant',
    dimensions: { width_m: 0.5, depth_m: 0.5, height_m: 1.4 },
    pivot: 'bottom_center',
    polycountLod0: 600,
    tags: ['pflanze hoch', 'tall plant', 'monstera', 'pflanze', 'topfpflanze'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/MbhbP7JrTI',
  }),
  // ── Batch-2 · 2 (enum-extension: curtains + fireplace) ──────────────────────
  glbAsset({
    slug: 'decor-curtains-double',
    displayName: 'Vorhänge (Paar)',
    category: 'furniture',
    objectCategory: 'curtains',
    dimensions: { width_m: 1.5, depth_m: 0.12, height_m: 2.2 },
    pivot: 'wall_back_center',
    polycountLod0: 400,
    tags: ['vorhänge', 'vorhang', 'curtains', 'gardine', 'drapes', 'fenster'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/kkeII96j9N',
  }),
  glbAsset({
    slug: 'decor-fireplace',
    displayName: 'Kamin',
    category: 'furniture',
    objectCategory: 'fireplace',
    dimensions: { width_m: 1.1, depth_m: 0.4, height_m: 1.15 },
    pivot: 'bottom_center',
    polycountLod0: 700,
    tags: ['kamin', 'fireplace', 'feuerstelle', 'ofen', 'wohnzimmer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/nzxZYIOCIr',
  }),
  glbAsset({
    slug: 'decor-rug',
    displayName: 'Teppich',
    category: 'furniture',
    objectCategory: 'rug',
    dimensions: { width_m: 2.0, depth_m: 1.4, height_m: 0.02 },
    pivot: 'bottom_center',
    polycountLod0: 50,
    tags: ['teppich', 'rug', 'carpet', 'läufer', 'vorleger', 'wohnzimmer'],
    vendor: 'poly.pizza',
    sourceUrl: 'https://poly.pizza/m/7H5qKjuxVY',
  }),
]

/**
 * The full V1 asset catalog — 73 entries (Batch-1 +9 furniture/lighting/decor
 * 2026-05-28; Phase 1.2 +19 furniture/lighting/decor/sanitary/kitchen 2026-05-28;
 * Phase 2 +9 DE-Hero refined procedural-architecture 2026-05-28).
 * Frozen so consumers cannot mutate the shared registry at run time.
 */
export const ASSET_CATALOG: readonly CatalogAsset[] = Object.freeze([
  ...SANITARY,
  ...KITCHEN,
  ...ARCHITECTURE,
  ...FURNITURE,
])

/** Lookup index by slug. */
const ASSET_BY_SLUG: ReadonlyMap<string, CatalogAsset> = new Map(
  ASSET_CATALOG.map((a) => [a.slug, a]),
)

/** Find a catalog asset by slug, or `undefined`. */
export function getCatalogAsset(slug: string): CatalogAsset | undefined {
  return ASSET_BY_SLUG.get(slug)
}

/** All published assets in a coarse category. */
export function getCatalogAssetsByCategory(category: AssetCategory): CatalogAsset[] {
  return ASSET_CATALOG.filter((a) => a.category === category && a.published)
}
