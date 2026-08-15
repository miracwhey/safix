/**
 * JobSpatialBomTab — Job-Spatial-Detail · Tab "Stückliste" (Mockup 21, B-5 →
 * Phase C · C-4).
 *
 * Phase C (C-4): the BoM is no longer manual-only. `source='auto'` items are
 * generated from the hydrated `roomScene` (`generateAutoItems`) and merged
 * into the list via `reconcileAutoItems` on every scene change — so a scene
 * reload / re-scan refreshes geometry WITHOUT wiping entered prices or manual
 * positions. The floor plan + numbered markers are data-driven
 * (`computeBomPlan`), replacing the hard-wired 4-marker placeholder. Manual
 * items carry no plan marker and are badged with a dot, not a number.
 *
 * VAT: hardcoded 19 % for V1 — `default_vat_rate` wiring is Block C-10.
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import { Plus, FileText, Trash2, CheckCircle2, Box } from 'lucide-react'
import { useHaptics } from '../../../hooks/useHaptics'
import type { JobSpatialTabProps } from './jobSpatialTabs'
import {
  computeBomTotals,
  addManualItem,
  updateItem,
  removeItem,
  reconcileAutoItems,
  effectiveQuantity,
  type BomItem,
  type BomUnit,
} from '../../../lib/spatial/canonical/workflow/bomModel'
import {
  generateAutoItems,
  computeBomPlan,
  computeFloorPerimeterForBom,
  type BomPlan,
} from '../../../lib/spatial/canonical/workflow/bomAutoItems'
import { getSpatialSceneRepository } from '../../../lib/spatial/canonical/repository/registry'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import QuoteSendConfirmationSheet from './QuoteSendConfirmationSheet'
import type {
  DeliveryChannels,
  QuoteDocumentType,
  QuoteSendResult,
} from './QuoteSendConfirmationSheet'
import { createOfferFromSpatialQuote } from '../../../lib/spatial/canonical/workflow/createOfferFromSpatialQuote'
import { buildAufmassSnapshot } from '../../../lib/spatial/canonical/workflow/buildAufmassSnapshot'
import { getOfferRepository, initializeOfferRepository } from '../../../lib/offers/repository/registry'
import { shareOrDownloadOfferPdf } from '../../../lib/offers/pdf/generateOfferPdf'
import { getThreadByLegacyConversationId } from '../../../lib/chat'
import SpatialOfferStatusCard from '../SpatialOfferStatusCard'
import SpatialNormHints, { type RoomGeometryInfo } from './SpatialNormHints'
import {
  evaluateSceneDin,
  dinWarningKey,
  dinWarningToBomDraft,
} from '../../../lib/spatial/canonical/validator/sceneDinSummary'
import type { DinWarning } from '../../../lib/spatial/canonical/validator/wallObjectDinValidator'

// ─── V1 constant — Phase-C: replace with provider.default_vat_rate ───────────
const VAT_RATE_PCT = 19

// ─── Types ────────────────────────────────────────────────────────────────────

const UNITS: { key: BomUnit; label: string }[] = [
  { key: 'm2', label: 'm²' },
  { key: 'pcs', label: 'Stk.' },
  { key: 'lfm', label: 'lfm' },
  { key: 'h', label: 'Std.' },
]

function unitLabel(unit: BomUnit): string {
  return UNITS.find((u) => u.key === unit)?.label ?? unit
}

function formatEur(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Parse a DE-locale price string like "40,00" → 4000 cents. Returns null if unparseable. */
function parseEurInput(raw: string): number | null {
  const normalised = raw.replace(',', '.')
  const n = parseFloat(normalised)
  if (Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

// ─── Add-item sheet ───────────────────────────────────────────────────────────

interface AddSheetProps {
  onAdd: (item: Omit<BomItem, 'position' | 'source'>) => void
  onClose: () => void
}

function AddItemSheet({ onAdd, onClose }: AddSheetProps) {
  const [description, setDescription] = useState('')
  const category = 'Sonstiges'
  const [quantity, setQuantity] = useState('1')
  const [unit, setUnit] = useState<BomUnit>('pcs')
  const [priceInput, setPriceInput] = useState('')

  const handleSave = useCallback(() => {
    const desc = description.trim()
    if (!desc) return
    const qty = parseFloat(quantity.replace(',', '.'))
    if (Number.isNaN(qty) || qty <= 0) return
    const cents = parseEurInput(priceInput) ?? 0
    const id = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    onAdd({ id, description: desc, category, quantity: qty, unit, unitPriceCents: cents })
    onClose()
  }, [description, quantity, unit, priceInput, onAdd, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="w-full rounded-t-[20px] bg-white px-5 pb-[max(28px,env(safe-area-inset-bottom))] pt-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="text-[15px] font-bold text-ink">Neue Position</span>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] font-semibold text-brand"
          >
            Abbrechen
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Bezeichnung
            </label>
            <input
              type="text"
              className="w-full rounded-[10px] border border-edge bg-canvas px-3 py-2.5 text-[14px] text-ink outline-none focus:border-brand"
              placeholder="z.B. Anfahrt"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Menge
              </label>
              <input
                type="text"
                inputMode="decimal"
                className="w-full rounded-[10px] border border-edge bg-canvas px-3 py-2.5 text-[14px] text-ink outline-none focus:border-brand"
                placeholder="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Einheit
              </label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as BomUnit)}
                className="w-full rounded-[10px] border border-edge bg-canvas px-3 py-2.5 text-[14px] text-ink outline-none focus:border-brand"
              >
                {UNITS.map((u) => (
                  <option key={u.key} value={u.key}>{u.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Preis pro Einheit (€)
            </label>
            <input
              type="text"
              inputMode="decimal"
              className="w-full rounded-[10px] border border-edge bg-canvas px-3 py-2.5 text-[14px] text-ink outline-none focus:border-brand"
              placeholder="0,00"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={!description.trim()}
          className="mt-4 w-full rounded-[13px] bg-brand py-3.5 text-[14px] font-bold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)] disabled:bg-[#C7D3F5] disabled:shadow-none"
        >
          Position hinzufügen
        </button>
      </div>
    </div>
  )
}

// ─── Price-entry inline row ───────────────────────────────────────────────────

interface PriceEntryProps {
  item: BomItem
  onChange: (id: string, cents: number) => void
}

function PriceEntryButton({ item, onChange }: PriceEntryProps) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const handleOpen = useCallback(() => {
    setRaw(item.unitPriceCents > 0 ? formatEur(item.unitPriceCents) : '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [item.unitPriceCents])

  const handleCommit = useCallback(() => {
    const cents = parseEurInput(raw)
    if (cents !== null) onChange(item.id, cents)
    setEditing(false)
  }, [raw, item.id, onChange])

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          className="w-[72px] rounded-[8px] border border-brand bg-[#EEF2FB] px-2 py-1 text-right text-[13px] font-bold text-ink outline-none"
          placeholder="0,00"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCommit() }}
        />
        <button
          type="button"
          onClick={handleCommit}
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand text-white"
        >
          <CheckCircle2 size={14} />
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="flex items-center gap-1 rounded-[9px] bg-brand px-2.5 py-1.5 text-[11.5px] font-bold text-white shadow-[0_4px_11px_-5px_rgba(37,99,235,0.6)]"
    >
      Preis eintragen
    </button>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function JobSpatialBomTab({ job, scene, roomScene, blobState }: JobSpatialTabProps) {
  const { trigger } = useHaptics()

  const [items, setItems] = useState<BomItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAddSheet, setShowAddSheet] = useState(false)
  const [quoteSheetOpen, setQuoteSheetOpen] = useState(false)
  // C-10: the "Angebot gesendet" state persists on the scene metadata so it
  // survives a reload and blocks a second send of the same quote.
  const [quoteSentAt, setQuoteSentAt] = useState<number | null>(() => {
    const v = scene.metadata?.quoteSentAt
    return typeof v === 'number' ? v : null
  })
  // C-10 · Hard-Review RED-fix: a local in-flight guard for handleQuoteSend.
  // The Sheet already guards via its own `phase === 'sending'` state, but if
  // the RPC + scene.metadata.update take >500ms and the user dismisses + re-
  // opens the sheet, a stale Sheet instance could fire a second send before
  // the optimistic quoteSentAt landed. The ref-based guard is cheap and
  // collapse-safe (no extra render).
  const sendInFlightRef = useRef(false)

  // Undo-toast state
  const [undoItem, setUndoItem] = useState<BomItem | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // PDF share/download in-flight guard (post-send action). The ref is the
  // synchronous double-tap guard (mirrors sendInFlightRef); pdfBusy only drives
  // the button's disabled/label render.
  const [pdfBusy, setPdfBusy] = useState(false)
  const pdfBusyRef = useRef(false)

  // ── Auto-item sync ─────────────────────────────────────────────────────────
  // When the hydrated scene changes, regenerate the auto items and reconcile
  // them into the list — `reconcileAutoItems` keeps entered prices + manual
  // positions. Render-phase sync (no effect) keeps it `set-state-in-effect`-safe.
  const [syncedScene, setSyncedScene] = useState<RoomScene | null>(null)
  if (roomScene !== syncedScene) {
    setSyncedScene(roomScene)
    if (roomScene) {
      setItems((prev) => reconcileAutoItems(prev, generateAutoItems(roomScene)))
    } else {
      setItems((prev) => prev.filter((i) => i.source === 'manual'))
    }
  }

  // Data-driven floor plan — replaces the hard-wired PLAN_MARKER_MAP.
  const plan: BomPlan | null = useMemo(
    () => (roomScene ? computeBomPlan(roomScene) : null),
    [roomScene],
  )

  // ── Norm hints + room data (Block 3) ─────────────────────────────────────────
  // DIN/VDE soft-warnings swept across the whole scene + the derived room
  // geometry — both read-only, both pure-L1 (no RLS / migration).
  const normWarnings = useMemo<DinWarning[]>(
    () => (roomScene ? evaluateSceneDin(roomScene) : []),
    [roomScene],
  )
  const roomInfo = useMemo<RoomGeometryInfo | null>(() => {
    if (!roomScene) return null
    const peri = computeFloorPerimeterForBom(roomScene.floor.polygon, roomScene.walls)
    return {
      areaM2: roomScene.computed_area_m2,
      volumeM3: roomScene.computed_volume_m3,
      ceilingHeightM: roomScene.ceiling.height_m,
      wallCount: roomScene.walls.length,
      exteriorWallCount: roomScene.walls.filter((w) => w.is_exterior_wall).length,
      perimeterM: peri.perimeterM,
    }
  }, [roomScene])
  // Derived (not mirror state): which DIN hints are already added as positions.
  // A delete / undo of the position automatically re-syncs the hint.
  const addedNormKeys = useMemo(
    () => new Set(items.map((i) => i.dinSourceKey).filter((k): k is string => k != null)),
    [items],
  )

  // Derived: totals + unprice count
  const totals = useMemo(() => computeBomTotals(items, VAT_RATE_PCT), [items])
  const unpricedCount = useMemo(
    () => items.filter((i) => i.unitPriceCents === 0).length,
    [items],
  )
  const allPriced = items.length > 0 && unpricedCount === 0

  const autoItems = useMemo(() => items.filter((i) => i.source === 'auto'), [items])
  const manualItems = useMemo(() => items.filter((i) => i.source === 'manual'), [items])

  // ── Selection ──────────────────────────────────────────────────────────────

  const handleSelectItem = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id))
    void trigger('selection')
  }, [trigger])

  // ── Item operations ────────────────────────────────────────────────────────

  const handleAdd = useCallback((partial: Omit<BomItem, 'position' | 'source'>) => {
    setItems((prev) => addManualItem(prev, partial))
    void trigger('light')
  }, [trigger])

  // Block 3 — turn a DIN warning into a billable manual position (unpriced).
  // Tracks the warning key so the hint flips to "übernommen" and a double-tap
  // does not add a duplicate.
  const handleAddNormPosition = useCallback((w: DinWarning) => {
    const draft = dinWarningToBomDraft(w)
    const id = `din-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    // Stamp the source warning key so "already added" derives from the item list.
    setItems((prev) => addManualItem(prev, { id, ...draft, dinSourceKey: dinWarningKey(w) }))
    void trigger('light')
  }, [trigger])

  const handlePriceChange = useCallback((id: string, cents: number) => {
    setItems((prev) => updateItem(prev, id, { unitPriceCents: cents }))
  }, [])

  // Manual override of a geometry-derived auto quantity. `null` clears the
  // override (back to the net geometry value). `reconcileAutoItems` keeps the
  // override across a re-scan, so a craftsman's correction survives.
  const handleQuantityChange = useCallback((id: string, qty: number | null) => {
    setItems((prev) => updateItem(prev, id, { quantityOverride: qty ?? undefined }))
    void trigger('light')
  }, [trigger])

  const handleDelete = useCallback((id: string) => {
    const target = items.find((i) => i.id === id)
    if (!target) return
    setItems((prev) => removeItem(prev, id))
    setSelectedId(null)
    setUndoItem(target)
    void trigger('medium')
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setUndoItem(null), 4000)
  }, [items, trigger])

  const handleUndo = useCallback(() => {
    if (!undoItem) return
    setItems((prev) => {
      const next = [...prev, undoItem]
      next.sort((a, b) => a.position - b.position)
      return next
    })
    setUndoItem(null)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    void trigger('light')
  }, [undoItem, trigger])

  // ── Quote send ─────────────────────────────────────────────────────────────

  const quoteTotals = useMemo(() => ({
    netCents: totals.netCents,
    vatCents: totals.vatCents,
    totalCents: totals.grossCents,
    itemCount: items.length,
    sceneItemCount: autoItems.length,
  }), [totals, items.length, autoItems.length])

  const handleQuoteSend = useCallback(
    async (
      channels: DeliveryChannels,
      documentType: QuoteDocumentType,
    ): Promise<QuoteSendResult> => {
      // Pre-flight: Spatial-Quote requires a job-anchored scene. Without
      // sourceJobId the C-10 RPC rejects (scene_missing_job) — surface
      // upfront so the Provider gets a clean error instead of an RPC trace.
      if (!scene.sourceJobId) {
        return {
          ok: false,
          error:
            'Diese Szene ist keinem Auftrag zugeordnet — bitte zuerst einen Auftrag verknüpfen.',
        }
      }
      // Hard-Review RED-fix: in-flight guard. A second call while the first
      // is still resolving returns a benign idempotent result rather than
      // racing the RPC + scene.metadata.update.
      if (sendInFlightRef.current) {
        return { ok: true }
      }
      sendInFlightRef.current = true
      try {
        // 1. Create the canonical Offer via the C-10 workflow. This calls
        //    `create_spatial_offer` RPC server-side: RBAC + Pro-Gate +
        //    idempotency are enforced there.
        const result = await createOfferFromSpatialQuote({
          sceneId: scene.id,
          documentType,
          totals,
          vatRatePct: VAT_RATE_PCT,
          lineItems: items,
          // Capture the floor-plan + measurements onto the offer so its PDF can
          // render the aufmaß without re-loading the scene. Only when hydrated.
          ...(roomScene && { aufmass: buildAufmassSnapshot(roomScene) }),
        })
        if (!result.ok) {
          return {
            ok: false,
            error: result.message,
          }
        }

        // 2. Persist sent-state + the canonical offer linkage on the scene
        //    metadata so the BoM tab + Hub see it after a reload, and so
        //    cross-domain UI (Customer Hub, SpatialDetail-View) can jump
        //    back to the offer record.
        const sentAt = Date.now()
        await getSpatialSceneRepository().update(scene.id, {
          metadata: {
            ...scene.metadata,
            quoteSentAt: sentAt,
            quoteSentChannels: {
              inApp: channels.inApp,
              email: channels.email,
              push: channels.push,
            },
            quoteTotalCents: totals.grossCents,
            canonicalOfferId: result.offer.id,
            quoteDocumentType: documentType,
          },
        })
        setQuoteSentAt(sentAt)
        void trigger('success')
        return { ok: true }
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : 'Angebot konnte nicht gesendet werden',
        }
      } finally {
        sendInFlightRef.current = false
      }
    },
    [scene.id, scene.sourceJobId, scene.metadata, totals, items, roomScene, trigger],
  )

  // ── PDF (with floor-plan + measurements) — post-send share/download ──────────
  // The enriched PDF is rendered from the offer's persisted `spatial_metadata.
  // aufmass`, so the canonical offer (resolved by scene) is the only input.
  const handleSharePdf = useCallback(async () => {
    if (pdfBusyRef.current) return
    pdfBusyRef.current = true
    setPdfBusy(true)
    try {
      const repo = getOfferRepository()
      let offer = repo.findBySpatialScene(scene.id)
      // Post-reload: the offers repo hydrates async. If the button was tapped
      // before the cache settled, wait for hydration before giving up so the
      // action never silently no-ops.
      if (!offer && !repo.isHydrated()) {
        await initializeOfferRepository()
        offer = repo.findBySpatialScene(scene.id)
      }
      if (!offer) return
      await shareOrDownloadOfferPdf(offer, {
        customerName: offer.conversationId
          ? getThreadByLegacyConversationId(offer.conversationId)?.displayMetadata
              ?.customerName
          : null,
      })
    } catch {
      // Share-cancel / filesystem errors are benign — nothing to roll back.
    } finally {
      pdfBusyRef.current = false
      setPdfBusy(false)
    }
  }, [scene.id])

  // ── Render ─────────────────────────────────────────────────────────────────

  const selectedItem = items.find((i) => i.id === selectedId)

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[#F4F5F8]">
      {/* ── Floor plan ──────────────────────────────────────────────────── */}
      <div className="relative h-[168px] flex-shrink-0 border-b border-edge bg-gradient-to-b from-[#F1F4F9] to-[#E6EBF2]">
        {plan ? (
          <div className="relative mx-auto h-full" style={{ aspectRatio: '1 / 1' }}>
            <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
              <defs>
                <linearGradient id="bom-floor-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#DCE7FB" />
                  <stop offset="1" stopColor="#CBDAF7" />
                </linearGradient>
              </defs>
              <polygon
                points={plan.floorPolygon.map((p) => `${p.xPct},${p.yPct}`).join(' ')}
                fill="url(#bom-floor-fill)"
                stroke="#2563EB"
                strokeWidth="1.1"
                strokeOpacity="0.5"
              />
              <polygon
                points={plan.floorPolygon.map((p) => `${p.xPct},${p.yPct}`).join(' ')}
                fill="none"
                stroke="#2563EB"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>

            {/* Numbered markers — one per auto item, placed at its node centroid */}
            {autoItems.map((item) => {
              const marker = plan.markers.find((m) => m.nodeId === item.nodeId)
              if (!marker) return null
              const isSelected = item.id === selectedId
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectItem(item.id)}
                  style={{ left: `${marker.xPct}%`, top: `${marker.yPct}%` }}
                  aria-label={`Position ${item.position} · ${item.description}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                >
                  <span
                    className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold text-white transition-all ${
                      isSelected
                        ? 'scale-125 bg-[#1D4ED8] ring-[3px] ring-[#2563EB]/35'
                        : 'bg-brand'
                    }`}
                    style={{ boxShadow: '0 0 0 2.5px #fff' }}
                  >
                    {item.position}
                  </span>
                </button>
              )
            })}

            <span className="absolute bottom-2 left-2 rounded-full bg-white/80 px-2.5 py-[3px] text-[10px] font-semibold text-ink-muted backdrop-blur">
              Grundriss · {job.title}
            </span>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-muted">
            <Box size={26} strokeWidth={1.5} />
            <span className="text-[11px] font-medium">
              {blobState === 'loading'
                ? 'Aufmaß wird geladen …'
                : blobState === 'error'
                  ? 'Aufmaß nicht verfügbar'
                  : 'Kein 3D-Aufmaß — Stückliste manuell'}
            </span>
          </div>
        )}
      </div>

      {/* ── Position list ────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge bg-white px-4 py-2.5">
          <span className="text-[12.5px] font-bold text-ink">
            {items.length} {items.length === 1 ? 'Position' : 'Positionen'}
          </span>
          {unpricedCount > 0 && (
            <span className="rounded-full bg-[#EEF2FB] px-2.5 py-[2px] text-[11.5px] font-bold text-brand">
              {unpricedCount} ohne Preis
            </span>
          )}
        </div>

        {/* C-10 · C10.6 — canonical-offer status banner (post-send) */}
        <div className="px-4 pt-3">
          <SpatialOfferStatusCard scene={scene} role="provider" />
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Block 3 — room data + DIN/VDE norm hints (read-only + 1-tap position) */}
          {roomInfo && (
            <SpatialNormHints
              info={roomInfo}
              warnings={normWarnings}
              addedKeys={addedNormKeys}
              onAddPosition={handleAddNormPosition}
            />
          )}
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-[#EEF2FB] text-brand">
                <FileText size={22} />
              </span>
              <p className="text-[13px] font-bold text-ink">Noch keine Positionen</p>
              <p className="max-w-[240px] text-[12px] text-ink-sub">
                {roomScene
                  ? 'Das Aufmaß enthält keine erkannten Flächen. Füge Positionen manuell hinzu.'
                  : 'Füge deine erste Position hinzu. Sobald ein 3D-Aufmaß vorliegt, werden Flächen automatisch ergänzt.'}
              </p>
            </div>
          ) : (
            <div className="bg-white">
              {autoItems.length > 0 && (
                <div className="px-4 pb-1.5 pt-2.5 text-[10.5px] font-bold uppercase tracking-[0.5px] text-ink-muted">
                  Vom Aufmaß erkannt
                </div>
              )}
              {autoItems.map((item) => (
                <BomRow
                  key={item.id}
                  item={item}
                  isSelected={item.id === selectedId}
                  onSelect={handleSelectItem}
                  onPriceChange={handlePriceChange}
                  onQuantityChange={handleQuantityChange}
                  onDelete={handleDelete}
                />
              ))}

              {manualItems.length > 0 && (
                <div className="px-4 pb-1.5 pt-2.5 text-[10.5px] font-bold uppercase tracking-[0.5px] text-ink-muted">
                  Selbst ergänzt · ohne Plan-Bezug
                </div>
              )}
              {manualItems.map((item) => (
                <BomRow
                  key={item.id}
                  item={item}
                  isSelected={item.id === selectedId}
                  onSelect={handleSelectItem}
                  onPriceChange={handlePriceChange}
                  onQuantityChange={handleQuantityChange}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          {/* Add position row */}
          <button
            type="button"
            onClick={() => setShowAddSheet(true)}
            className="flex w-full items-center gap-2 border-t border-edge bg-white px-4 py-3.5 text-[12.5px] font-semibold text-brand"
          >
            <Plus size={14} strokeWidth={2.5} />
            Eigene Position hinzufügen
          </button>
        </div>
      </div>

      {/* ── Summary + CTA ────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-t border-edge bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3">
        <div className="flex justify-between py-[1px] text-[12.5px] text-ink-sub">
          <span>Summe Netto</span>
          <span>{formatEur(totals.netCents)} €</span>
        </div>
        <div className="flex justify-between py-[1px] text-[12.5px] text-ink-sub">
          <span>MwSt {VAT_RATE_PCT} %</span>
          <span>{formatEur(totals.vatCents)} €</span>
        </div>
        <div className="mt-1.5 flex justify-between border-t border-edge pt-1.5 text-[17px] font-extrabold text-ink">
          <span>Gesamt</span>
          <span>{formatEur(totals.grossCents)} €</span>
        </div>

        {quoteSentAt !== null ? (
          <>
            <button
              type="button"
              onClick={() => setQuoteSheetOpen(true)}
              className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-[13px] bg-[#D1FAE5] py-3.5 text-[14.5px] font-bold text-ok transition"
            >
              <CheckCircle2 size={16} />
              Angebot gesendet · {new Date(quoteSentAt).toLocaleDateString('de-DE')}
            </button>
            <button
              type="button"
              onClick={handleSharePdf}
              disabled={pdfBusy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[13px] border border-edge bg-white py-3 text-[13.5px] font-bold text-brand disabled:opacity-60"
            >
              <FileText size={15} />
              {pdfBusy ? 'PDF wird erstellt …' : 'Angebot als PDF teilen'}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!allPriced}
            onClick={allPriced ? () => setQuoteSheetOpen(true) : undefined}
            className={`mt-2.5 flex w-full items-center justify-center gap-2 rounded-[13px] py-3.5 text-[14.5px] font-bold transition ${
              allPriced
                ? 'bg-brand text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)]'
                : 'border border-edge bg-[#F4F5F8] text-ink-muted shadow-none'
            }`}
          >
            <FileText size={16} />
            {allPriced
              ? 'Angebot generieren'
              : unpricedCount > 0
                ? `Erst ${unpricedCount} ${unpricedCount === 1 ? 'Preis' : 'Preise'} eintragen`
                : 'Positionen hinzufügen'}
          </button>
        )}
      </div>

      {/* ── Delete selected action bar (tab-local) ───────────────────────── */}
      {selectedItem !== undefined && undoItem === null && (
        <div className="absolute bottom-[170px] left-1/2 z-40 -translate-x-1/2">
          <button
            type="button"
            onClick={() => handleDelete(selectedItem.id)}
            className="flex items-center gap-2 rounded-full bg-[#1E293B] px-4 py-2 text-[12px] font-bold text-white shadow-[0_8px_24px_-6px_rgba(15,23,42,0.5)]"
          >
            <Trash2 size={13} />
            Position löschen
          </button>
        </div>
      )}

      {/* ── Undo toast (tab-local) ───────────────────────────────────────── */}
      {undoItem !== null && (
        <div className="absolute bottom-[170px] left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-full bg-[#1E293B] px-4 py-2.5 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.5)]">
            <span className="max-w-[180px] truncate text-[12px] text-white/80">
              „{undoItem.description}" gelöscht
            </span>
            <button
              type="button"
              onClick={handleUndo}
              className="text-[12px] font-bold text-brand"
            >
              Rückgängig
            </button>
          </div>
        </div>
      )}

      {/* ── Add item sheet ───────────────────────────────────────────────── */}
      {showAddSheet && (
        <AddItemSheet onAdd={handleAdd} onClose={() => setShowAddSheet(false)} />
      )}

      {/* ── Quote send confirmation sheet ────────────────────────────────── */}
      <QuoteSendConfirmationSheet
        open={quoteSheetOpen}
        onClose={() => setQuoteSheetOpen(false)}
        scene={scene}
        job={job}
        totals={quoteTotals}
        recipientName={job.customer}
        vatRatePct={VAT_RATE_PCT}
        quoteSentAt={quoteSentAt}
        onSend={handleQuoteSend}
      />
    </div>
  )
}

// ─── Quantity display + inline editor ────────────────────────────────────────

/** Quantity as a DE-locale display string (max 2 decimals, no money). */
function formatQty(n: number): string {
  return n.toLocaleString('de-DE', { maximumFractionDigits: 2 })
}

interface QtyEditorProps {
  item: BomItem
  onQuantityChange: (id: string, qty: number | null) => void
}

/**
 * Inline quantity editor for an auto-item. Commits a manual `quantityOverride`
 * on blur / Enter. Remounted (via `key`) when the override flips so the field
 * reflects the current effective quantity after a quick Brutto/Netto toggle.
 */
function BomQuantityEditor({ item, onQuantityChange }: QtyEditorProps) {
  const [raw, setRaw] = useState(() => String(effectiveQuantity(item)).replace('.', ','))
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = useCallback(() => {
    const n = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(n) || n < 0) {
      // Discard garbage / empty input — snap the field back to the real value
      // so the box never shows stale text the craftsman didn't commit.
      setRaw(String(effectiveQuantity(item)).replace('.', ','))
      return
    }
    // No-op when unchanged: a focus→blur (or re-typing the current value) must
    // NOT write a spurious override that would freeze the wall against a re-scan.
    if (n === effectiveQuantity(item)) return
    onQuantityChange(item.id, n)
  }, [raw, item, onQuantityChange])

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      aria-label="Menge anpassen"
      className="w-[84px] rounded-[8px] border border-edge bg-white px-2 py-1 text-right text-[13px] font-bold text-ink outline-none focus:border-brand"
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          inputRef.current?.blur()
        }
      }}
    />
  )
}

// ─── BomRow — module-level to satisfy react-hooks/static-components ───────────

interface BomRowProps {
  item: BomItem
  isSelected: boolean
  onSelect: (id: string) => void
  onPriceChange: (id: string, cents: number) => void
  onQuantityChange: (id: string, qty: number | null) => void
  onDelete: (id: string) => void
}

function BomRow({ item, isSelected, onSelect, onPriceChange, onQuantityChange }: BomRowProps) {
  const isPriced = item.unitPriceCents > 0
  const billedQty = effectiveQuantity(item)
  const lineTotal = Math.round(billedQty * item.unitPriceCents)
  const bd = item.areaBreakdown
  const isOverridden = item.quantityOverride != null
  // Auto items expand an inline quantity editor when selected — the place the
  // craftsman corrects the geometry-derived amount (e.g. gross for Übermessung).
  const showEditor = isSelected && item.source === 'auto'

  return (
    <div className={isSelected ? 'bg-[#EEF2FB]' : 'bg-white'}>
      <div
        className={`flex items-center gap-3 px-4 py-3 ${showEditor ? '' : 'border-b border-[#ECEFF4]'}`}
        onClick={() => onSelect(item.id)}
      >
        {/* Position badge — auto items: numbered blue badge matching the plan
            marker; manual items: a neutral dot (no plan reference · C-4). */}
        {item.source === 'auto' ? (
          <span
            className={`flex h-[25px] w-[25px] flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white ${
              isSelected ? 'bg-[#1D4ED8] ring-[3px] ring-[#2563EB]/20' : 'bg-brand'
            }`}
          >
            {item.position}
          </span>
        ) : (
          <span
            className={`flex h-[25px] w-[25px] flex-shrink-0 items-center justify-center rounded-full text-[15px] font-bold leading-none text-ink-muted ${
              isSelected ? 'bg-[#D8DCE6]' : 'bg-[#ECEFF4]'
            }`}
            aria-hidden="true"
          >
            ·
          </span>
        )}

        {/* Description + quantity */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-ink">{item.description}</p>
          <p className="mt-[1px] flex items-center gap-1.5 text-[11px] text-ink-muted">
            <b className="font-bold text-ink-sub">
              {formatQty(billedQty)} {unitLabel(item.unit)}
            </b>
            {isOverridden ? (
              <span className="rounded-full bg-[#FEF3C7] px-1.5 py-px text-[9.5px] font-bold text-[#B45309]">
                angepasst
              </span>
            ) : bd && bd.openingsM2 > 0 ? (
              <span className="rounded-full bg-[#EEF2FB] px-1.5 py-px text-[9.5px] font-bold text-brand">
                Netto
              </span>
            ) : item.source === 'auto' ? (
              <span className="text-ink-muted">· im Scan erkannt</span>
            ) : null}
          </p>
        </div>

        {/* Price or entry button */}
        <div className="flex-shrink-0 text-right" onClick={(e) => e.stopPropagation()}>
          {isPriced ? (
            <div>
              <p className="text-[14.5px] font-bold text-ink">{formatEur(lineTotal)} €</p>
              <p className="text-[9.5px] text-ink-muted">
                {formatEur(item.unitPriceCents)} €/{unitLabel(item.unit)}
              </p>
            </div>
          ) : (
            <PriceEntryButton item={item} onChange={onPriceChange} />
          )}
        </div>
      </div>

      {/* Inline quantity editor — wall items show the gross/openings/net
          breakdown above the field so the deduction is explicit + reversible. */}
      {showEditor && (
        <div
          className="border-b border-[#ECEFF4] px-4 pb-3 pt-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          {bd && (
            <div className="mb-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-sub">
              <span>
                Brutto <b className="text-ink">{formatQty(bd.grossM2)}</b> m²
              </span>
              <span className="text-ink-muted">
                − Öffnungen <b className="text-ink-sub">{formatQty(bd.openingsM2)}</b> m²
              </span>
              <span>
                = Netto <b className="text-ink">{formatQty(bd.netM2)}</b> m²
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] font-bold uppercase tracking-wide text-ink-muted">
              Menge
            </span>
            <BomQuantityEditor
              key={`qty-${item.id}-${item.quantityOverride ?? 'net'}`}
              item={item}
              onQuantityChange={onQuantityChange}
            />
            <span className="text-[12px] text-ink-sub">{unitLabel(item.unit)}</span>
            {bd && bd.openingsM2 > 0 && (
              <button
                type="button"
                onClick={() => onQuantityChange(item.id, bd.grossM2)}
                className="rounded-[8px] border border-edge px-2 py-1 text-[11.5px] font-semibold text-ink-sub"
              >
                Brutto übernehmen
              </button>
            )}
            {isOverridden && (
              <button
                type="button"
                onClick={() => onQuantityChange(item.id, null)}
                className="rounded-[8px] border border-edge px-2 py-1 text-[11.5px] font-semibold text-brand"
              >
                {bd ? 'Netto' : 'Zurücksetzen'}
              </button>
            )}
          </div>
          {bd && bd.openingsM2 > 0 && (
            <p className="mt-1.5 text-[10.5px] text-ink-muted">
              Kleine Öffnungen werden je nach Gewerk übermessen (VOB/C) — dann Brutto wählen.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
