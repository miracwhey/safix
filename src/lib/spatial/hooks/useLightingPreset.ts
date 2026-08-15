/**
 * Spatial · Hooks · useLightingPreset
 *
 * Owns the active lighting preset for the 3D viewer (Mockup 43). Phase 1 keeps
 * it as per-session view-state: a zustand store mirrored into `sessionStorage`
 * so the choice survives a reload within the same tab but is not persisted per
 * scene (that is the Phase-2 `metadata.preferred_lighting_slug` feature —
 * Mockup 43 §1).
 */

import { create } from 'zustand'

import {
  LIGHTING_PRESETS,
  DEFAULT_LIGHTING_PRESET_ID,
  getLightingPreset,
  resolveLightingPreset,
  type LightingPreset,
} from '../canonical/lighting/presets.ts'

const STORAGE_KEY = 'spatial.lighting-preset.v1'

function readStoredPresetId(): string {
  if (typeof window === 'undefined') return DEFAULT_LIGHTING_PRESET_ID
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    return stored && getLightingPreset(stored) ? stored : DEFAULT_LIGHTING_PRESET_ID
  } catch {
    return DEFAULT_LIGHTING_PRESET_ID
  }
}

function writeStoredPresetId(id: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id)
  } catch {
    // sessionStorage can throw (private mode / quota) — persistence is best-effort.
  }
}

interface LightingPresetState {
  presetId: string
  setPresetId: (id: string) => void
  resetToDefault: () => void
}

/**
 * Underlying store. Exported for tests + non-React callers (`.getState()`);
 * components use the {@link useLightingPreset} hook.
 */
export const useLightingPresetStore = create<LightingPresetState>((set) => ({
  presetId: readStoredPresetId(),
  setPresetId: (id) => {
    // Ignore unknown ids — a stale deep-link must not break the viewer.
    if (!getLightingPreset(id)) return
    writeStoredPresetId(id)
    set({ presetId: id })
  },
  resetToDefault: () => {
    writeStoredPresetId(DEFAULT_LIGHTING_PRESET_ID)
    set({ presetId: DEFAULT_LIGHTING_PRESET_ID })
  },
}))

export interface UseLightingPresetResult {
  /** The resolved active preset object. */
  preset: LightingPreset
  presetId: string
  /** All 8 presets, in Switcher display order. */
  presets: readonly LightingPreset[]
  /** Apply a preset by id (no-op for an unknown id). */
  setPreset: (id: string) => void
  /** Restore the default preset (Modern Bath). */
  resetToDefault: () => void
}

export function useLightingPreset(): UseLightingPresetResult {
  const presetId = useLightingPresetStore((s) => s.presetId)
  const setPreset = useLightingPresetStore((s) => s.setPresetId)
  const resetToDefault = useLightingPresetStore((s) => s.resetToDefault)

  return {
    presetId,
    preset: resolveLightingPreset(presetId),
    presets: LIGHTING_PRESETS,
    setPreset,
    resetToDefault,
  }
}
