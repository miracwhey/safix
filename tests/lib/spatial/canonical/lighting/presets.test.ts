/**
 * Tests for canonical/lighting/presets.ts + the useLightingPreset store.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING_PRESET_ID,
  getLightingPreset,
  resolveLightingPreset,
  lightingPresetsBySection,
} from '../../../../../src/lib/spatial/canonical/lighting/presets.ts'
import { useLightingPresetStore } from '../../../../../src/lib/spatial/hooks/useLightingPreset.ts'

describe('lighting presets', () => {
  it('has 8 presets split 4 day / 4 evening-studio', () => {
    expect(LIGHTING_PRESETS).toHaveLength(8)
    expect(lightingPresetsBySection('day')).toHaveLength(4)
    expect(lightingPresetsBySection('evening-studio')).toHaveLength(4)
  })

  it('has unique ids and a valid default', () => {
    expect(new Set(LIGHTING_PRESETS.map((p) => p.id)).size).toBe(8)
    expect(getLightingPreset(DEFAULT_LIGHTING_PRESET_ID)).toBeDefined()
    expect(DEFAULT_LIGHTING_PRESET_ID).toBe('modern-bath')
  })

  it('carries sane intensities + HDRI/thumbnail URLs for every preset', () => {
    for (const preset of LIGHTING_PRESETS) {
      expect(preset.envIntensity).toBeGreaterThan(0)
      expect(preset.sunIntensity).toBeGreaterThanOrEqual(0)
      expect(preset.ambientFillIntensity).toBeGreaterThan(0)
      expect(preset.hdriUrl).toMatch(/^\/spatial-assets\/hdri\/.+_2k\.exr$/)
      expect(preset.thumbnailUrl).toMatch(/^\/spatial-assets\/hdri\/thumbnails\/.+\.png$/)
    }
  })

  it('binds a warm accent point light to the Warmes-Licht preset', () => {
    const warm = getLightingPreset('warm-light')
    expect(warm?.accentPointLight).toEqual({ intensity: 6, color: '#FFB060' })
  })

  it('resolveLightingPreset falls back to the default for an unknown id', () => {
    expect(resolveLightingPreset('does-not-exist').id).toBe(DEFAULT_LIGHTING_PRESET_ID)
    expect(resolveLightingPreset(null).id).toBe(DEFAULT_LIGHTING_PRESET_ID)
    expect(resolveLightingPreset('golden-hour').id).toBe('golden-hour')
  })
})

describe('useLightingPreset store', () => {
  beforeEach(() => {
    useLightingPresetStore.getState().resetToDefault()
  })

  it('applies a valid preset id', () => {
    useLightingPresetStore.getState().setPresetId('dusk')
    expect(useLightingPresetStore.getState().presetId).toBe('dusk')
  })

  it('ignores an unknown preset id', () => {
    useLightingPresetStore.getState().setPresetId('golden-hour')
    useLightingPresetStore.getState().setPresetId('not-a-preset')
    expect(useLightingPresetStore.getState().presetId).toBe('golden-hour')
  })

  it('resets to the default preset', () => {
    useLightingPresetStore.getState().setPresetId('studio-white')
    useLightingPresetStore.getState().resetToDefault()
    expect(useLightingPresetStore.getState().presetId).toBe(DEFAULT_LIGHTING_PRESET_ID)
  })
})
