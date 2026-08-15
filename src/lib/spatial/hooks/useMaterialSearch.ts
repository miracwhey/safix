/**
 * Spatial · Hooks · useMaterialSearch
 *
 * Debounced, diacritic-insensitive search over a material list for the
 * Material-Picker (Mockup 42 §3a · State B). Scoped to the materials passed
 * in (the picker passes the surface-filtered list — search never crosses
 * Category-Pills). Debounce is 200 ms per the spec.
 *
 * An empty query yields `isActive === false`, signalling the picker to render
 * the grouped Typ-Sektionen instead of the flat result list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { CatalogMaterial } from '../canonical/catalog/material-types.ts'
import { searchMaterials } from '../canonical/catalog/material-search.ts'

const DEBOUNCE_MS = 200

export interface UseMaterialSearchResult {
  /** Live input value (bind to the search field). */
  query: string
  setQuery: (value: string) => void
  /** Query after the 200 ms debounce — drives the actual filtering. */
  debouncedQuery: string
  /** Flat result list for the debounced query. */
  results: CatalogMaterial[]
  resultCount: number
  /** True once a non-empty query is committed — picker shows flat results. */
  isActive: boolean
  /** Clear the query (Mockup 42 search clear-button / empty-state action). */
  clear: () => void
}

export function useMaterialSearch(
  materials: readonly CatalogMaterial[],
): UseMaterialSearchResult {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query])

  const results = useMemo(
    () => searchMaterials(materials, debouncedQuery),
    [materials, debouncedQuery],
  )

  const isActive = debouncedQuery.trim().length > 0

  // Stable identity — a fresh closure each render would churn memoized
  // consumers (and the picker's reset effect depends on it).
  const clear = useCallback(() => {
    setQuery('')
    setDebouncedQuery('')
  }, [])

  return {
    query,
    setQuery,
    debouncedQuery,
    results,
    resultCount: results.length,
    isActive,
    clear,
  }
}
