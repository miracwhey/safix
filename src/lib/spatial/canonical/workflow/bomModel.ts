/**
 * Spatial · Canonical · Workflow · BoM Model (B-5)
 *
 * Pure logic — zero React, zero side-effects.
 *
 * Represents a Bill-of-Materials for a spatial job. Quantities for
 * `source='auto'` items are computed from scene geometry (Phase-C seam:
 * the auto-generation pass will populate `nodeId` and derive quantity from
 * the scene graph). For V1 all items start as `source='manual'`; the
 * auto-path is a documented Phase-C seam.
 *
 * Monetary values use integer cent arithmetic throughout to avoid
 * floating-point drift in summation and VAT rounding.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type BomUnit = 'm2' | 'pcs' | 'lfm' | 'h'

export type BomItemSource = 'auto' | 'manual'

/**
 * Transparent breakdown of a wall's billable surface area.
 *
 * `netM2 = max(0, grossM2 − openingsM2)`. Carried on the wall auto-item so the
 * BoM tab + Offer-PDF can show the deduction explicitly (Brutto / −Öffnungen /
 * Netto) rather than hiding it behind a single number — the craftsman keeps the
 * choice of net (openings deducted) vs. gross (VOB-Übermessung for small
 * openings, DIN 18363) via {@link BomItem.quantityOverride}.
 */
export interface WallAreaBreakdown {
  /** length_m × height_m — the full rectangle. */
  grossM2: number
  /** Σ(opening.width_m × opening.height_m) over the wall's openings. */
  openingsM2: number
  /** max(0, grossM2 − openingsM2) — the default billed quantity. */
  netM2: number
}

/**
 * One line item in the BoM.
 *
 * `position`        — 1-based display number, shared with the floor-plan marker.
 * `nodeId`          — Phase-C seam: auto-items link to a scene-graph node-id so
 *                     that bi-directional plan↔list selection can be driven from
 *                     scene geometry. `undefined` for manual items.
 * `unitPriceCents`  — price per unit in integer cents (e.g. 4000 = 40,00 €).
 *                     `0` means "not yet priced".
 * `quantityOverride`— manual override of the geometry-derived `quantity`. When
 *                     set, it is the billed quantity (see {@link effectiveQuantity})
 *                     and survives a re-scan via {@link reconcileAutoItems}. Lets
 *                     the craftsman correct the auto quantity (e.g. switch a wall
 *                     back to gross area for VOB-Übermessung) without losing it on
 *                     the next geometry refresh. `undefined` = use `quantity`.
 * `areaBreakdown`   — for wall auto-items: the gross/openings/net breakdown the
 *                     billed `quantity` (net) was derived from. Drives the
 *                     transparent deduction display + the "auf Brutto"/"Netto"
 *                     quick toggle. `undefined` for non-wall items.
 */
export interface BomItem {
  id: string
  position: number
  description: string
  category: string
  quantity: number
  unit: BomUnit
  unitPriceCents: number
  source: BomItemSource
  /** Phase-C seam: scene-graph node id for auto items. */
  nodeId?: string
  /** Manual override of the geometry-derived `quantity` (billed when set). */
  quantityOverride?: number
  /** Wall surface breakdown (gross/openings/net) — wall auto-items only. */
  areaBreakdown?: WallAreaBreakdown
  /**
   * For a manual position created from a DIN norm hint: the source warning's
   * identity key. Lets the UI derive "already added" from the item list itself
   * (not a mirror set) so a delete / undo re-syncs the hint automatically.
   */
  dinSourceKey?: string
}

/**
 * The quantity actually billed for an item: the manual {@link BomItem.quantityOverride}
 * when the craftsman set one, otherwise the geometry-derived `quantity`. Every
 * money path (totals, line-item net) and the offer mapping MUST go through this
 * so an override is never silently dropped.
 */
export function effectiveQuantity(item: BomItem): number {
  return item.quantityOverride ?? item.quantity
}

export interface BomTotals {
  netCents: number
  vatCents: number
  grossCents: number
}

// ─── Totals ───────────────────────────────────────────────────────────────────

/**
 * Compute net/VAT/gross totals for a list of items.
 *
 * VAT is rounded per-total (single-rounding after summing), not per-item,
 * matching standard DE invoice practice for quick-quote use cases.
 *
 * @param items       - BoM items (may be empty)
 * @param vatRatePct  - integer VAT rate (e.g. `19` for 19 %)
 */
export function computeBomTotals(items: BomItem[], vatRatePct: number): BomTotals {
  const netCents = items.reduce((sum, item) => {
    return sum + Math.round(effectiveQuantity(item) * item.unitPriceCents)
  }, 0)
  const vatCents = Math.round(netCents * (vatRatePct / 100))
  const grossCents = netCents + vatCents
  return { netCents, vatCents, grossCents }
}

// ─── Position numbering ───────────────────────────────────────────────────────

/**
 * Return the next available 1-based position number for a new item.
 * Gaps are NOT filled — the new item always gets max+1.
 */
export function nextPosition(items: BomItem[]): number {
  if (items.length === 0) return 1
  return Math.max(...items.map((i) => i.position)) + 1
}

// ─── Immutable item helpers ───────────────────────────────────────────────────

/**
 * Add a new item to the list (immutable — returns a new array).
 *
 * The caller supplies all fields except `position` which is derived
 * automatically via {@link nextPosition}.
 */
export function addManualItem(
  items: BomItem[],
  partial: Omit<BomItem, 'position' | 'source'>,
): BomItem[] {
  const item: BomItem = {
    ...partial,
    position: nextPosition(items),
    source: 'manual',
  }
  return [...items, item]
}

/**
 * Update an existing item (immutable — returns a new array).
 * Matching is by `id`. If the id is not found the list is returned unchanged.
 */
export function updateItem(items: BomItem[], id: string, patch: Partial<BomItem>): BomItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch, id } : item))
}

/**
 * Remove an item by id (immutable — returns a new array).
 * Position numbers of remaining items are NOT re-numbered so that existing
 * plan markers still match their list rows.
 */
export function removeItem(items: BomItem[], id: string): BomItem[] {
  return items.filter((item) => item.id !== id)
}

// ─── Auto-item reconciliation ─────────────────────────────────────────────────

/**
 * Merge a freshly generated auto-item set into the current list, preserving
 * everything the user has touched.
 *
 * Without this, re-running `generateAutoItems` on a scene reload / re-scan
 * would overwrite the list with bare geometry — wiping every entered price
 * and every manual position. `reconcileAutoItems` matches the fresh items to
 * the existing ones by `nodeId` and keeps the user's `unitPriceCents`, edited
 * `description`, and stable item `id`; the geometry-derived `quantity` /
 * `unit` / `category` always come from `fresh`. Manual items pass through
 * untouched except for renumbering to follow the auto block so auto- and
 * manual-position numbers never collide.
 */
export function reconcileAutoItems(existing: BomItem[], fresh: BomItem[]): BomItem[] {
  const existingAutoByNode = new Map<string, BomItem>()
  for (const item of existing) {
    if (item.source === 'auto' && item.nodeId != null) {
      existingAutoByNode.set(item.nodeId, item)
    }
  }

  const reconciledAuto: BomItem[] = fresh.map((freshItem, idx) => {
    const prev =
      freshItem.nodeId != null ? existingAutoByNode.get(freshItem.nodeId) : undefined
    if (!prev) return { ...freshItem, position: idx + 1 }
    // Matched node — keep the user's pricing + label + stable id, and the
    // manual quantity override so a correction is not wiped by a re-scan. The
    // fresh geometry (quantity / unit / areaBreakdown) is otherwise authoritative.
    return {
      ...freshItem,
      position: idx + 1,
      id: prev.id,
      unitPriceCents: prev.unitPriceCents,
      description: prev.description,
      ...(prev.quantityOverride != null && { quantityOverride: prev.quantityOverride }),
    }
  })

  const manualItems: BomItem[] = existing
    .filter((i) => i.source === 'manual')
    .map((item, idx) => ({ ...item, position: reconciledAuto.length + idx + 1 }))

  return [...reconciledAuto, ...manualItems]
}
