/**
 * Spatial · Hooks · useMaterialCatalog
 *
 * Loads the PBR material catalog for the Material-Picker (Mockup 42) and
 * exposes it filtered by surface category + grouped into Typ-Sektionen.
 *
 * Behaviour (Mockup 42 States D / E / F):
 *   - D Loading  → `status === 'loading'`, `isHydrated === false`
 *   - E Error    → fetch failed AND no cache → `status === 'error'` + `reload()`
 *   - F Offline  → fetch failed BUT a sessionStorage snapshot exists →
 *                  `status === 'offline'`, the cached catalog is still served
 *
 * The catalog is small (32 rows) so the full list is fetched once and the
 * surface filter + section grouping are pure client-side `useMemo`s — a
 * Category-Pill switch never triggers a network round-trip.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { CatalogMaterial, MaterialSurfaceCategory } from '../canonical/catalog/material-types.ts'
import { groupMaterialsBySection, type MaterialSection } from '../canonical/catalog/material-search.ts'
import { getSpatialCatalogRepository } from '../canonical/repository/catalog-repository.ts'

const CACHE_KEY = 'spatial.material-catalog.v1'

export type MaterialCatalogStatus = 'loading' | 'ready' | 'error' | 'offline'

export interface UseMaterialCatalogResult {
  /** The full published catalog (all surfaces). */
  allMaterials: CatalogMaterial[]
  /** Materials for the requested surface category. */
  materials: CatalogMaterial[]
  /** `materials` grouped into Typ-Sektionen for the browse grid. */
  sections: MaterialSection[]
  status: MaterialCatalogStatus
  /** False until the first load attempt settles (success, offline, or error). */
  isHydrated: boolean
  /** Re-attempt the catalog fetch (Mockup 42 State E "Erneut"). */
  reload: () => void
}

function readCache(): CatalogMaterial[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CatalogMaterial[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}

function writeCache(materials: CatalogMaterial[]): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(materials))
  } catch {
    // sessionStorage can throw (private mode / quota) — the cache is best-effort.
  }
}

export function useMaterialCatalog(
  surface: MaterialSurfaceCategory | null,
): UseMaterialCatalogResult {
  const [allMaterials, setAllMaterials] = useState<CatalogMaterial[]>([])
  const [status, setStatus] = useState<MaterialCatalogStatus>('loading')
  const [isHydrated, setIsHydrated] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false

    getSpatialCatalogRepository()
      .listMaterials()
      .then((rows) => {
        if (cancelled) return
        setAllMaterials(rows)
        setStatus('ready')
        setIsHydrated(true)
        writeCache(rows)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const cached = readCache()
        if (cached) {
          setAllMaterials(cached)
          setStatus('offline')
        } else {
          console.warn('[spatial] material catalog load failed:', error)
          setStatus('error')
        }
        setIsHydrated(true)
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const reload = useCallback(() => {
    setStatus('loading')
    setReloadToken((t) => t + 1)
  }, [])

  const materials = useMemo(
    () => (surface ? allMaterials.filter((m) => m.surfaceCategory === surface) : allMaterials),
    [allMaterials, surface],
  )

  const sections = useMemo(() => groupMaterialsBySection(materials), [materials])

  return { allMaterials, materials, sections, status, isHydrated, reload }
}
