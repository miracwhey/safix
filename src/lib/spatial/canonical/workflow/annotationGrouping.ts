/**
 * Spatial · Canonical · Workflow · annotationGrouping
 *
 * Pure logic: groups SpatialEditHistoryEntry rows by author (actorId),
 * derives per-group review state, and maps the edit-history command to a
 * displayable annotation kind + severity word.
 *
 * Phase-C seam: severity, actor role, and per-pin review status are not
 * present on SpatialEditHistoryEntry. The grouping model exposes these
 * as optional fields so Phase-C can populate them without breaking callers.
 */

import type { SpatialEditHistoryEntry } from '../repository/SpatialSceneRepository'

// ─── Annotation kind ────────────────────────────────────────────────────────

/** Inferred display kind for an annotation. */
export type AnnotationKind = 'measurement' | 'material' | 'issue' | 'photo' | 'note'

/**
 * Derive the annotation kind from the edit-history row.
 * Uses overrideFields heuristics — Phase-C seam: if Phase C adds a
 * dedicated `annotationType` field, replace this with a direct read.
 */
export function deriveAnnotationKind(entry: SpatialEditHistoryEntry): AnnotationKind {
  const fields = entry.overrideFields
  if ('annotationType' in fields) {
    const t = String(fields.annotationType)
    if (t === 'material') return 'material'
    if (t === 'issue' || t === 'problem') return 'issue'
    if (t === 'photo') return 'photo'
    if (t === 'measurement') return 'measurement'
  }
  if ('photoUrl' in fields || 'imageUrl' in fields) return 'photo'
  if ('materialId' in fields || 'materialSuggestion' in fields) return 'material'
  if (
    'measuredValue' in fields ||
    'lengthM' in fields ||
    'widthM' in fields ||
    'heightM' in fields
  )
    return 'measurement'
  if ('issueNote' in fields || 'problem' in fields) return 'issue'
  return 'note'
}

// ─── Severity ───────────────────────────────────────────────────────────────

/** Severity level for an annotation (Phase-C seam). */
export type AnnotationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none'

/**
 * Map a severity value to a German display word.
 * Used in pin meta lines ("Hohe Priorität", "Mittel", …).
 */
export function severityToWord(severity: AnnotationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'Kritisch'
    case 'high':
      return 'Hohe Priorität'
    case 'medium':
      return 'Mittlere Priorität'
    case 'low':
      return 'Niedrige Priorität'
    case 'none':
      return ''
  }
}

/**
 * Derive severity from the edit-history row.
 * Phase-C seam: real severity lives on pin metadata; until then we infer
 * from overrideFields heuristics.
 */
export function deriveAnnotationSeverity(entry: SpatialEditHistoryEntry): AnnotationSeverity {
  const fields = entry.overrideFields
  if ('severity' in fields) {
    const s = String(fields.severity)
    if (s === 'critical') return 'critical'
    if (s === 'high') return 'high'
    if (s === 'medium') return 'medium'
    if (s === 'low') return 'low'
  }
  if ('priority' in fields) {
    const p = String(fields.priority)
    if (p === 'critical') return 'critical'
    if (p === 'high') return 'high'
    if (p === 'medium') return 'medium'
    if (p === 'low') return 'low'
  }
  return 'none'
}

// ─── Review state ────────────────────────────────────────────────────────────

/**
 * Per-pin review status (Phase-C seam: persisted in a future pin-review table).
 * V1: always 'pending' — pins are unreviewed until Phase-C wires the real state.
 */
export type PinReviewState = 'pending' | 'approved' | 'rejected' | 'edited'

/** Grouped annotation entry — one row in the pin list. */
export interface GroupedAnnotation {
  entry: SpatialEditHistoryEntry
  kind: AnnotationKind
  severity: AnnotationSeverity
  /** Phase-C seam: always 'pending' in V1 */
  reviewState: PinReviewState
}

// ─── Author group ─────────────────────────────────────────────────────────────

/**
 * Actor role inferred from context.
 * Phase-C seam: real role lives in the provider team membership table.
 * V1: we cannot distinguish worker from customer from the edit-history row alone.
 */
export type ActorRole = 'worker' | 'customer' | 'foreman' | 'unknown'

/** Per-group review state aggregation. */
export interface GroupReviewState {
  total: number
  pending: number
  approved: number
  rejected: number
}

/** One author group as rendered in the Pins tab. */
export interface AnnotationAuthorGroup {
  /** The actorId — null if the actor was anonymous. */
  actorId: string | null
  /**
   * Display name for the actor.
   * Phase-C seam: resolved from team membership; V1 falls back to "Unbekannt".
   */
  displayName: string
  /** Phase-C seam: always 'unknown' in V1. */
  role: ActorRole
  /** Whether the foreman CTA ("Alle prüfen") is shown for this group. */
  isActionable: boolean
  reviewState: GroupReviewState
  pins: GroupedAnnotation[]
}

/**
 * Resolved author info per actorId — supplied by the caller (C-6 · Seam 14).
 * The caller resolves it from `team_members` / the scene customer; this pure
 * module just consumes the map.
 */
export interface GroupAnnotationsOptions {
  /** annotationNodeId (= `entry.baseNodeId`) → persisted review state. */
  reviewStates?: ReadonlyMap<string, PinReviewState>
  /** actorId → resolved author display info. */
  authorInfo?: ReadonlyMap<string | null, { displayName: string; role: ActorRole }>
}

/**
 * Group a flat list of edit-history entries by actorId.
 *
 * Ordering:
 * - Actionable (worker) groups come first, then by count of pending pins desc.
 * - Within a group, entries are ordered by createdAt descending (newest first).
 *
 * C-6: `reviewStates` + `authorInfo` are supplied by the caller. Without them
 * pins fall back to 'pending' and authors to 'Unbekannt' / 'unknown'.
 * `isActionable` is derived from the author ROLE (worker), not the pending
 * count — a fully reviewed worker group stays a worker group.
 */
export function groupAnnotationsByAuthor(
  entries: SpatialEditHistoryEntry[],
  opts: GroupAnnotationsOptions = {},
): AnnotationAuthorGroup[] {
  // 1. Build a map from actorId → entries
  const map = new Map<string | null, SpatialEditHistoryEntry[]>()
  for (const entry of entries) {
    const key = entry.actorId
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(entry)
  }

  // 2. Convert each bucket to a group
  const groups: AnnotationAuthorGroup[] = []
  for (const [actorId, actorEntries] of map) {
    // Sort entries newest first
    const sorted = [...actorEntries].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )

    const pins: GroupedAnnotation[] = sorted.map((entry) => ({
      entry,
      kind: deriveAnnotationKind(entry),
      severity: deriveAnnotationSeverity(entry),
      reviewState: opts.reviewStates?.get(entry.baseNodeId) ?? 'pending',
    }))

    const reviewState: GroupReviewState = {
      total: pins.length,
      pending: pins.filter((p) => p.reviewState === 'pending').length,
      approved: pins.filter((p) => p.reviewState === 'approved').length,
      rejected: pins.filter((p) => p.reviewState === 'rejected').length,
    }

    const author = opts.authorInfo?.get(actorId)
    const role: ActorRole = author?.role ?? 'unknown'
    groups.push({
      actorId,
      displayName: author?.displayName ?? 'Unbekannt',
      role,
      // C-6: actionability is a property of the author ROLE — a fully reviewed
      // worker group is still a worker group, never a read-only customer one.
      isActionable: role === 'worker',
      reviewState,
      pins,
    })
  }

  // 3. Sort: actionable groups first, then by count of pending pins desc
  groups.sort((a, b) => {
    if (a.isActionable !== b.isActionable) return a.isActionable ? -1 : 1
    return b.reviewState.pending - a.reviewState.pending
  })

  return groups
}

/**
 * Apply a filter to the flat list of entries before grouping.
 * Returns entries matching the requested filter kind.
 */
export type AnnotationFilter = 'all' | 'pending' | 'issues'

export function filterAnnotations(
  entries: SpatialEditHistoryEntry[],
  filter: AnnotationFilter,
  reviewStates?: ReadonlyMap<string, PinReviewState>,
): SpatialEditHistoryEntry[] {
  if (filter === 'all') return entries
  if (filter === 'pending') {
    // C-6: an entry is pending when its node has no persisted review.
    return entries.filter(
      (e) => (reviewStates?.get(e.baseNodeId) ?? 'pending') === 'pending',
    )
  }
  if (filter === 'issues') {
    return entries.filter((e) => {
      const kind = deriveAnnotationKind(e)
      return kind === 'issue'
    })
  }
  return entries
}
