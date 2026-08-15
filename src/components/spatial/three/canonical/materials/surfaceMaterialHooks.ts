/**
 * Spatial · Canonical · Materials · Surface-Material Hooks (Phase 1.5 · Block R5)
 *
 * The non-component helpers behind `<SurfaceMaterial>` — split into their own
 * module so the component file only exports components (Vite fast-refresh).
 *
 *   - `ensureUv2` — mirror a geometry's `uv` into `uv2` so the catalog
 *     material's `aoMap` (which always samples `uv2`) renders on box / shape /
 *     procedural geometries that ship only `uv`.
 *   - `useSurfaceMaterial` — resolve a catalog material slug into a live
 *     `MeshStandardMaterial`, progressively upgrading from the synchronous
 *     fallback to the textured material once `loadMaterial` resolves.
 */

import { useEffect, useMemo, useState } from 'react'
import type { BufferGeometry, MeshStandardMaterial } from 'three'

import { fallbackMaterial, loadMaterial } from './MaterialLoader.ts'

/**
 * Mirror a geometry's `uv` attribute into `uv2` if it has none.
 *
 * `aoMap` always samples `uv2`; box / shape / procedural geometries ship only
 * `uv`. Without this the AO map would sample an undefined channel and either
 * render black or be silently dropped. Idempotent — a geometry that already
 * has `uv2` (a GLB authored with a lightmap channel) is left untouched.
 */
export function ensureUv2(geometry: BufferGeometry): void {
  if (geometry.getAttribute('uv2')) return
  const uv = geometry.getAttribute('uv')
  if (!uv) return
  geometry.setAttribute('uv2', uv)
}

/**
 * Resolve a catalog material slug into a live `MeshStandardMaterial`,
 * upgrading from the synchronous fallback to the textured material on load.
 *
 * Returns `null` while there is no `materialId` — the caller then renders a
 * plain `<meshStandardMaterial>` with its default tint.
 *
 * The fallback for the current slug is produced during render (no
 * setState-in-effect): a `materialId` change is observed synchronously and the
 * matching fallback is shown the same frame. The async upgrade runs in an
 * effect and only calls setState in the promise callback.
 */
export function useSurfaceMaterial(
  materialId: string | null | undefined,
): MeshStandardMaterial | null {
  // The textured material, once `loadMaterial` resolves. Keyed by slug so a
  // stale resolution for a previous slug is never shown.
  const [loaded, setLoaded] = useState<{ slug: string; material: MeshStandardMaterial } | null>(
    null,
  )

  // The synchronous fallback for the current slug — recomputed only when the
  // slug changes, so it is referentially stable across re-renders.
  const fallback = useMemo(
    () => (materialId ? fallbackMaterial(materialId) : null),
    [materialId],
  )

  useEffect(() => {
    if (!materialId) return
    let cancelled = false
    loadMaterial(materialId)
      .then((material) => {
        if (!cancelled) setLoaded({ slug: materialId, material })
      })
      .catch(() => {
        // loadMaterial already degrades to a fallback internally; this catch
        // is a belt-and-braces guard so a rejected promise never bubbles.
      })
    return () => {
      cancelled = true
    }
  }, [materialId])

  if (!materialId) return null
  // Prefer the textured material once it has resolved for the CURRENT slug;
  // otherwise show the synchronous fallback for that slug.
  if (loaded && loaded.slug === materialId) return loaded.material
  return fallback
}
