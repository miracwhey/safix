/**
 * JobSpatialPinsTab — Job-Spatial-Detail · Tab "Pins" (Mockup 22 + 26 · B-6 →
 * Phase C · C-6).
 *
 * Pin list grouped by author with the foreman group-action (Mockup 22).
 *
 * Phase C (C-6):
 *  - Seam 13 — accept / reject / trust-all are REAL writes to
 *    `spatial_pin_reviews` via `usePinReviews`. Review status shows per pin;
 *    a review is retractable. "Allen vertrauen" is a guarded bulk write.
 *  - Seam 14 — actor displayName + role are resolved from the provider team
 *    (`getTeamMembers`) / the scene customer, and `baseNodeId` resolves to a
 *    human room-element label from the hydrated `roomScene`.
 *  - The "Ungeprüft" filter + the pending count are real; `isActionable`
 *    follows the author role; the two detail entry points are consolidated
 *    (full group + startIndex, never a sliced pin list).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  MapPin,
  AlertTriangle,
  Ruler,
  Camera,
  Shield,
  ChevronRight,
  Check,
  X,
} from 'lucide-react'
import type { JobSpatialTabProps } from './jobSpatialTabs'
import Spinner from '../../system/Spinner'
import { getSpatialSceneRepository } from '../../../lib/spatial/canonical/repository/registry'
import {
  groupAnnotationsByAuthor,
  filterAnnotations,
  deriveAnnotationKind,
  severityToWord,
} from '../../../lib/spatial/canonical/workflow/annotationGrouping'
import type {
  ActorRole,
  AnnotationKind,
  AnnotationSeverity,
  AnnotationFilter,
  AnnotationAuthorGroup,
  GroupedAnnotation,
  PinReviewState,
} from '../../../lib/spatial/canonical/workflow/annotationGrouping'
import { usePinReviews } from '../../../lib/spatial/canonical/workflow/usePinReviews'
import { useSpatialProviderRole } from '../../../lib/spatial/canonical/workflow/useSpatialProviderRole'
import type { SpatialEditHistoryEntry } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import { getTeamMembers } from '../../../lib/jobs/jobsStore'
import type { Job } from '../../../lib/jobs/types'
import type { SpatialScene } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import BottomSheet from '../../ui/BottomSheet'
import { useSession } from '../../../hooks/useSession'
import { useHaptics } from '../../../hooks/useHaptics'

// ─── Author + node-label resolution (C-6 · Seam 14) ──────────────────────────

/** Resolve a human element label for a baseNodeId from the hydrated scene. */
function nodeLabelOf(roomScene: RoomScene | null, nodeId: string): string {
  if (!roomScene) return nodeId
  if (roomScene.floor?.id === nodeId) return roomScene.floor.name ?? 'Boden'
  if (roomScene.ceiling?.id === nodeId) return roomScene.ceiling.name ?? 'Decke'
  for (const w of roomScene.walls) {
    if (w.id === nodeId) return w.name ?? 'Wand'
    for (const o of w.wall_mounted) {
      if (o.id === nodeId) return o.name ?? o.category ?? 'Objekt'
    }
    for (const op of w.openings) {
      if (op.id === nodeId) return op.name ?? 'Öffnung'
    }
  }
  for (const o of roomScene.free_objects) {
    if (o.id === nodeId) return o.name ?? o.category ?? 'Objekt'
  }
  for (const p of roomScene.pins) {
    if (p.id === nodeId) return p.name ?? 'Pin'
  }
  return nodeId
}

/** Build the actorId → author-info map from the provider team + scene customer. */
function buildAuthorInfo(
  entries: SpatialEditHistoryEntry[],
  scene: SpatialScene,
  job: Job,
): Map<string | null, { displayName: string; role: ActorRole }> {
  const team = getTeamMembers()
  const byUser = new Map(team.filter((m) => m.userId).map((m) => [m.userId!, m]))
  const info = new Map<string | null, { displayName: string; role: ActorRole }>()
  for (const entry of entries) {
    const actorId = entry.actorId
    if (info.has(actorId)) continue
    if (actorId === null) {
      info.set(actorId, { displayName: 'System', role: 'unknown' })
      continue
    }
    if (scene.customerId && actorId === scene.customerId) {
      info.set(actorId, { displayName: job.customer || 'Kundin', role: 'customer' })
      continue
    }
    const member = byUser.get(actorId)
    if (member) {
      info.set(actorId, {
        displayName: member.name,
        role: member.role === 'owner' ? 'foreman' : 'worker',
      })
      continue
    }
    info.set(actorId, { displayName: 'Unbekannt', role: 'unknown' })
  }
  return info
}

// ─── Glyph components (module-level — ESLint react-hooks/static-components) ──

function IcoMeasure() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#E5EDFB] text-brand">
      <Ruler size={15} />
    </span>
  )
}

function IcoMaterial() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#F1ECFB] text-[#7C3AED]">
      <Shield size={15} />
    </span>
  )
}

function IcoIssue() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#FEE2E2] text-danger">
      <AlertTriangle size={15} />
    </span>
  )
}

function IcoPhoto() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#EEF2FB] text-brand">
      <Camera size={15} />
    </span>
  )
}

function IcoNote() {
  return (
    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#F4F5F8] text-ink-muted">
      <MapPin size={15} />
    </span>
  )
}

function KindIcon({ kind }: { kind: AnnotationKind }) {
  if (kind === 'measurement') return <IcoMeasure />
  if (kind === 'material') return <IcoMaterial />
  if (kind === 'issue') return <IcoIssue />
  if (kind === 'photo') return <IcoPhoto />
  return <IcoNote />
}

function kindLabel(kind: AnnotationKind): string {
  if (kind === 'measurement') return 'Maß'
  if (kind === 'material') return 'Material'
  if (kind === 'issue') return 'Problem'
  if (kind === 'photo') return 'Foto'
  return 'Notiz'
}

// ─── Review status pill (C-6) ─────────────────────────────────────────────────

function ReviewStatusPill({ state }: { state: PinReviewState }) {
  if (state === 'approved') {
    return (
      <span className="flex items-center gap-0.5 rounded-full bg-[#D1FAE5] px-1.5 py-0.5 text-[10px] font-bold text-ok">
        <Check size={10} strokeWidth={3} />
        geprüft
      </span>
    )
  }
  if (state === 'rejected') {
    return (
      <span className="flex items-center gap-0.5 rounded-full bg-[#FEE2E2] px-1.5 py-0.5 text-[10px] font-bold text-danger">
        <X size={10} strokeWidth={3} />
        abgelehnt
      </span>
    )
  }
  return null
}

function SeverityWord({ severity }: { severity: AnnotationSeverity }) {
  const word = severityToWord(severity)
  if (!word) return null
  const cls =
    severity === 'critical' || severity === 'high'
      ? 'text-danger font-bold'
      : severity === 'medium'
        ? 'text-warn font-bold'
        : 'text-ink-muted'
  return <span className={cls}>{word}</span>
}

// ─── Relative time ────────────────────────────────────────────────────────────

function relTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 2) return 'gerade eben'
  if (m < 60) return `vor ${m} Min`
  const h = Math.floor(m / 60)
  if (h < 24) return `vor ${h} Std`
  const d = Math.floor(h / 24)
  return `vor ${d} Tag${d === 1 ? '' : 'en'}`
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ jobTitle }: { jobTitle: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-8 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#EEF2FB] text-brand">
        <MapPin size={26} />
      </span>
      <p className="text-[14px] font-bold text-ink">Noch keine Pins</p>
      <p className="max-w-[260px] text-[12.5px] text-ink-sub">
        Alle Pins zu {jobTitle} erscheinen hier, nach Autor gruppiert.
      </p>
    </div>
  )
}

// ─── Review detail sheet (Mockup 26 State B) ─────────────────────────────────

interface ReviewDetailSheetProps {
  pins: GroupedAnnotation[]
  startIndex: number
  labelOf: (nodeId: string) => string
  busy: boolean
  onReview: (nodeId: string, status: 'trusted' | 'flagged') => Promise<boolean>
  onRetract: (nodeId: string) => Promise<boolean>
  onClose: () => void
}

function ReviewDetailSheet({
  pins,
  startIndex,
  labelOf,
  busy,
  onReview,
  onRetract,
  onClose,
}: ReviewDetailSheetProps) {
  const [idx, setIdx] = useState(startIndex)
  const [error, setError] = useState<string | null>(null)
  const haptics = useHaptics()

  const pin = pins[idx]
  if (!pin) return null

  const { entry, kind, severity, reviewState } = pin
  const total = pins.length
  const isLast = idx === total - 1

  async function applyReview(status: 'trusted' | 'flagged') {
    setError(null)
    const ok = await onReview(entry.baseNodeId, status)
    if (!ok) {
      // Write did not persist — stay on this pin. Advancing would mark it
      // "done" in the flow without a row in spatial_pin_reviews.
      haptics.trigger('error')
      setError('Konnte nicht gespeichert werden. Bitte erneut versuchen.')
      return
    }
    haptics.trigger(status === 'trusted' ? 'success' : 'warning')
    if (!isLast) setIdx(idx + 1)
    else onClose()
  }

  async function applyRetract() {
    setError(null)
    const ok = await onRetract(entry.baseNodeId)
    if (!ok) {
      haptics.trigger('error')
      setError('Review konnte nicht zurückgenommen werden.')
      return
    }
    haptics.trigger('light')
  }

  return (
    <>
      {/* Progress bar */}
      <div className="flex items-center gap-2 px-1 py-1">
        <div className="flex flex-1 gap-1">
          {pins.map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full ${
                i < idx ? 'bg-ok' : i === idx ? 'bg-brand' : 'bg-border-edge'
              }`}
            />
          ))}
        </div>
        <span className="whitespace-nowrap text-[11px] font-bold text-ink-sub">
          Pin {idx + 1} von {total}
        </span>
      </div>

      {/* Type chip + location */}
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-[#E5EDFB] px-3 py-1 text-[11px] font-bold text-brand">
          <KindIcon kind={kind} />
          {kindLabel(kind)}
        </span>
        <span className="text-[12.5px] font-[650] text-ink-sub">
          {labelOf(entry.baseNodeId)}
        </span>
        {reviewState !== 'pending' && <ReviewStatusPill state={reviewState} />}
      </div>

      {/* Override fields */}
      {Object.keys(entry.overrideFields).length > 0 && (
        <div className="mt-3 rounded-card border border-edge bg-canvas px-3 py-2">
          {Object.entries(entry.overrideFields).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="text-[11px] uppercase tracking-wide text-ink-muted">{k}</span>
              <span className="text-[12.5px] font-[650] text-ink">{String(v)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Severity meta */}
      {severity !== 'none' && (
        <div className="mt-2 text-[12px] text-ink-sub">
          <SeverityWord severity={severity} />
        </div>
      )}
      <p className="mt-1 text-[11px] text-ink-muted">{relTime(entry.createdAt)}</p>

      {/* Action buttons */}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void applyReview('flagged')}
          className="flex flex-1 items-center justify-center gap-1 rounded-[12px] border border-[#F3C9C9] bg-surface px-3 py-3 text-[12.5px] font-bold text-danger disabled:opacity-50"
        >
          <X size={14} />
          Ablehnen
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void applyReview('trusted')}
          className="flex flex-[1.5] items-center justify-center gap-1 rounded-[12px] bg-brand px-3 py-3 text-[12.5px] font-bold text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.5)] disabled:opacity-50"
        >
          Übernehmen
          <Check size={14} />
          {isLast ? '' : <ChevronRight size={12} />}
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-card border border-[#F3C9C9] bg-[#FDF2F2] px-3 py-2 text-center text-[11.5px] font-[600] text-danger">
          {error}
        </p>
      )}

      {/* Retract — only when this pin already carries a review */}
      {reviewState !== 'pending' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void applyRetract()}
          className="mt-2 w-full text-center text-[11.5px] font-[600] text-ink-muted disabled:opacity-50"
        >
          Review zurücknehmen
        </button>
      )}

      {!isLast && (
        <p className="mt-2 text-center text-[11px] text-ink-muted">
          Nächster Pin nach Aktion
        </p>
      )}
    </>
  )
}

// ─── Group overview sheet (Mockup 26 State A) ─────────────────────────────────

interface GroupOverviewSheetProps {
  group: AnnotationAuthorGroup
  labelOf: (nodeId: string) => string
  busy: boolean
  onOpenDetail: (startIndex: number) => void
  onTrustAll: (nodeIds: string[]) => void
}

function GroupOverviewSheet({
  group,
  labelOf,
  busy,
  onOpenDetail,
  onTrustAll,
}: GroupOverviewSheetProps) {
  const haptics = useHaptics()
  const [confirmTrustAll, setConfirmTrustAll] = useState(false)

  const pendingPins = group.pins.filter((p) => p.reviewState === 'pending')

  function handleTrustAll() {
    if (!confirmTrustAll) {
      haptics.trigger('medium')
      setConfirmTrustAll(true)
      return
    }
    // Confirmed — bulk-trust every still-pending pin.
    haptics.trigger('heavy')
    onTrustAll(pendingPins.map((p) => p.entry.baseNodeId))
  }

  return (
    <>
      {/* Worker context row */}
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-[#047857] text-[12px] font-[750] text-white">
          {group.displayName.charAt(0).toUpperCase()}
        </span>
        <span className="text-[12px] text-ink-sub">
          <span className="font-bold text-ink">{group.displayName}</span>
          {' · '}
          {group.reviewState.total - group.reviewState.pending} von{' '}
          {group.reviewState.total} geprüft
        </span>
      </div>

      {/* Pin list */}
      <div className="flex-1 overflow-y-auto">
        {group.pins.map((pin, idx) => {
          const { entry, kind, severity, reviewState } = pin
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                haptics.trigger('light')
                onOpenDetail(idx)
              }}
              className="flex w-full items-center gap-3 border-b border-edge-soft px-1 py-3 last:border-b-0 active:bg-canvas"
            >
              <KindIcon kind={kind} />
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-[13px] font-[650] text-ink">
                  {kindLabel(kind)} · {labelOf(entry.baseNodeId)}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  <SeverityWord severity={severity} />
                  {severity !== 'none' ? ' · ' : ''}
                  {relTime(entry.createdAt)}
                </p>
              </div>
              {reviewState !== 'pending' ? (
                <ReviewStatusPill state={reviewState} />
              ) : (
                <ChevronRight size={16} className="flex-shrink-0 text-ink-muted" />
              )}
            </button>
          )
        })}
      </div>

      {/* Footer actions */}
      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          disabled={busy || pendingPins.length === 0}
          onClick={() => {
            haptics.trigger('medium')
            onOpenDetail(group.pins.indexOf(pendingPins[0] ?? group.pins[0]))
          }}
          className="flex w-full items-center justify-center gap-2 rounded-[13px] bg-brand py-4 text-[14.5px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)] disabled:opacity-50"
        >
          {pendingPins.length === 0 ? 'Alle Pins geprüft' : 'Der Reihe nach prüfen'}
          {pendingPins.length > 0 && <ChevronRight size={15} />}
        </button>
        {pendingPins.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={handleTrustAll}
            className={`w-full rounded-[10px] py-2 text-center text-[11.5px] font-[700] disabled:opacity-50 ${
              confirmTrustAll
                ? 'bg-[#FEF3C7] text-warn'
                : 'bg-transparent text-ink-muted'
            }`}
          >
            {confirmTrustAll
              ? `Sicher? ${pendingPins.length} Pins ungeprüft übernehmen`
              : `Allen vertrauen — ${pendingPins.length} übernehmen`}
          </button>
        )}
      </div>
    </>
  )
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

/**
 * Edit-history fetch bound. The repository's Supabase impl defaults to 100 rows
 * — too low here: the annotation list (and its author groups + counts) is built
 * from the FULL history, so a busy scene would silently drop pins older than
 * its 100 newest edits. Big enough to cover any realistic single-scene history.
 */
const EDIT_HISTORY_FULL_LIMIT = 2000

export default function JobSpatialPinsTab({ job, scene, roomScene }: JobSpatialTabProps) {
  const [entries, setEntries] = useState<SpatialEditHistoryEntry[]>([])
  const [filter, setFilter] = useState<AnnotationFilter>('all')
  const [activeGroup, setActiveGroup] = useState<AnnotationAuthorGroup | null>(null)
  const [detailStartIndex, setDetailStartIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const haptics = useHaptics()
  const session = useSession()
  const { role } = useSpatialProviderRole()

  const reviewerRole: 'owner' | 'worker' | null =
    role === 'owner' ? 'owner' : role === 'worker' ? 'worker' : null

  const pinReviews = usePinReviews(
    scene.id,
    scene.providerOrgId,
    session.user?.id ?? null,
    reviewerRole,
  )

  // C-9: push deep-link (?pin= / ?author=) → scroll to + highlight the target.
  const [searchParams] = useSearchParams()
  const focusPin = searchParams.get('pin')
  const focusAuthor = searchParams.get('author')
  const focusRef = useRef<HTMLDivElement | null>(null)
  const focusDoneRef = useRef(false)
  const [focusActive, setFocusActive] = useState(true)

  // Load edit history on mount.
  useEffect(() => {
    let cancelled = false
    getSpatialSceneRepository()
      .listEditHistory(scene.id, EDIT_HISTORY_FULL_LIMIT)
      .then((rows) => {
        if (cancelled) return
        setEntries(rows)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scene.id])

  const labelOf = useCallback(
    (nodeId: string) => nodeLabelOf(roomScene, nodeId),
    [roomScene],
  )

  const authorInfo = useMemo(
    () => buildAuthorInfo(entries, scene, job),
    [entries, scene, job],
  )

  const filtered = useMemo(
    () => filterAnnotations(entries, filter, pinReviews.states),
    [entries, filter, pinReviews.states],
  )
  const groups = useMemo(
    () => groupAnnotationsByAuthor(filtered, { authorInfo, reviewStates: pinReviews.states }),
    [filtered, authorInfo, pinReviews.states],
  )

  // C-9: once the list is loaded, scroll the deep-linked target into view.
  useEffect(() => {
    if (focusDoneRef.current || loading) return
    if (!focusPin && !focusAuthor) return
    const el = focusRef.current
    if (!el) return
    focusDoneRef.current = true
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setFocusActive(false), 3500)
    return () => clearTimeout(timer)
  }, [loading, focusPin, focusAuthor, groups])

  const allCount = entries.length
  const pendingCount = useMemo(
    () =>
      entries.filter(
        (e) => (pinReviews.states.get(e.baseNodeId) ?? 'pending') === 'pending',
      ).length,
    [entries, pinReviews.states],
  )
  const issueCount = useMemo(
    () => entries.filter((e) => deriveAnnotationKind(e) === 'issue').length,
    [entries],
  )

  // Keep the open sheet's group in sync with fresh review states.
  const liveActiveGroup = useMemo(() => {
    if (!activeGroup) return null
    return groups.find((g) => g.actorId === activeGroup.actorId) ?? activeGroup
  }, [activeGroup, groups])

  const handleReview = useCallback(
    (nodeId: string, status: 'trusted' | 'flagged') => pinReviews.review(nodeId, status),
    [pinReviews],
  )

  const handleTrustAll = useCallback(
    async (nodeIds: string[]) => {
      const ok = await pinReviews.reviewMany(nodeIds, 'trusted')
      // reviewMany always reloads, so a partial failure leaves the pins that
      // did NOT persist visibly pending in the group sheet — the error haptic
      // flags that the bulk action did not fully land.
      if (!ok) haptics.trigger('error')
    },
    [pinReviews, haptics],
  )

  const closeSheet = useCallback(() => {
    setActiveGroup(null)
    setDetailStartIndex(null)
  }, [])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner size="md" tone="brand" />
      </div>
    )
  }

  if (entries.length === 0) {
    return <EmptyState jobTitle={job.title} />
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Filter chips */}
      <div className="flex flex-shrink-0 gap-2 border-b border-edge-soft bg-surface px-3.5 py-2.5">
        {(
          [
            { key: 'all', label: 'Alle', count: allCount },
            { key: 'pending', label: 'Ungeprüft', count: pendingCount },
            { key: 'issues', label: 'Probleme', count: issueCount },
          ] as Array<{ key: AnnotationFilter; label: string; count: number }>
        ).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              haptics.trigger('selection')
              setFilter(key)
            }}
            className={`rounded-full border px-3 py-1 text-[11.5px] font-[600] ${
              filter === key
                ? 'border-ink bg-ink text-white'
                : 'border-edge bg-surface text-ink-sub'
            }`}
          >
            {label}
            <span className="ml-0.5 opacity-60"> {count}</span>
          </button>
        ))}
      </div>

      {/* Group list */}
      <div className="flex-1 overflow-y-auto pb-4">
        {groups.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <p className="text-[13px] text-ink-muted">Keine Pins für diesen Filter</p>
          </div>
        ) : (
          groups.map((group) => {
            const reviewed = group.reviewState.total - group.reviewState.pending
            const groupFocused =
              focusActive && !focusPin && focusAuthor !== null && group.actorId === focusAuthor
            return (
              <div
                key={group.actorId ?? '__null__'}
                ref={
                  !focusPin && focusAuthor !== null && group.actorId === focusAuthor
                    ? focusRef
                    : undefined
                }
                className={`mx-3.5 mt-3.5 rounded-[14px] transition ${
                  groupFocused ? 'ring-2 ring-brand ring-offset-2' : ''
                }`}
              >
                {group.isActionable ? (
                  /* Worker group — actionable, foreman CTA in header */
                  <div className="mb-2 flex items-center gap-2.5 px-1">
                    <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-[#047857] text-[14px] font-[750] text-white">
                      {group.displayName.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-[750] text-ink">{group.displayName}</p>
                      <p
                        className={`text-[11px] font-[650] ${
                          group.reviewState.pending > 0 ? 'text-warn' : 'text-ok'
                        }`}
                      >
                        {reviewed} von {group.reviewState.total} geprüft
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        haptics.trigger('medium')
                        setActiveGroup(group)
                        setDetailStartIndex(null)
                      }}
                      className="flex flex-shrink-0 items-center gap-1 rounded-[9px] bg-brand px-3 py-2 text-[11.5px] font-bold text-white shadow-[0_4px_11px_-5px_rgba(37,99,235,0.6)]"
                    >
                      {group.reviewState.pending > 0 ? 'Alle prüfen' : 'Ansehen'}
                      <ChevronRight size={11} />
                    </button>
                  </div>
                ) : (
                  /* Customer / unknown group — read-only */
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-ink-sub">
                      {group.displayName}
                    </span>
                    <span className="rounded-full bg-[#ECEFF4] px-2 py-0.5 text-[10.5px] font-bold text-ink-muted">
                      {group.pins.length}
                    </span>
                  </div>
                )}

                {/* Pin card */}
                <div className="overflow-hidden rounded-card border border-edge bg-surface shadow-subtle">
                  {group.pins.map((pin) => {
                    const { entry, kind, severity, reviewState } = pin
                    const pinFocused =
                      focusActive && focusPin !== null && entry.baseNodeId === focusPin
                    return (
                      <div
                        key={entry.id}
                        ref={
                          focusPin !== null && entry.baseNodeId === focusPin
                            ? focusRef
                            : undefined
                        }
                        className={`flex items-center gap-3 border-b border-[#ECEFF4] px-3 py-3 last:border-b-0 ${
                          pinFocused ? 'bg-[#EEF2FB] ring-2 ring-inset ring-brand' : ''
                        }`}
                      >
                        <KindIcon kind={kind} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-[650] text-ink">
                            {kindLabel(kind)} — {labelOf(entry.baseNodeId)}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                            {severity !== 'none' && (
                              <>
                                <SeverityWord severity={severity} />
                                {' · '}
                              </>
                            )}
                            {relTime(entry.createdAt)}
                            {reviewState !== 'pending' && <ReviewStatusPill state={reviewState} />}
                          </p>
                        </div>
                        {group.isActionable ? (
                          <button
                            type="button"
                            onClick={() => {
                              haptics.trigger('light')
                              // Consolidated: open the FULL group at this pin's
                              // index — never a sliced pin list (honest progress).
                              setActiveGroup(group)
                              setDetailStartIndex(group.pins.indexOf(pin))
                            }}
                            className="flex-shrink-0 rounded-[8px] bg-[#EEF2FB] px-3 py-1.5 text-[11.5px] font-bold text-brand"
                          >
                            {reviewState === 'pending' ? 'Prüfen' : 'Ansehen'}
                          </button>
                        ) : (
                          <ChevronRight size={16} className="flex-shrink-0 text-ink-muted" />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Group overview + detail sheet (Mockup 26) */}
      <BottomSheet
        open={activeGroup !== null}
        onClose={closeSheet}
        title="Worker-Pins prüfen"
        maxWidth={480}
      >
        {liveActiveGroup &&
          (detailStartIndex !== null ? (
            <>
              <button
                type="button"
                onClick={() => setDetailStartIndex(null)}
                className="mb-2 flex items-center gap-1 text-[13px] font-[650] text-ink-sub"
              >
                <ChevronRight size={14} className="rotate-180" />
                Übersicht
              </button>
              <ReviewDetailSheet
                pins={liveActiveGroup.pins}
                startIndex={Math.min(detailStartIndex, liveActiveGroup.pins.length - 1)}
                labelOf={labelOf}
                busy={pinReviews.busy}
                onReview={handleReview}
                onRetract={pinReviews.retract}
                onClose={closeSheet}
              />
            </>
          ) : (
            <GroupOverviewSheet
              group={liveActiveGroup}
              labelOf={labelOf}
              busy={pinReviews.busy}
              onOpenDetail={(startIndex) => setDetailStartIndex(startIndex)}
              onTrustAll={handleTrustAll}
            />
          ))}
      </BottomSheet>
    </div>
  )
}
