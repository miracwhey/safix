/**
 * Spatial · Edit · EditHistoryTimeline (Phase 2 · Block 2.14)
 *
 * The History-Timeline panel: the persistent `spatial_edit_history` audit
 * trail of one canonical scene, rendered chronologically (newest first).
 *
 * Each row shows:
 *   - the German semantic label ("Material geändert", "Wand angepasst", …)
 *     derived from the row's `semantic_op`,
 *   - the actor (the editing user) and a relative timestamp,
 *   - a "Wiederherstellen" action — the persistent reverter (Block 2.15),
 *     enabled only when the current user may write the row's variant.
 *
 * ── Data flow (binding · layer-clean) ───────────────────────────────────────
 *   - The component reads history through the {@link SpatialEditHistoryRepository}
 *     (swappable InMemory ↔ Supabase) — never directly from the zustand store
 *     or Supabase. The repository is the persistence seam.
 *   - The reverter is the workflow helper {@link revertEditHistoryEntry}; the
 *     timeline only triggers it and re-loads on success. RBAC + constraint
 *     gating live in that workflow helper, not here.
 *
 * Apple Liquid-Glass styling, consistent with `VariantSwitcher` /
 * `MaterialPickerSheet` — a floating frosted panel.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { formatRelativeTime } from '../../../lib/shared/formatters'
import {
  editHistoryCommandLabel,
  historyRowLabel,
} from '../../../lib/spatial/canonical/types/editOperationLabels'
import {
  getSpatialEditHistoryRepository,
  type EditHistoryRowEntry,
  type SpatialEditHistoryRepository,
} from '../../../lib/spatial/canonical/repository/editHistoryRepository'
import { revertEditHistoryEntry } from '../../../lib/spatial/canonical/workflow/revertEditHistoryEntry'
import { useSpatialEditPermissions } from '../../../lib/spatial/hooks/useSpatialEditPermissions'
import { useCanonicalSceneStore } from '../../../lib/spatial/canonical/store/sceneStore'
import {
  canWriteVariant,
  toSpatialEditUser,
} from '../../../lib/spatial/workflow/spatialEditPermissions'
import type { VariantId } from '../../../lib/spatial/canonical/types/variants'
import { useToast } from '../../../hooks/useToast'

export interface EditHistoryTimelineProps {
  /** The canonical scene whose history is shown (`spatial_scenes.id`). */
  sceneId: string | null
  /**
   * Bump this to force a reload — the host increments it after every
   * `persistEditCommand` so a freshly-applied edit appears without a remount.
   */
  refreshKey?: number
  /** Repository override — tests inject an InMemory instance. */
  repository?: SpatialEditHistoryRepository
  /** Outer positioning classes. */
  className?: string
}

const PANEL_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.82)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 1px 0 rgba(255,255,255,0.6) inset, 0 16px 50px rgba(15,23,42,0.18)',
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: EditHistoryRowEntry[] }

export function EditHistoryTimeline({
  sceneId,
  refreshKey = 0,
  repository,
  className,
}: EditHistoryTimelineProps): ReactElement {
  const toast = useToast()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [reverting, setReverting] = useState<string | null>(null)
  const [localRefresh, setLocalRefresh] = useState(0)

  const { writableVariantId } = useSpatialEditPermissions()
  const variants = useCanonicalSceneStore((s) => s.variants)

  // ── Load history through the repository ──────────────────────────────────
  useEffect(() => {
    if (!sceneId) {
      setLoad({ status: 'ready', entries: [] })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    const repo = repository ?? getSpatialEditHistoryRepository()
    repo
      .list(sceneId)
      .then((entries) => {
        if (!cancelled) setLoad({ status: 'ready', entries })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: err instanceof Error ? err.message : 'Verlauf konnte nicht geladen werden.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [sceneId, refreshKey, localRefresh, repository])

  // ── Revert one entry (Block 2.15) ────────────────────────────────────────
  const handleRevert = useCallback(
    async (entry: EditHistoryRowEntry) => {
      if (load.status !== 'ready' || reverting) return
      setReverting(entry.id)
      try {
        const result = await revertEditHistoryEntry({
          entry,
          history: load.entries,
          user: toSpatialEditUser(),
          scene: { variantIds: variants.map((v) => v.id) },
          repository,
        })
        if (result.reverted) {
          toast.success(
            result.persisted
              ? 'Stand wiederhergestellt.'
              : 'Stand wiederhergestellt — Verlauf konnte nicht gesichert werden.',
          )
          // Reload so the new restore row appears at the top.
          setLocalRefresh((n) => n + 1)
        } else if (result.reason === 'no-op') {
          toast.info('Dieser Stand ist bereits aktiv.')
        } else {
          toast.error(result.message)
        }
      } finally {
        setReverting(null)
      }
    },
    [load, reverting, variants, repository, toast],
  )

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section
      className={[
        'flex max-h-[60dvh] w-full max-w-[380px] flex-col rounded-[22px] px-3.5 pb-3 pt-3',
        className ?? '',
      ].join(' ')}
      style={PANEL_GLASS}
      aria-label="Bearbeitungs-Verlauf"
    >
      <header className="flex items-baseline justify-between px-1 pb-2">
        <h2 className="text-[15px] font-bold text-slate-900">Verlauf</h2>
        <span className="text-[11px] font-medium text-slate-500">
          {load.status === 'ready' ? `${load.entries.length} Änderungen` : ''}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {load.status === 'loading' && (
          <p className="px-3 py-8 text-center text-[13px] text-slate-500">Verlauf wird geladen …</p>
        )}

        {load.status === 'error' && (
          <div className="rounded-2xl bg-white/70 px-4 py-6 text-center ring-1 ring-inset ring-rose-500/20">
            <p className="text-[13px] font-medium text-rose-600">{load.message}</p>
            <button
              type="button"
              onClick={() => setLocalRefresh((n) => n + 1)}
              className="mt-2 rounded-full bg-slate-900/5 px-3 py-1 text-[12px] font-semibold text-slate-700 transition active:scale-95"
            >
              Erneut versuchen
            </button>
          </div>
        )}

        {load.status === 'ready' && load.entries.length === 0 && (
          <p className="rounded-2xl bg-white/70 px-4 py-8 text-center text-[13px] text-slate-500 ring-1 ring-inset ring-slate-900/10">
            Noch keine Änderungen an diesem Aufmaß.
          </p>
        )}

        {load.status === 'ready' && load.entries.length > 0 && (
          <ol className="overflow-hidden rounded-2xl bg-white/70 ring-1 ring-inset ring-slate-900/10">
            {load.entries.map((entry, index) => (
              <TimelineRow
                key={entry.id}
                entry={entry}
                firstInGroup={index === 0}
                canRevert={canWriteVariant(
                  toSpatialEditUser(),
                  { variantIds: variants.map((v) => v.id) },
                  entry.variant_id as VariantId,
                )}
                reverting={reverting === entry.id}
                anyReverting={reverting !== null}
                onRevert={handleRevert}
              />
            ))}
          </ol>
        )}
      </div>

      <p className="px-1 pt-2 text-[10.5px] leading-snug text-slate-400">
        {writableVariantId
          ? 'Wiederherstellen setzt eine Änderung auf den vorherigen Stand zurück.'
          : 'Nur-Lese-Ansicht — du kannst Änderungen nicht wiederherstellen.'}
      </p>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline row
// ─────────────────────────────────────────────────────────────────────────────

function TimelineRow({
  entry,
  firstInGroup,
  canRevert,
  reverting,
  anyReverting,
  onRevert,
}: {
  entry: EditHistoryRowEntry
  firstInGroup: boolean
  canRevert: boolean
  reverting: boolean
  anyReverting: boolean
  onRevert: (entry: EditHistoryRowEntry) => void
}): ReactElement {
  const label = historyRowLabel(entry.semantic_op, entry.command)
  const isRestoreRow = entry.command === 'restore'
  const relTime = formatRelativeTime(Date.parse(entry.created_at))
  const actor = entry.user_id ? shortActor(entry.user_id) : 'System'

  return (
    <li
      className={[
        'flex items-center gap-3 px-3 py-2.5',
        !firstInGroup ? 'border-t border-slate-900/[0.07]' : '',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'flex size-[30px] shrink-0 items-center justify-center rounded-[10px] ring-1 ring-inset',
          isRestoreRow
            ? 'bg-amber-500/10 text-amber-600 ring-amber-500/20'
            : 'bg-blue-600/10 text-blue-600 ring-blue-600/20',
        ].join(' ')}
      >
        {isRestoreRow ? '↺' : '•'}
      </span>

      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13.5px] font-semibold text-slate-900">{label}</span>
        <span className="truncate text-[11px] font-medium text-slate-500">
          {actor} · {relTime} · {editHistoryCommandLabel(entry.command)}
        </span>
      </span>

      <button
        type="button"
        onClick={() => onRevert(entry)}
        disabled={!canRevert || anyReverting || isRestoreRow}
        aria-label={`„${label}“ wiederherstellen`}
        className={[
          'shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition active:scale-95',
          !canRevert || anyReverting || isRestoreRow
            ? 'cursor-not-allowed bg-slate-900/[0.04] text-slate-400'
            : 'bg-slate-900/[0.06] text-slate-700 hover:bg-slate-900/10',
        ].join(' ')}
      >
        {reverting ? '…' : 'Wiederherstellen'}
      </button>
    </li>
  )
}

/**
 * Compact actor label — a uuid is not human-friendly; show a short prefix so
 * the row stays readable. (V1: the timeline does not resolve a display name;
 * a Phase-3 enrichment could join `profiles`.)
 */
function shortActor(userId: string): string {
  return userId.length > 8 ? `Nutzer ${userId.slice(0, 6)}` : `Nutzer ${userId}`
}
