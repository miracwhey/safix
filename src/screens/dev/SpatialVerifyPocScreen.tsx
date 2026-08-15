/**
 * Dev-only POC screen — `/dev/spatial-verify`
 *
 * A runnable demonstration surface (NOT production logic) for the Phase-3
 * Customer-Verify-Flow: it mounts `<VerifySheet>` against a synthetic
 * canonical bathroom scene so a reviewer can drive, without a rebuild, the
 * complete 5-stage verify flow end-to-end:
 *
 *   - Stage 1 · Welcome  — quality badge + scene counts (the Quality-Detail
 *     seam `onOpenQualityDetail` surfaces a toast — Mockup 14 is a later
 *     block; here only the seam is exercised),
 *   - Stage 2 · Maße     — a wall-height correction on `customer_corrections`,
 *   - Stage 3 · Layout   — wall delete / opening move / add-door,
 *   - Stage 4 · Wünsche  — Wunsch-Pins, incl. photo pins (the `projectId` +
 *     `ownerUserId` props are set so a Stage-4 photo attach works),
 *   - Stage 5 · Senden   — Confirm + the `customer_verify_state` FSM walk to
 *     `approved`, the `base_ready → inquiry_ready` host flip, and the VF-2
 *     Re-Quote trigger.
 *
 * Parity goal (Restschuld-Audit): Phase 1.5 has `/dev/spatial-poc` and Phase 2
 * has `/dev/spatial-edit`; this screen closes the missing Phase-3 dev-POC so
 * the verify flow runs in a real browser surface like the other phases do.
 *
 * ── Real wiring (the audit seams this POC exercises) ────────────────────────
 *   - The screen seeds a real `spatial_scenes` row into the InMemory scene
 *     repository (`getSpatialSceneRepository('in-memory')`) and passes its
 *     id as `sceneId`. The verify-state column writes done inside
 *     `useVerifyFlow` therefore PERSIST — the dev panel reads the row back so
 *     Resume (App-Kill / Re-Enter) is testable: confirm the flow, "reset",
 *     and the resume-stage banner shows the persisted state.
 *   - `onMarkQuotesStale` runs the real Phase-3 Re-Quote seam (F2 of the
 *     audit): `evaluateReQuoteTrigger` + `planMarkQuotesStale` against a few
 *     synthetic pending offers, with the result rendered in the dev panel.
 *   - `onVerifyStateTransition` mirrors the verify-state into the panel.
 *
 * Gated behind `import.meta.env.DEV` — never reachable in a production build
 * (see the `App.tsx` route guard). The dev role switcher writes a mock session
 * via `__testOnly_setSession` (the same authoritative seam the workflow-layer
 * RBAC guards read) — a DEV affordance only, never called from production.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { User } from '@supabase/supabase-js'

import { VerifySheet } from '../../components/spatial/verify/VerifySheet'
import type { Wall, Floor, Ceiling, WallOpening } from '../../lib/spatial/canonical/types/geometry'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import type { SpatialObject, ObjectCategory, ObjectHost } from '../../lib/spatial/canonical/types/objects'
import type { Pin } from '../../lib/spatial/canonical/types/annotations'
import type { Variant } from '../../lib/spatial/canonical/types/variants'
import { STANDARD_VARIANTS } from '../../lib/spatial/canonical/types/variants'
import {
  IDENTITY_QUATERNION,
  IDENTITY_VECTOR3,
  ONE_VECTOR3,
} from '../../lib/spatial/canonical/types/primitives'
import { __testOnly_setSession, type SessionState } from '../../lib/session'
import { getSpatialSceneRepository } from '../../lib/spatial/canonical/repository/registry'
import type { SpatialScene } from '../../lib/spatial/canonical/repository/SpatialSceneRepository'
import type { CustomerVerifyState } from '../../lib/spatial/canonical/repository/spatialSceneFsm'
import {
  evaluateReQuoteTrigger,
  planMarkQuotesStale,
  type StaleOfferPlan,
} from '../../lib/spatial/workflow/verifyReQuote'
import type { VerifyChangeSummary } from '../../lib/spatial/workflow/verifyChangeSummary'
import type { Offer } from '../../lib/offers/types'

// ── Dev role switcher ──────────────────────────────────────────────────────

const DEV_CUSTOMER_ID = 'dev-customer-1'
const DEV_PROVIDER_ID = 'dev-provider-1'

type DevRole = 'customer' | 'provider'

/**
 * Build the mock session for `devRole`. The verify edits ALWAYS write on the
 * `customer_corrections` layer; the RBAC guard inside the workflow lets the
 * `customer` role write that layer and refuses a `craftsman` — so the
 * "Provider" choice demonstrates the Stage-2/3/4 RBAC reject path.
 */
function mockSessionFor(role: DevRole): SessionState {
  const userId = role === 'customer' ? DEV_CUSTOMER_ID : DEV_PROVIDER_ID
  const user = {
    id: userId,
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  } as unknown as User
  return {
    user,
    role: role === 'customer' ? 'customer' : 'craftsman',
    craftsmanRole: role === 'provider' ? 'owner' : null,
    isOperator: false,
    tosAcceptedAt: null,
    loading: false,
    sessionValidated: true,
    error: null,
    errorKind: null,
  }
}

// ── Synthetic in-memory pending offers (VF-2 Re-Quote target) ──────────────

/** SaFix project the synthetic scene + offers belong to. */
const DEV_PROJECT_ID = 'dev-spatial-verify-project'

/**
 * Three synthetic offers for `DEV_PROJECT_ID` — two `pending` (Re-Quote
 * candidates), one already `accepted` (must be skipped by `planMarkQuotesStale`).
 * Used purely to exercise the VF-2 Re-Quote seam in `onMarkQuotesStale`.
 */
function buildTestOffers(): Offer[] {
  const now = Date.now()
  const base = {
    conversationId: 'dev-conv-1',
    projectId: DEV_PROJECT_ID,
    customerUserId: DEV_CUSTOMER_ID,
    craftsmanUserId: DEV_PROVIDER_ID,
    price: '1.500 €',
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  }
  return [
    { ...base, id: 'dev-offer-pending-1', status: 'pending' },
    { ...base, id: 'dev-offer-pending-2', status: 'pending' },
    { ...base, id: 'dev-offer-accepted-1', status: 'accepted' },
  ]
}

// ── Re-Quote panel state ───────────────────────────────────────────────────

/** What the dev panel shows after a Stage-5 confirm fired `onMarkQuotesStale`. */
interface ReQuoteOutcome {
  /** `true` once the VF-2 evaluation crossed the threshold. */
  triggered: boolean
  /** The VF-2 reason (e.g. `measurement_changed`) — `null` when not triggered. */
  reason: string | null
  /** The offers that were planned stale. */
  plans: StaleOfferPlan[]
}

export default function SpatialVerifyPocScreen(): ReactElement {
  const [devRole, setDevRole] = useState<DevRole>('customer')
  const [open, setOpen] = useState(true)
  const [sceneId, setSceneId] = useState<string | null>(null)
  const [verifyState, setVerifyState] = useState<CustomerVerifyState>('not_started')
  const [persistedScene, setPersistedScene] = useState<SpatialScene | null>(null)
  const [reQuote, setReQuote] = useState<ReQuoteOutcome | null>(null)
  const [qualityDetailOpens, setQualityDetailOpens] = useState(0)

  // The synthetic offers are stable for the screen's lifetime — VF-2 evaluates
  // them on every Stage-5 confirm.
  const testOffers = useMemo<Offer[]>(() => buildTestOffers(), [])

  // Install the dev session synchronously before VerifySheet's `useVerifyFlow`
  // reads it — the verify edits are RBAC-gated against this session.
  useEffect(() => {
    __testOnly_setSession(mockSessionFor(devRole))
  }, [devRole])

  // Seed a real `spatial_scenes` row into the InMemory repository ONCE so the
  // verify-state column writes inside `useVerifyFlow` actually persist — that
  // is what makes Resume testable in this POC.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const repo = getSpatialSceneRepository('in-memory')
      const created = await repo.create({
        sourceScanId: 'dev-spatial-verify-scan',
        parametricStoragePath: 'dev/spatial-verify/parametric.json',
        customerId: DEV_CUSTOMER_ID,
        customerVerifyState: 'not_started',
      })
      if (cancelled) return
      setSceneId(created.id)
      setPersistedScene(created)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const scene = useMemo(() => buildVerifyPocScene(), [])
  const variants = useMemo(() => buildVariants(), [])

  /** Re-read the persisted row so the panel reflects what `useVerifyFlow` wrote. */
  const refreshPersistedScene = useCallback(async () => {
    if (sceneId == null) return
    const repo = getSpatialSceneRepository('in-memory')
    const row = await repo.findById(sceneId)
    if (row) setPersistedScene(row)
  }, [sceneId])

  // ── VerifySheet callbacks — all real ──────────────────────────────────────

  /** Observation seam — mirror every verify-state transition into the panel. */
  const handleVerifyStateTransition = useCallback(
    (next: CustomerVerifyState) => {
      setVerifyState(next)
      void refreshPersistedScene()
    },
    [refreshPersistedScene],
  )

  /**
   * Stage-5 "Provider anfragen" host handler — the production host would run
   * the `base_ready → inquiry_ready` FSM flip + provider-discovery here. The
   * POC just reports success so the submit path completes.
   */
  const handleRequestProvider = useCallback(
    async (): Promise<{ ok: boolean; message?: string }> => {
      return { ok: true, message: 'POC: Provider-Anfrage simuliert.' }
    },
    [],
  )

  /**
   * VF-2 Re-Quote seam (Block 3.9) — the audit's F2 seam, exercised for real.
   * Evaluates the verify change-summary against the synthetic pending offers
   * and renders the plan in the dev panel.
   */
  const handleMarkQuotesStale = useCallback(
    (changeSummary: VerifyChangeSummary) => {
      const evaluation = evaluateReQuoteTrigger(changeSummary)
      const plans =
        sceneId != null
          ? planMarkQuotesStale(testOffers, evaluation, sceneId)
          : []
      setReQuote({
        triggered: evaluation.triggered,
        reason: evaluation.triggered ? evaluation.reason : null,
        plans,
      })
    },
    [sceneId, testOffers],
  )

  /** Quality-Detail seam (Mockup 14 is a later block) — surface it as a count. */
  const handleOpenQualityDetail = useCallback(() => {
    setQualityDetailOpens((n) => n + 1)
  }, [])

  /** Stage-5 success — keep the sheet open here so the panel stays readable. */
  const handleSubmitted = useCallback(() => {
    void refreshPersistedScene()
  }, [refreshPersistedScene])

  /** Re-open the sheet — drives the App-Kill / Re-Enter resume rule. */
  const handleReopen = useCallback(() => {
    setOpen(false)
    // Re-mount on the next tick so VerifySheet's `useVerifyFlow` re-resolves
    // the resume stage from the now-persisted columns.
    requestAnimationFrame(() => setOpen(true))
  }, [])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#1a1a1d',
        color: '#fafafa',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #2a2a2e',
          fontFamily: 'system-ui, sans-serif',
          fontSize: 13,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
        }}
      >
        <strong>Spatial Verify · POC (Phase 3 · 5-Stage-Flow)</strong>
        <span style={{ opacity: 0.6 }}>
          VerifySheet gegen eine Test-Scene · Stage 1-5 durchklicken
        </span>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <span style={{ opacity: 0.7 }}>Dev-Rolle</span>
          <select
            value={devRole}
            onChange={(e) => setDevRole(e.target.value as DevRole)}
            style={selectStyle}
          >
            <option value="customer">Customer (Edits erlaubt)</option>
            <option value="provider">Provider (RBAC-Reject)</option>
          </select>
        </label>
      </header>

      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: 'minmax(260px, 320px) 1fr',
          minHeight: 0,
        }}
      >
        {/* Dev panel — verify state / resume / re-quote / quality seam. */}
        <aside
          style={{
            borderRight: '1px solid #2a2a2e',
            padding: 14,
            fontFamily: 'system-ui, sans-serif',
            fontSize: 12,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <section>
            <PanelTitle>Verify-State (live)</PanelTitle>
            <PanelRow label="customer_verify_state" value={verifyState} />
            <PanelRow label="sceneId" value={sceneId ?? '— (lädt …)'} />
            <PanelRow
              label="persisted last_stage"
              value={persistedScene?.customerVerifyLastStage ?? '—'}
            />
            <PanelRow
              label="persisted state"
              value={persistedScene?.customerVerifyState ?? '—'}
            />
          </section>

          <section>
            <PanelTitle>Resume (App-Kill / Re-Enter)</PanelTitle>
            <p style={{ opacity: 0.6, lineHeight: 1.5, margin: '0 0 8px' }}>
              Verify-State wird in das InMemory-Scene-Repository persistiert.
              "Sheet neu öffnen" remountet VerifySheet — `useVerifyFlow`
              resolved die Resume-Stage aus den persistierten Spalten.
            </p>
            <button type="button" onClick={handleReopen} style={buttonStyle}>
              Sheet neu öffnen (Resume)
            </button>
            {!open && (
              <p style={{ opacity: 0.5, marginTop: 6 }}>Sheet geschlossen …</p>
            )}
          </section>

          <section>
            <PanelTitle>VF-2 Re-Quote (Block 3.9 · F2-Seam)</PanelTitle>
            <p style={{ opacity: 0.6, lineHeight: 1.5, margin: '0 0 8px' }}>
              Stage-5-Confirm feuert `onMarkQuotesStale` →
              `evaluateReQuoteTrigger` + `planMarkQuotesStale` gegen{' '}
              {testOffers.length} Test-Offers (2 pending, 1 accepted).
            </p>
            {reQuote == null ? (
              <p style={{ opacity: 0.5 }}>Noch kein Confirm — Stage 5 abschließen.</p>
            ) : (
              <>
                <PanelRow
                  label="triggered"
                  value={reQuote.triggered ? 'ja' : 'nein'}
                />
                <PanelRow label="reason" value={reQuote.reason ?? '—'} />
                <PanelRow
                  label="stale-geplant"
                  value={`${reQuote.plans.length} Offer(s)`}
                />
                {reQuote.plans.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 16, opacity: 0.8 }}>
                    {reQuote.plans.map((p) => (
                      <li key={p.offerId}>
                        {p.offerId} → {p.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section>
            <PanelTitle>Quality-Detail-Seam (Mockup 14)</PanelTitle>
            <p style={{ opacity: 0.6, lineHeight: 1.5, margin: '0 0 6px' }}>
              Stage-1 Quality-Badge ist tap-bar; das volle Detail-Sheet ist
              eigener Scope — hier nur der Seam sichtbar.
            </p>
            <PanelRow label="onOpenQualityDetail-Calls" value={qualityDetailOpens} />
          </section>
        </aside>

        {/* The VerifySheet — mounted against the synthetic scene. */}
        <main style={{ position: 'relative', minHeight: 0 }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'system-ui, sans-serif',
              fontSize: 13,
              opacity: 0.4,
              textAlign: 'center',
              padding: 24,
            }}
          >
            VerifySheet rendert als Bottom-Sheet über dieser Fläche.
          </div>
          <VerifySheet
            open={open}
            onClose={() => setOpen(false)}
            sceneId={sceneId}
            scene={scene}
            variants={variants}
            verifyState={verifyState}
            lastStage={persistedScene?.customerVerifyLastStage ?? null}
            projectId={DEV_PROJECT_ID}
            ownerUserId={DEV_CUSTOMER_ID}
            onVerifyStateTransition={handleVerifyStateTransition}
            onRequestProvider={handleRequestProvider}
            onMarkQuotesStale={handleMarkQuotesStale}
            onOpenQualityDetail={handleOpenQualityDetail}
            onSubmitted={handleSubmitted}
          />
        </main>
      </div>
    </div>
  )
}

// ── Dev-panel primitives ───────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: '#27272b',
  color: '#fafafa',
  border: '1px solid #3a3a3e',
  borderRadius: 6,
  padding: '3px 6px',
  fontSize: 12,
}

const buttonStyle: React.CSSProperties = {
  background: '#27272b',
  color: '#fafafa',
  border: '1px solid #3a3a3e',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
}

function PanelTitle({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <h3
      style={{
        margin: '0 0 6px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        opacity: 0.55,
      }}
    >
      {children}
    </h3>
  )
}

function PanelRow({
  label,
  value,
}: {
  label: string
  value: string | number
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        padding: '2px 0',
      }}
    >
      <span style={{ opacity: 0.6 }}>{label}</span>
      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</strong>
    </div>
  )
}

// ── Synthetic verify POC scene (4 × 5 m bathroom · door + window + objects) ─

const NOW = '2026-05-20T00:00:00.000Z'
const ROOM_ID = 'verifypoc-room'
const WALL_HEIGHT = 2.5
const WALL_THICKNESS = 0.15

function baseNode<T extends string>(id: string, type: T, parentId: string) {
  return {
    id,
    type,
    parent_id: parentId,
    children_ids: [] as string[],
    variant_id: 'base_roomplan',
    source: 'manual' as const,
    confidence: 1,
    transform: {
      position: IDENTITY_VECTOR3,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    created_at: NOW,
    updated_at: NOW,
  }
}

function mkWall(
  id: string,
  start: { x: number; z: number },
  end: { x: number; z: number },
  opts: { materialId?: string; openings?: WallOpening[] } = {},
): Wall {
  return {
    ...baseNode(id, 'wall', ROOM_ID),
    start_point: { x: start.x, y: 0, z: start.z },
    end_point: { x: end.x, y: 0, z: end.z },
    height_m: WALL_HEIGHT,
    thickness_m: WALL_THICKNESS,
    base_height_m: 0,
    openings: opts.openings ?? [],
    wall_mounted: [],
    is_exterior_wall: true,
    walkable_blocker: true as const,
    material_id: opts.materialId,
    length_m: Math.hypot(end.x - start.x, end.z - start.z),
    normal: { x: 0, y: 0, z: 0 },
  }
}

function mkOpening(
  id: string,
  hostWallId: string,
  type: WallOpening['type'],
  offsetAlong: number,
  width: number,
  height: number,
  offsetFromFloor: number,
): WallOpening {
  return {
    ...baseNode(id, type, hostWallId),
    host_wall_id: hostWallId,
    offset_along_wall_m: offsetAlong,
    offset_from_floor_m: offsetFromFloor,
    width_m: width,
    height_m: height,
    is_walkable_portal: type === 'door',
  }
}

function mkObject(args: {
  id: string
  category: ObjectCategory
  host: ObjectHost
  position: { x: number; y: number; z: number }
  dimensions: { width_m: number; depth_m: number; height_m: number }
  assetId?: string
  materialId?: string
}): SpatialObject {
  return {
    ...baseNode(args.id, 'object', ROOM_ID),
    transform: {
      position: args.position,
      rotation: IDENTITY_QUATERNION,
      scale: ONE_VECTOR3,
    },
    category: args.category,
    asset_id: args.assetId,
    material_id: args.materialId,
    dimensions: args.dimensions,
    host: args.host,
    host_id: args.host === 'floor' ? 'verifypoc-floor' : ROOM_ID,
  }
}

function mkPin(id: string, surfaceId: string, u: number, v: number, pinType: Pin['pin_type']): Pin {
  return {
    ...baseNode(id, 'pin', ROOM_ID),
    pin_type: pinType,
    anchor_surface_id: surfaceId,
    anchor_surface_type: 'wall',
    anchor_uv: { u, v },
    anchor_offset_normal_m: 0.01,
    linked_photo_ids: [],
    linked_note_ids: [],
    linked_task_ids: [],
  }
}

/**
 * Build the Phase-3 verify POC scene — a renderable 4 × 5 m bathroom (door +
 * window + sanitary objects) so the Stage-1 sanity summary lands on the `ok`
 * path and Stages 2-4 have walls / openings / surfaces to edit.
 */
function buildVerifyPocScene(): RoomScene {
  const ring = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 5 },
    { x: 0, y: 0, z: 5 },
  ]

  const door = mkOpening('verifypoc-door', 'w_s', 'door', 1.2, 0.9, 2.05, 0)
  const window = mkOpening('verifypoc-window', 'w_e', 'window', 1.8, 1.2, 1.1, 0.95)

  const walls: Wall[] = [
    mkWall('w_s', { x: 0, z: 0 }, { x: 4, z: 0 }, {
      materialId: 'wall-tile-white',
      openings: [door],
    }),
    mkWall('w_e', { x: 4, z: 0 }, { x: 4, z: 5 }, {
      materialId: 'wall-tile-white',
      openings: [window],
    }),
    mkWall('w_n', { x: 4, z: 5 }, { x: 0, z: 5 }, { materialId: 'wall-tile-white' }),
    mkWall('w_w', { x: 0, z: 5 }, { x: 0, z: 0 }, { materialId: 'wall-tile-white' }),
  ]

  const floor: Floor = {
    ...baseNode('verifypoc-floor', 'floor', ROOM_ID),
    polygon: ring,
    material_id: 'floor-marble',
    walkable_surface: true as const,
    floor_mounted: [],
  }

  const ceiling: Ceiling = {
    ...baseNode('verifypoc-ceiling', 'ceiling', ROOM_ID),
    polygon: ring,
    height_m: WALL_HEIGHT,
    material_id: 'wall-paint-white',
    ceiling_mounted: [],
  }

  const free_objects: SpatialObject[] = [
    mkObject({
      id: 'obj-toilet',
      category: 'toilet',
      host: 'floor',
      position: { x: 0.6, y: 0, z: 0.6 },
      dimensions: { width_m: 0.4, depth_m: 0.7, height_m: 0.8 },
      assetId: 'sanitary-toilet-standard-floor',
      materialId: 'decor-ceramic-white',
    }),
    mkObject({
      id: 'obj-bathtub',
      category: 'bathtub',
      host: 'floor',
      position: { x: 2.0, y: 0, z: 4.0 },
      dimensions: { width_m: 1.7, depth_m: 0.8, height_m: 0.6 },
      assetId: 'sanitary-bathtub-freestanding-oval',
      materialId: 'decor-ceramic-white',
    }),
    mkObject({
      id: 'obj-sink',
      category: 'sink',
      host: 'floor',
      position: { x: 3.4, y: 0, z: 0.7 },
      dimensions: { width_m: 0.6, depth_m: 0.5, height_m: 0.9 },
      assetId: 'sanitary-sink-vanity-rectangle',
      materialId: 'counter-marble-beige',
    }),
  ]

  const pins: Pin[] = [mkPin('pin-existing', 'w_n', 0.5, 0.5, 'note')]

  return {
    ...baseNode(ROOM_ID, 'room', 'verifypoc-building'),
    category: 'bathroom',
    walls,
    floor,
    ceiling,
    free_objects,
    pins,
    photos: [],
    notes: [],
    bounds_min: { x: 0, y: 0, z: 0 },
    bounds_max: { x: 4, y: WALL_HEIGHT, z: 5 },
    computed_area_m2: 20,
    computed_volume_m3: 50,
  }
}

/**
 * The variant chain the renderer + the verify edits use. Stage-2/3/4
 * corrections always write `customer_corrections`; `base_roomplan` is the
 * scan basis the change-summary diffs against.
 */
function buildVariants(): Variant[] {
  return [
    {
      id: STANDARD_VARIANTS.BASE_ROOMPLAN,
      display_name: 'Scan (Original)',
      is_default: true,
    },
    {
      id: STANDARD_VARIANTS.CUSTOMER_CORRECTIONS,
      display_name: 'Kunden-Korrekturen',
      parent_variant_id: STANDARD_VARIANTS.BASE_ROOMPLAN,
      is_default: false,
    },
  ]
}
