/**
 * JobSpatialCompareTab — Job-Spatial-Detail · Tab "Vergleich" (Mockup 23 · B-6 →
 * Phase C · C-5).
 *
 * Change-report list: Kunden-Aufmaß (Vorlage) → Dein Arbeitsstand.
 *
 * Phase C (C-5): "Übernehmen" is a REAL merge-write — it copies the customer's
 * node override into the provider's writable variant via `appendEditHistory`.
 * After the write the history reloads, the diff recomputes, and the row drops
 * out by itself (the node now matches in both variants) — so the Phase-B local
 * `takenIds` set is gone. Taking a measurement correction routes the provider
 * to the Stückliste to re-check (Mockup 23 CTA · loop closure). The compare is
 * provenance-aware: a node the provider deliberately deleted is not offered as
 * a takeable customer change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitCompareArrows, CheckCircle2 } from 'lucide-react'
import Spinner from '../../system/Spinner'
import type { JobSpatialTabProps } from './jobSpatialTabs'
import { getSpatialSceneRepository } from '../../../lib/spatial/canonical/repository/registry'
import {
  compareVariants,
  buildVariantOverrideMap,
} from '../../../lib/spatial/canonical/workflow/sceneCompareModel'
import type {
  SceneChange,
  SceneCompareResult,
} from '../../../lib/spatial/canonical/workflow/sceneCompareModel'
import type { SpatialEditHistoryEntry } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import { useSpatialEditPermissions } from '../../../lib/spatial/hooks/useSpatialEditPermissions'
import { useHaptics } from '../../../hooks/useHaptics'
import { useToast } from '../../../hooks/useToast'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CUSTOMER_VARIANT_IDS = new Set(['customer_corrections', 'customer_verify', 'base_roomplan'])

function isCustomerVariant(variantId: string): boolean {
  return CUSTOMER_VARIANT_IDS.has(variantId) || variantId.startsWith('customer_')
}

function kindLabel(kind: SceneChange['kind']): string {
  if (kind === 'measurement') return 'Maß'
  if (kind === 'layout') return 'Layout'
  if (kind === 'pin') return 'Pin'
  if (kind === 'material') return 'Material'
  return 'Änderung'
}

/** The customer edit-history entry per node — the latest one wins. */
function customerEntriesByNode(
  entries: SpatialEditHistoryEntry[],
): Map<string, SpatialEditHistoryEntry> {
  const byNode = new Map<string, SpatialEditHistoryEntry>()
  for (const e of entries) {
    if (!isCustomerVariant(e.variantId)) continue
    const cur = byNode.get(e.baseNodeId)
    if (!cur || Date.parse(e.createdAt) >= Date.parse(cur.createdAt)) {
      byNode.set(e.baseNodeId, e)
    }
  }
  return byNode
}

/** Node ids whose latest provider entry is a `delete` (provenance guard). */
function providerDeletedNodeIds(entries: SpatialEditHistoryEntry[]): Set<string> {
  const latest = new Map<string, { command: string; ts: number }>()
  for (const e of entries) {
    if (isCustomerVariant(e.variantId)) continue
    const ts = Date.parse(e.createdAt)
    const cur = latest.get(e.baseNodeId)
    if (!cur || ts >= cur.ts) latest.set(e.baseNodeId, { command: e.command, ts })
  }
  const deleted = new Set<string>()
  for (const [nodeId, { command }] of latest) {
    if (command === 'delete') deleted.add(nodeId)
  }
  return deleted
}

// ─── Origin badge ─────────────────────────────────────────────────────────────

function OriginBadge({ origin }: { origin: SceneChange['origin'] }) {
  if (origin === 'provider') {
    return (
      <span className="rounded-full bg-[#EEF2FB] px-2 py-0.5 text-[10px] font-bold text-brand-deep">
        von dir geändert
      </span>
    )
  }
  return (
    <span className="rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[10px] font-bold text-warn">
      neu von Kundin
    </span>
  )
}

// ─── Number badge ─────────────────────────────────────────────────────────────

function NumberBadge({ n, origin }: { n: number; origin: SceneChange['origin'] }) {
  const bg = origin === 'provider' ? 'bg-brand' : 'bg-[#F59E0B]'
  return (
    <span
      className={`flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-[750] text-white ${bg}`}
    >
      {n}
    </span>
  )
}

// ─── Change row ───────────────────────────────────────────────────────────────

function ChangeRow({
  change,
  index,
  onTake,
  canTake,
  busy,
}: {
  change: SceneChange
  index: number
  onTake: (change: SceneChange) => void
  canTake: boolean
  busy: boolean
}) {
  const haptics = useHaptics()

  function handleTake() {
    haptics.trigger('medium')
    onTake(change)
  }

  return (
    <div className="flex gap-3 border-b border-[#ECEFF4] px-4 py-3 last:border-b-0">
      <NumberBadge n={index} origin={change.origin} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-bold text-ink">{change.label}</span>
          <span className="flex-shrink-0 text-[10px] font-bold uppercase tracking-[0.3px] text-ink-muted">
            {kindLabel(change.kind)}
          </span>
        </div>
        {(change.fromValue ?? change.toValue) && (
          <p className="mt-0.5 text-[11.5px] text-ink-sub">
            {change.fromValue && <span>{change.fromValue}</span>}
            {change.fromValue && change.toValue && (
              <span className="mx-1 text-ink-muted">→</span>
            )}
            {change.toValue && <span className="font-[750]">{change.toValue}</span>}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <OriginBadge origin={change.origin} />
        </div>
      </div>
      {/* "Übernehmen" only for customer-origin rows (Mockup 23) — hidden when
          the caller has no writable variant (read-only role). */}
      {change.origin === 'customer' && canTake && (
        <div className="flex flex-shrink-0 items-center">
          <button
            type="button"
            onClick={handleTake}
            disabled={busy}
            className="rounded-[8px] bg-[#F59E0B] px-3 py-1.5 text-[11px] font-bold whitespace-nowrap text-white disabled:opacity-50"
          >
            Übernehmen
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Version selector ─────────────────────────────────────────────────────────

function VersionSelector() {
  return (
    <div className="flex items-stretch gap-2 px-4 py-3">
      {/* Reference pill — Kunden-Aufmaß. C-5: the chevron was a false tappable
          affordance (the pill is static) — removed. */}
      <div className="flex min-w-0 flex-1 flex-col rounded-[10px] border border-edge bg-surface px-3 py-2 shadow-subtle">
        <span className="text-[9px] font-bold uppercase tracking-[0.3px] text-ink-muted">
          Vorlage
        </span>
        <span className="mt-0.5 text-[12.5px] font-[750] text-ink">Kunden-Aufmaß</span>
      </div>

      {/* Arrow */}
      <svg
        className="flex-shrink-0 self-center text-ink-muted"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="M2 8h11M9 4l4 4-4 4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      {/* Working pill — Dein Arbeitsstand */}
      <div className="flex min-w-0 flex-1 flex-col rounded-[10px] bg-brand px-3 py-2">
        <span className="text-[9px] font-bold uppercase tracking-[0.3px] text-white/70">
          Deine Hauptversion
        </span>
        <span className="mt-0.5 text-[12.5px] font-[750] text-white">Dein Arbeitsstand</span>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyVariantState() {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[#EEF2FB] text-brand">
        <GitCompareArrows size={26} />
      </span>
      <p className="text-[14px] font-bold text-ink">Keine Unterschiede</p>
      <p className="max-w-[260px] text-[12.5px] text-ink-sub">
        Kunden-Aufmaß und Dein Arbeitsstand sind deckungsgleich — sobald die
        Kundin korrigiert, erscheint hier der Änderungs-Report.
      </p>
    </div>
  )
}

// ─── Main tab ─────────────────────────────────────────────────────────────────

export default function JobSpatialCompareTab({ scene, onSelectTab }: JobSpatialTabProps) {
  const [entries, setEntries] = useState<SpatialEditHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const haptics = useHaptics()
  const toast = useToast()
  const { writableVariantId } = useSpatialEditPermissions()

  useEffect(() => {
    let cancelled = false
    getSpatialSceneRepository()
      .listEditHistory(scene.id)
      .then((rows) => {
        if (cancelled) return
        setEntries(rows)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scene.id])

  const reloadEntries = useCallback(async () => {
    const rows = await getSpatialSceneRepository().listEditHistory(scene.id)
    setEntries(rows)
  }, [scene.id])

  const compareResult = useMemo<SceneCompareResult>(() => {
    const customerEntries = entries.filter((e) => isCustomerVariant(e.variantId))
    const providerEntries = entries.filter((e) => !isCustomerVariant(e.variantId))

    if (customerEntries.length === 0 || providerEntries.length === 0) {
      return { changes: [], providerCount: 0, customerCount: 0 }
    }

    const refMap = buildVariantOverrideMap(customerEntries)
    const workingMap = buildVariantOverrideMap(providerEntries)
    return compareVariants(refMap, workingMap, undefined, providerDeletedNodeIds(providerEntries))
  }, [entries])

  const pendingCustomerChanges = useMemo(
    () => compareResult.changes.filter((c) => c.origin === 'customer'),
    [compareResult],
  )

  // ── The take-write — copies a customer override into the writable variant ──

  const takeChanges = useCallback(
    async (changes: SceneChange[]) => {
      if (!writableVariantId) {
        toast.error('Du darfst dieses Aufmaß nicht bearbeiten.')
        return
      }
      if (busy || changes.length === 0) return
      setBusy(true)

      const repo = getSpatialSceneRepository()
      const customerByNode = customerEntriesByNode(entries)
      let anyMeasurement = false
      let failed = false

      for (const change of changes) {
        const source = customerByNode.get(change.nodeId)
        if (!source) continue
        try {
          await repo.appendEditHistory({
            sceneId: scene.id,
            variantId: writableVariantId,
            baseNodeId: change.nodeId,
            overrideFields: source.overrideFields,
            command: 'set',
          })
          if (change.kind === 'measurement') anyMeasurement = true
        } catch {
          failed = true
        }
      }

      try {
        await reloadEntries()
      } catch {
        failed = true
      }
      setBusy(false)

      if (failed) {
        toast.error('Einige Korrekturen konnten nicht übernommen werden.')
        return
      }
      haptics.trigger('success')
      toast.info(
        changes.length === 1
          ? 'Korrektur übernommen.'
          : `${changes.length} Korrekturen übernommen.`,
      )
      // Loop closure: a measurement correction shifts the BoM quantities —
      // route the provider to the Stückliste to re-check (Mockup 23 CTA).
      if (anyMeasurement) onSelectTab('bom')
    },
    [writableVariantId, busy, entries, scene.id, reloadEntries, haptics, toast, onSelectTab],
  )

  const handleTake = useCallback((change: SceneChange) => takeChanges([change]), [takeChanges])

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <VersionSelector />
        <div className="flex flex-1 items-center justify-center py-16">
          <Spinner size="md" tone="brand" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto pb-4">
        <VersionSelector />

        {compareResult.changes.length === 0 ? (
          <EmptyVariantState />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-baseline gap-2 px-4 pb-2 pt-1">
              <h3 className="text-[14px] font-[750] text-ink">
                {compareResult.changes.length} Unterschied
                {compareResult.changes.length === 1 ? '' : 'e'}
              </h3>
              {compareResult.customerCount > 0 && (
                <span className="text-[11.5px] font-[650] text-warn">
                  · {compareResult.customerCount} neu von Kundin
                </span>
              )}
            </div>

            {/* Change list */}
            <div className="border-y border-[#ECEFF4]">
              {compareResult.changes.map((change, i) => (
                <ChangeRow
                  key={change.id}
                  change={change}
                  index={i + 1}
                  onTake={handleTake}
                  canTake={writableVariantId !== null}
                  busy={busy}
                />
              ))}
            </div>

            {/* Quote-impact card — pending customer changes */}
            {pendingCustomerChanges.length > 0 && writableVariantId !== null && (
              <div className="mx-4 mt-4 rounded-card border border-[#F3D98E] bg-gradient-to-br from-[#FFF7E6] to-[#FEF3C7] p-3">
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#F59E0B] text-white">
                    <GitCompareArrows size={16} />
                  </span>
                  <div className="flex-1">
                    <p className="text-[13px] font-[750] text-[#92400E]">
                      Kundin hat nachträglich korrigiert
                    </p>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-[#B45309]">
                      {pendingCustomerChanges.length} Änderung
                      {pendingCustomerChanges.length === 1 ? '' : 'en'} noch nicht übernommen.
                      Übernimm sie in deinen Arbeitsstand.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    haptics.trigger('medium')
                    void takeChanges(pendingCustomerChanges)
                  }}
                  className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] bg-warn py-2.5 text-[12.5px] font-bold text-white disabled:opacity-50"
                >
                  <CheckCircle2 size={14} />
                  Alle Korrekturen übernehmen
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
