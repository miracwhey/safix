/**
 * Spatial · Canonical · Lighting · Presets
 *
 * The 8 V1 lighting presets (hdri-curation.md · all Polyhaven slugs verified
 * 2026-05-20). Phase 1 keeps these as TS constants — the Day-6 schema has no
 * `spatial_lighting_presets` table; promotion to SQL is a Phase-2 concern
 * (hdri-curation §5).
 *
 * Each preset pairs a CC0 HDRI environment map with a separate
 * `DirectionalLight` (sun) so the renderer can tune sun direction / colour /
 * intensity independently of the image-based lighting (hdri-curation §2).
 *
 * Pure data: no three.js / React / DOM.
 */

import { resolveSpatialAssetUrl } from '../assets/assetBaseUrl'

/** Switcher section — Mockup 43 groups presets into "Tag" and "Abend & Studio". */
export type LightingSection = 'day' | 'evening-studio'

/** Optional warm accent light bound to ceiling-lamp asset nodes. */
export interface AccentPointLight {
  intensity: number
  color: string
}

export interface LightingPreset {
  /** Stable programmatic id. */
  id: string
  /** Picker display name (Mockup 43). */
  displayName: string
  /** Mood sub-line under the name. */
  moodLine: string
  section: LightingSection
  /** Polyhaven HDRI slug — the storage file stem. */
  polyhavenSlug: string
  /** Public URL of the 2K HDRI EXR. */
  hdriUrl: string
  /** Public URL of the panorama-crop picker thumbnail. */
  thumbnailUrl: string
  /** `<Environment intensity>` — image-based lighting strength. */
  envIntensity: number
  /** Separate `DirectionalLight` intensity (0 = sun off). */
  sunIntensity: number
  /** Sun colour hex (ignored when `sunIntensity === 0`). */
  sunColor: string
  /** Sun direction in world space. */
  sunPosition: [number, number, number]
  /** Soft ambient fill intensity. */
  ambientFillIntensity: number
  /** Warm point light at ceiling-lamp nodes (Mockup 43 / hdri-curation §2). */
  accentPointLight?: AccentPointLight
}

function hdriUrl(slug: string): string {
  return resolveSpatialAssetUrl(`hdri/${slug}_2k.exr`)
}

function thumbUrl(slug: string): string {
  return resolveSpatialAssetUrl(`hdri/thumbnails/${slug}.png`)
}

/** The 8 lighting presets, in Switcher display order (Mockup 43 §3). */
export const LIGHTING_PRESETS: readonly LightingPreset[] = Object.freeze([
  {
    id: 'modern-bath',
    displayName: 'Modern Bath',
    moodLine: 'Weiches Tageslicht',
    section: 'day',
    polyhavenSlug: 'bathroom',
    hdriUrl: hdriUrl('bathroom'),
    thumbnailUrl: thumbUrl('bathroom'),
    envIntensity: 1.0,
    sunIntensity: 1.2,
    sunColor: '#FFE9C7',
    sunPosition: [3, 5, 2],
    ambientFillIntensity: 0.2,
  },
  {
    id: 'ensuite',
    displayName: 'EnSuite',
    moodLine: 'Sonne durchs Fenster',
    section: 'day',
    polyhavenSlug: 'en_suite',
    hdriUrl: hdriUrl('en_suite'),
    thumbnailUrl: thumbUrl('en_suite'),
    envIntensity: 1.2,
    sunIntensity: 2.2,
    sunColor: '#FFF5DC',
    sunPosition: [4, 6, 1],
    ambientFillIntensity: 0.15,
  },
  {
    id: 'overcast',
    displayName: 'Bewölkt',
    moodLine: 'Diffuses, neutrales Licht',
    section: 'day',
    polyhavenSlug: 'kloofendal_overcast',
    hdriUrl: hdriUrl('kloofendal_overcast'),
    thumbnailUrl: thumbUrl('kloofendal_overcast'),
    envIntensity: 1.1,
    sunIntensity: 0.3,
    sunColor: '#E8EDF2',
    sunPosition: [0, 8, 0],
    ambientFillIntensity: 0.35,
  },
  {
    id: 'golden-hour',
    displayName: 'Goldene Stunde',
    moodLine: 'Warmer Sonnenuntergang',
    section: 'day',
    polyhavenSlug: 'kiara_8_sunset',
    hdriUrl: hdriUrl('kiara_8_sunset'),
    thumbnailUrl: thumbUrl('kiara_8_sunset'),
    envIntensity: 0.8,
    sunIntensity: 1.9,
    sunColor: '#FFB371',
    sunPosition: [5, 3, -2],
    ambientFillIntensity: 0.14,
  },
  {
    id: 'dusk',
    displayName: 'Abenddämmerung',
    moodLine: 'Kühles Abendlicht',
    section: 'evening-studio',
    polyhavenSlug: 'evening_road_01',
    hdriUrl: hdriUrl('evening_road_01'),
    thumbnailUrl: thumbUrl('evening_road_01'),
    envIntensity: 0.6,
    sunIntensity: 0.6,
    sunColor: '#9FB4CC',
    sunPosition: [-3, 3, -3],
    ambientFillIntensity: 0.18,
  },
  {
    id: 'warm-light',
    displayName: 'Warmes Licht',
    moodLine: 'Gemütliches Kunstlicht',
    section: 'evening-studio',
    polyhavenSlug: 'comfy_cafe',
    hdriUrl: hdriUrl('comfy_cafe'),
    thumbnailUrl: thumbUrl('comfy_cafe'),
    envIntensity: 0.4,
    sunIntensity: 0,
    sunColor: '#FFFFFF',
    sunPosition: [0, 6, 0],
    ambientFillIntensity: 0.1,
    accentPointLight: { intensity: 6, color: '#FFB060' },
  },
  {
    id: 'studio-neutral',
    displayName: 'Studio Neutral',
    moodLine: 'Neutrale Ausleuchtung',
    section: 'evening-studio',
    polyhavenSlug: 'studio_small_09',
    hdriUrl: hdriUrl('studio_small_09'),
    thumbnailUrl: thumbUrl('studio_small_09'),
    envIntensity: 1.3,
    sunIntensity: 0,
    sunColor: '#FFFFFF',
    sunPosition: [0, 6, 0],
    ambientFillIntensity: 0.3,
  },
  {
    id: 'studio-white',
    displayName: 'Studio Weiß',
    moodLine: 'Helles, klares Studio',
    section: 'evening-studio',
    polyhavenSlug: 'white_studio_05',
    hdriUrl: hdriUrl('white_studio_05'),
    thumbnailUrl: thumbUrl('white_studio_05'),
    envIntensity: 1.5,
    sunIntensity: 0,
    sunColor: '#FFFFFF',
    sunPosition: [0, 6, 0],
    ambientFillIntensity: 0.32,
  },
])

/** The default preset id (Mockup 43 · hdri-curation §1: Modern Bath). */
export const DEFAULT_LIGHTING_PRESET_ID = 'modern-bath'

const PRESET_BY_ID: ReadonlyMap<string, LightingPreset> = new Map(
  LIGHTING_PRESETS.map((p) => [p.id, p]),
)

/** Find a preset by id, or `undefined`. */
export function getLightingPreset(id: string): LightingPreset | undefined {
  return PRESET_BY_ID.get(id)
}

/** Resolve a preset by id, falling back to the default for an unknown id. */
export function resolveLightingPreset(id: string | null | undefined): LightingPreset {
  return (id ? PRESET_BY_ID.get(id) : undefined) ?? PRESET_BY_ID.get(DEFAULT_LIGHTING_PRESET_ID)!
}

/** Presets belonging to a Switcher section, in display order. */
export function lightingPresetsBySection(section: LightingSection): LightingPreset[] {
  return LIGHTING_PRESETS.filter((p) => p.section === section)
}
