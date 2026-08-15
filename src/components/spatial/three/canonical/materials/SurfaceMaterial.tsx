/**
 * Spatial · Canonical · Materials · SurfaceMaterial (Phase 1.5 · Block R5)
 *
 * The shared material element for the four geometry adapters — `WallAdapter`,
 * `FloorAdapter`, `CeilingAdapter`, `ObjectAdapter`. It replaces the hardcoded
 * `<meshStandardMaterial color="#…">` placeholders with the catalog-driven PBR
 * material resolved by `loadMaterial`.
 *
 * Async without Suspense: `loadMaterial` is a promise, but a surface must
 * never disappear while its textures download. So this element renders the
 * synchronous fallback material immediately (see `useSurfaceMaterial`), kicks
 * off the async load, and swaps in the textured material when it resolves — a
 * progressive upgrade, not a blank frame. A load failure simply keeps the
 * fallback.
 *
 * `materialId` resolution is the caller's job: each adapter reads the resolved
 * `material_id` off its node (Wall / Floor / Ceiling / Object all carry the
 * field) and passes it here. A `null`/absent `materialId` renders the
 * adapter's own default tint via `defaultColor`.
 *
 * The `side` prop: the resolved catalog material is a SHARED, cached instance,
 * so its `side` must not be mutated in place (a wall and a ceiling could share
 * a slug). When a non-default `side` is requested the element renders a
 * per-mesh clone of the cached material — the clone shares the cached textures
 * (cheap) and is disposed on unmount.
 *
 * AO requirement: `aoMap` samples the second UV channel (`uv2`). Adapter
 * geometries built from `BoxGeometry` / `ShapeGeometry` / the procedural
 * converter only have `uv`, so adapters call `ensureUv2` on their geometry.
 */

import { useEffect, useMemo, type ReactElement } from 'react'
import { Color, FrontSide, type Side } from 'three'

import { useSurfaceMaterial } from './surfaceMaterialHooks.ts'

/**
 * R12.3: Emissive-Tint für selected-Surfaces. Warmer Liquid-Glass-Glow — die
 * Surface scheint sanft von innen zu leuchten. Hex matched die "warm light"-
 * Akzent-Farbe aus dem Liquid-Glass-Standard (~#fff6e6 directionalLight in
 * CanonicalSceneRoot).
 */
const SELECTED_EMISSIVE_HEX = '#fff1c8'
const SELECTED_EMISSIVE_INTENSITY = 0.45

interface SurfaceMaterialProps {
  /** Resolved catalog material slug, or null/undefined for the default tint. */
  materialId?: string | null
  /** Tint used when no `materialId` is set (the adapter's Day-11 placeholder). */
  defaultColor: string
  /** Default scalar roughness for the no-material tint. */
  defaultRoughness?: number
  /** Default scalar metalness for the no-material tint. */
  defaultMetalness?: number
  /**
   * `side` to forward to the material (e.g. ceilings render `THREE.DoubleSide`).
   * Defaults to `FrontSide`.
   */
  side?: Side
  /**
   * Enable depth polygon-offset on the default-tint material — pushes the
   * filled surface slightly back so a co-planar `EdgesGeometry` line layer
   * draws cleanly without z-fighting (corners-edges-design §3.6). Applies
   * only to the default tint; a resolved catalog material is shared / cached
   * and must not be mutated.
   */
  polygonOffset?: boolean
  /**
   * R12.3: wenn `true`, wird die Surface durch Emissive-Boost hervorgehoben.
   * Default-Tint-Material kriegt das Highlight inline (cloning unnötig).
   * Resolved-Katalog-Material wird geklont, damit die geteilte Cache-Instanz
   * nicht mutiert wird (gleicher Pattern wie `side`-Override).
   */
  isSelected?: boolean
}

/**
 * Material element for the geometry adapters.
 *
 * Renders either the resolved catalog material (via `<primitive>` so the
 * shared cached instance is reused, not cloned — unless a non-default `side`
 * forces a per-mesh clone) or — when no `materialId` is set — a plain
 * `<meshStandardMaterial>` with the adapter's default tint.
 */
export function SurfaceMaterial({
  materialId,
  defaultColor,
  defaultRoughness = 0.85,
  defaultMetalness = 0,
  side = FrontSide,
  polygonOffset = false,
  isSelected = false,
}: SurfaceMaterialProps): ReactElement {
  const resolved = useSurfaceMaterial(materialId)

  // R12.3: Clone wenn (a) Non-Default-Side, ODER (b) isSelected. Beide würden
  // sonst die shared Cache-Instanz mutieren und Walls/Ceilings teilen
  // Materials. Clone ist günstig (Textur-Refs sind shared); nur die geklonte
  // Instanz wird disposed.
  const needsClone = resolved != null && (side !== FrontSide || isSelected)
  const sided = useMemo(() => {
    if (!resolved) return null
    if (!needsClone) return resolved
    const clone = resolved.clone()
    clone.side = side
    if (isSelected) {
      clone.emissive = new Color(SELECTED_EMISSIVE_HEX)
      clone.emissiveIntensity = SELECTED_EMISSIVE_INTENSITY
    }
    return clone
  }, [resolved, needsClone, side, isSelected])

  useEffect(() => {
    if (!needsClone || !sided) return
    return () => sided.dispose()
  }, [needsClone, sided])

  if (sided) {
    return <primitive object={sided} attach="material" />
  }

  // Default-Tint-Pfad: meshStandardMaterial inline mit emissive-Boost. Kein
  // Clone nötig, weil es kein Shared-Cache-Material ist.
  return (
    <meshStandardMaterial
      color={defaultColor}
      roughness={defaultRoughness}
      metalness={defaultMetalness}
      side={side}
      polygonOffset={polygonOffset}
      polygonOffsetFactor={polygonOffset ? 1 : 0}
      polygonOffsetUnits={polygonOffset ? 1 : 0}
      emissive={isSelected ? SELECTED_EMISSIVE_HEX : '#000000'}
      emissiveIntensity={isSelected ? SELECTED_EMISSIVE_INTENSITY : 0}
    />
  )
}
