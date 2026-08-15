/**
 * Spatial · Canonical · Workflow · sceneCompareModel
 *
 * Pure logic: compares two scene variants (Kunden-Aufmaß vs Dein Arbeitsstand)
 * and produces a list of changes. Each change carries:
 *  - kind: the category of change
 *  - label: the node / element name
 *  - fromValue: the reference value (Kunden-Aufmaß)
 *  - toValue: the working value (Dein Arbeitsstand)
 *  - origin: who made the change
 *
 * Phase-C seam: in V1 the two variant blobs are not both resolvable from
 * SpatialEditHistoryEntry alone. The model is fully typed and tested; callers
 * supply variant override maps and the model derives the diff list. The UI
 * shows an empty-state + seam notice when the variant data is unavailable.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Category of a single detected change. */
export type ChangeKind = 'measurement' | 'layout' | 'pin' | 'material'

/**
 * Who is the author of this change.
 * - 'provider' = the current provider's working variant (Dein Arbeitsstand)
 * - 'customer' = the customer's corrected variant (Kunden-Aufmaß / Korrektur)
 */
export type ChangeOrigin = 'provider' | 'customer'

/** A single entry in the change report. */
export interface SceneChange {
  /** Stable id — used as React key. */
  id: string
  /**
   * The scene-graph node this change targets. The "Übernehmen" merge-write
   * (C-5) uses it as the `baseNodeId` when copying a customer correction into
   * the provider's working variant.
   */
  nodeId: string
  kind: ChangeKind
  /** Human-readable element label (e.g. "Rückwand", "Tür Eingang"). */
  label: string
  /**
   * Reference value from Kunden-Aufmaß.
   * May be null if the element was absent in the reference variant.
   */
  fromValue: string | null
  /**
   * Working value from Dein Arbeitsstand.
   * May be null if the element was removed in the working variant.
   */
  toValue: string | null
  origin: ChangeOrigin
}

/**
 * A flat map of override fields per node, keyed by nodeId.
 * Each inner map holds field name → string value as displayable text.
 * Phase-C seam: constructed by the caller from the resolved variant blobs.
 */
export type VariantOverrideMap = Map<string, Record<string, string>>

/** Result of a compare operation. */
export interface SceneCompareResult {
  /** All changes across both variants. */
  changes: SceneChange[]
  /** How many changes originated from the provider. */
  providerCount: number
  /** How many changes originated from the customer. */
  customerCount: number
}

// ─── Core diff logic ─────────────────────────────────────────────────────────

/**
 * Produce a stable, content-derived change id so the same logical change
 * always resolves to the same id regardless of call order.
 * Format: `<nodeId>-<origin>-<field>` where field is the first key of the
 * relevant override fields record (or '_' when there are no fields).
 */
function stableId(nodeId: string, origin: ChangeOrigin, fields: Record<string, string>): string {
  const field = Object.keys(fields)[0] ?? '_'
  return `${nodeId}-${origin}-${field}`
}

/**
 * Produce a human-readable value string from a fields record.
 * Returns null if the record is empty.
 */
function formatFieldValue(fields: Record<string, string>): string | null {
  const entries = Object.entries(fields)
  if (entries.length === 0) return null
  // Prefer explicit value keys in priority order
  for (const key of ['value', 'measuredValue', 'lengthM', 'widthM', 'heightM', 'label', 'name']) {
    if (fields[key] !== undefined) {
      const v = fields[key]
      // For numeric measurement fields, format with unit
      if (['lengthM', 'widthM', 'heightM', 'measuredValue'].includes(key)) {
        const n = parseFloat(v)
        return isNaN(n) ? v : `${n.toFixed(2)} m`
      }
      return v
    }
  }
  // Fallback: join all key=value pairs
  return entries.map(([k, v]) => `${k}: ${v}`).join(' · ')
}

/**
 * Infer the ChangeKind from the override field names.
 * Phase-C seam: if a typed `annotationType` is present, it wins.
 */
function inferKind(fields: Record<string, string>, label: string): ChangeKind {
  if (fields.annotationType) {
    if (fields.annotationType === 'material') return 'material'
    if (fields.annotationType === 'pin' || fields.annotationType === 'issue') return 'pin'
    if (fields.annotationType === 'measurement') return 'measurement'
    if (fields.annotationType === 'layout') return 'layout'
  }
  const keys = Object.keys(fields)
  if (keys.some((k) => ['materialId', 'materialSuggestion', 'materialName'].includes(k)))
    return 'material'
  if (keys.some((k) => ['lengthM', 'widthM', 'heightM', 'measuredValue'].includes(k)))
    return 'measurement'
  if (keys.some((k) => ['x', 'y', 'z', 'posX', 'posY', 'rotationDeg', 'offset'].includes(k)))
    return 'layout'
  // Use the node label as a last hint
  if (/wand|wärme|rückwand|seitenwand|fenster|decke|boden/i.test(label)) return 'measurement'
  if (/tür|tor|fenster|eingang/i.test(label)) return 'layout'
  return 'measurement'
}

/**
 * Compare two variant override maps and produce a change report.
 *
 * Algorithm:
 * 1. For each nodeId in the provider variant: if the customer variant has a
 *    different value for the same fields, that's a provider change.
 * 2. For each nodeId in the customer variant that doesn't appear in the
 *    provider variant, that's a customer change (newly added by customer).
 * 3. For each nodeId in the customer variant that appears in the provider
 *    variant with different values, that's also a customer-originated change
 *    if the provider variant has the reference value.
 *
 * In V1 the two variant maps are provided by the caller (Phase-C seam).
 * The labels are derived from nodeId when no explicit label is available.
 */
export function compareVariants(
  /** Kunden-Aufmaß — the reference / baseline variant. */
  referenceVariant: VariantOverrideMap,
  /** Dein Arbeitsstand — the provider working variant. */
  workingVariant: VariantOverrideMap,
  /** Optional: human-readable label per nodeId. */
  nodeLabels?: Map<string, string>,
  /**
   * Provenance guard (C-5): node ids the provider DELETED in the working
   * variant. A node only-in-reference that the provider deliberately removed
   * is NOT a pending customer change — surfacing an "Übernehmen" for it would
   * silently undo the provider's own deletion. Such nodes are skipped.
   */
  workingDeletedNodeIds?: ReadonlySet<string>,
): SceneCompareResult {
  const changes: SceneChange[] = []

  const label = (nodeId: string): string => nodeLabels?.get(nodeId) ?? nodeId

  // Nodes that exist in the working variant
  for (const [nodeId, workingFields] of workingVariant) {
    const refFields = referenceVariant.get(nodeId)
    const nodeLabel = label(nodeId)
    const fromValue = refFields ? formatFieldValue(refFields) : null
    const toValue = formatFieldValue(workingFields)

    if (!refFields) {
      // Node only in working variant — provider added it
      changes.push({
        id: stableId(nodeId, 'provider', workingFields),
        nodeId,
        kind: inferKind(workingFields, nodeLabel),
        label: nodeLabel,
        fromValue: null,
        toValue,
        origin: 'provider',
      })
    } else {
      // Node in both — check if values differ
      const refValue = formatFieldValue(refFields)
      if (refValue !== toValue) {
        changes.push({
          id: stableId(nodeId, 'provider', workingFields),
          nodeId,
          kind: inferKind(workingFields, nodeLabel),
          label: nodeLabel,
          fromValue,
          toValue,
          origin: 'provider',
        })
      }
    }
  }

  // Nodes only in reference variant — customer added them, not yet in working.
  // fromValue = reference (Kunden-Aufmaß) value; toValue = null (not yet in working).
  for (const [nodeId, refFields] of referenceVariant) {
    if (!workingVariant.has(nodeId)) {
      // Provenance: skip a node the provider deliberately removed — it is not
      // an un-taken customer change.
      if (workingDeletedNodeIds?.has(nodeId)) continue
      const nodeLabel = label(nodeId)
      changes.push({
        id: stableId(nodeId, 'customer', refFields),
        nodeId,
        kind: inferKind(refFields, nodeLabel),
        label: nodeLabel,
        fromValue: formatFieldValue(refFields),
        toValue: null,
        origin: 'customer',
      })
    }
  }

  const providerCount = changes.filter((c) => c.origin === 'provider').length
  const customerCount = changes.filter((c) => c.origin === 'customer').length

  return { changes, providerCount, customerCount }
}

/**
 * Utility: build a VariantOverrideMap from SpatialEditHistoryEntry rows.
 * Uses the latest entry per baseNodeId (sorted by createdAt desc).
 * Phase-C seam: in V1 the variantId must be filtered by the caller before
 * passing entries in; this function doesn't filter by variantId.
 */
export function buildVariantOverrideMap(
  entries: Array<{ baseNodeId: string; overrideFields: Record<string, unknown>; createdAt: string }>,
): VariantOverrideMap {
  // Group by nodeId; keep latest entry
  const byNode = new Map<string, { fields: Record<string, unknown>; ts: number }>()
  for (const e of entries) {
    const ts = new Date(e.createdAt).getTime()
    const existing = byNode.get(e.baseNodeId)
    if (!existing || ts > existing.ts) {
      byNode.set(e.baseNodeId, { fields: e.overrideFields, ts })
    }
  }
  const result: VariantOverrideMap = new Map()
  for (const [nodeId, { fields }] of byNode) {
    // Coerce values to strings for display
    const strFields: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) {
      strFields[k] = String(v ?? '')
    }
    result.set(nodeId, strFields)
  }
  return result
}
