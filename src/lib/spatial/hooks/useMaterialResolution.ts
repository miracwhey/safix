/**
 * Spatial · Hooks · useMaterialResolution
 *
 * The Material-Picker switch-logic (Mockup 42 block 1.14/1.15) + the OQ-14
 * missing-variant fallback (findings addendum 2026-05-19).
 *
 * Switch-logic — `applyMaterial` performs a Phase-1 direct variant-write: it
 * upserts a `material_id` override on the surface node into the canonical
 * scene store and returns an {@link MaterialApplyHandle} whose `undo()` reverts
 * exactly that write (restoring any prior override). The Phase-2 command stack
 * will wrap this; Phase 1 pairs it with the Undo-Toast.
 *
 * OQ-14 — when `activeVariantId` points at a variant that is not in the
 * variants list:
 *   - 'silent' (read-only Customer viewer): render base, `console.warn` once.
 *   - 'warn-pill-and-clear' (edit-mode viewer): expose `warnPillVisible`, then
 *     auto-clear the dangling variant after 3 s via `onClearVariant`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Variant, VariantId, NodeOverride } from '../canonical/types/variants.ts'
import { useCanonicalSceneStore } from '../canonical/store/sceneStore.ts'

/** OQ-14 fallback mode — depends on whether the viewer is read-only or edit. */
export type MissingVariantBehavior = 'silent' | 'warn-pill-and-clear'

/**
 * Reversible record of one material variant-write.
 *
 * `undo()` captures the (surface, variant) override as it was at write time
 * and restores it verbatim. It is therefore only sound as the *immediate*
 * next mutation on that pair — a later write on the same surface that is then
 * undone via a stale handle would clobber the newer state. The Material-Picker
 * UI enforces this: only ONE Undo-Toast is live at a time, and applying a new
 * material dismisses the previous toast (so the previous handle is dropped).
 * The Phase-2 command stack supersedes this with a proper history.
 */
export interface MaterialApplyHandle {
  surfaceId: string
  variantId: VariantId
  materialSlug: string
  /** The slug that was applied before this write (null = none / base). */
  previousMaterialSlug: string | null
  /** Revert this exact write — restores the prior override or removes it. */
  undo: () => void
}

export interface UseMaterialResolutionOptions {
  activeVariantId: VariantId | null
  variants: readonly Variant[]
  missingVariantBehavior: MissingVariantBehavior
  /** Edit-mode only — invoked 3 s after a missing variant is detected. */
  onClearVariant?: () => void
}

export interface UseMaterialResolutionResult {
  /** True when `activeVariantId` is set but absent from `variants`. */
  missingVariant: boolean
  /** Edit-mode warn-pill visibility (always false in 'silent' mode). */
  warnPillVisible: boolean
  /**
   * Apply a material to a surface as a variant-write. Returns a handle whose
   * `undo()` reverts it. A no-op for an empty `materialSlug`.
   */
  applyMaterial: (
    surfaceId: string,
    materialSlug: string,
    variantId: VariantId,
  ) => MaterialApplyHandle
}

const MISSING_VARIANT_CLEAR_MS = 3000

function overrideMaterialSlug(override: NodeOverride | undefined): string | null {
  const value = override?.override_fields?.material_id
  return typeof value === 'string' ? value : null
}

/**
 * Perform one material variant-write against the canonical scene store and
 * return a reversible handle. Extracted from the hook so the switch-logic can
 * be unit-tested without a React renderer.
 *
 * The write shallow-merges `material_id` onto any prior override for the
 * (surface, variant) pair, so other overridden fields survive. `undo()`
 * restores the prior override verbatim, or removes the override entirely when
 * there was none.
 */
export function writeMaterialOverride(
  surfaceId: string,
  materialSlug: string,
  variantId: VariantId,
): MaterialApplyHandle {
  const store = useCanonicalSceneStore.getState()
  const prior = store.overrides.find(
    (o) => o.base_node_id === surfaceId && o.variant_id === variantId,
  )
  const previousMaterialSlug = overrideMaterialSlug(prior)

  store.upsertOverride({
    base_node_id: surfaceId,
    variant_id: variantId,
    override_fields: { ...(prior?.override_fields ?? {}), material_id: materialSlug },
  })

  return {
    surfaceId,
    variantId,
    materialSlug,
    previousMaterialSlug,
    undo: () => {
      const live = useCanonicalSceneStore.getState()
      if (prior) live.upsertOverride(prior)
      else live.removeOverride(surfaceId, variantId)
    },
  }
}

export function useMaterialResolution(
  options: UseMaterialResolutionOptions,
): UseMaterialResolutionResult {
  const { activeVariantId, variants, missingVariantBehavior, onClearVariant } = options

  const missingVariant = useMemo(
    () => activeVariantId != null && !variants.some((v) => v.id === activeVariantId),
    [activeVariantId, variants],
  )

  // The dangling variant id that has already been auto-cleared — set inside
  // the timeout callback (not synchronously in the effect body).
  const [clearedVariantId, setClearedVariantId] = useState<VariantId | null>(null)
  const warnedIds = useRef<Set<string>>(new Set())

  // Reset the cleared marker once the variant is no longer missing (it was
  // re-added). React's "adjust state during render" pattern — not an effect —
  // so a variant that disappears AGAIN later re-shows the pill instead of
  // being silently swallowed.
  if (!missingVariant && clearedVariantId !== null) {
    setClearedVariantId(null)
  }

  // Derived during render — no synchronous setState in an effect.
  const warnPillVisible =
    missingVariant &&
    missingVariantBehavior === 'warn-pill-and-clear' &&
    activeVariantId != null &&
    activeVariantId !== clearedVariantId

  useEffect(() => {
    if (!missingVariant || activeVariantId == null) return

    if (missingVariantBehavior === 'silent') {
      // Read-only path: a banner would only confuse the customer — warn once.
      if (!warnedIds.current.has(activeVariantId)) {
        warnedIds.current.add(activeVariantId)
        console.warn(`[spatial] variant ${activeVariantId} not found, rendering base`)
      }
      return
    }

    // Edit-mode path: the pill is already visible (derived above); after 3 s
    // auto-clear the dangling variant. setState happens in the async callback.
    if (activeVariantId === clearedVariantId) return
    const handle = setTimeout(() => {
      setClearedVariantId(activeVariantId)
      onClearVariant?.()
    }, MISSING_VARIANT_CLEAR_MS)
    return () => clearTimeout(handle)
  }, [missingVariant, missingVariantBehavior, activeVariantId, clearedVariantId, onClearVariant])

  const applyMaterial = useCallback(
    (surfaceId: string, materialSlug: string, variantId: VariantId): MaterialApplyHandle =>
      writeMaterialOverride(surfaceId, materialSlug, variantId),
    [],
  )

  return { missingVariant, warnPillVisible, applyMaterial }
}
