/**
 * Spatial · Verify · VerifySheet (Phase 3 · Block 3.1 + 3.8 + 3.12)
 *
 * The Customer-Verify-Flow container (Mockup 15). One bottom-sheet modal,
 * multi-step shell over the 5 sub-stages (Welcome / Maße / Layout / Pins /
 * Confirm). Auto-opened after scan-completion; dismissible with "Später".
 *
 * ── Scope (Block 3.1-3.8) ───────────────────────────────────────────────────
 * The shell + stage navigation + ALL FIVE stages are now real. Stage 5
 * (Confirm · Block 3.8) is {@link VerifyStageConfirm}; the
 * {@link VerifyStagePlaceholder} now only stands in for a stage whose scene
 * has not loaded.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * UI layer only — rendering, input, view-state. Every decision is delegated:
 *   - stage navigation + resume      → `useVerifyFlow` → `spatialVerifyWorkflow`
 *   - Stage-1 sanity summary         → `deriveVerifySceneSummary`
 *   - Stage-5 change summary         → `deriveVerifyChangeSummary`
 *   - Stage-2/3/4 correction write   → `useVerifyFlow` → RBAC guard → command
 *   - Stage-5 confirm + FSM-walk     → `useVerifyFlow.submit*` → `persistVerifyState`
 *   - the `base_ready → inquiry_ready` flip → the host's `onRequestProvider`
 *   - the VF-2 Re-Quote-Trigger      → the host's `onMarkQuotesStale`
 * The container holds NO DB call and constructs NO command itself.
 *
 * ── Resume (App-Kill / Re-Enter · Implementation-Spec §2.3) ─────────────────
 * The container accepts `lastStage` + `verifyState` props and forwards them to
 * `useVerifyFlow`, which resolves the resume target via `resolveResumeStage`.
 * The DB columns (`customer_verify_last_stage` / `_last_active_at`) are read by
 * the host and passed in; `useVerifyFlow` stamps `_last_active_at` on open.
 *
 * ── Multi-click safety ──────────────────────────────────────────────────────
 * Every navigation handler is idempotent (`useVerifyFlow`'s `setState`
 * updaters clamp at the stage bounds and no-op on a same-stage goto). The
 * Stage-5 submit is double-submit-guarded inside `useVerifyFlow` (a `submitting`
 * + `submitted` ref pair) and the Confirm stage disables both CTAs while busy.
 */

import { useCallback, type ReactElement } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'
import { VerifyStepBar } from './VerifyStepBar'
import { VerifyStageWelcome } from './VerifyStageWelcome'
import {
  VerifyStageMeasure,
  type VerifyMeasureCorrectionOutcome,
} from './VerifyStageMeasure'
import { VerifyStageLayout } from './VerifyStageLayout'
import { VerifyStagePins } from './VerifyStagePins'
import {
  VerifyStageConfirm,
  type VerifySubmitOutcome,
} from './VerifyStageConfirm'
import { VerifyStagePlaceholder } from './VerifyStagePlaceholder'
import type {
  PinDropTarget,
  VerifyPinDetail,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'
import type { VerifyChangeSummary } from '../../../lib/spatial/workflow/verifyChangeSummary'

import {
  useVerifyFlow,
  type VerifyCorrectionResult,
} from '../../../lib/spatial/hooks/useVerifyFlow'
import { useCanonicalSceneStore } from '../../../lib/spatial/canonical/store/sceneStore'
import {
  VerifyStage,
  VERIFY_STAGE_LABEL,
  nextStage as computeNextStage,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'
import type { CustomerVerifyState } from '../../../lib/spatial/canonical/repository/spatialSceneFsm'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import type { NodeOverride, Variant, VariantId } from '../../../lib/spatial/canonical/types/variants'
import { STANDARD_VARIANTS } from '../../../lib/spatial/canonical/types/variants'
import { useToast } from '../../../hooks/useToast'
import { useHaptics } from '../../../hooks/useHaptics'

const EMPTY_OVERRIDES: NodeOverride[] = []
const EMPTY_VARIANTS: Variant[] = []

export interface VerifySheetProps {
  /** Controls visibility — `false` renders nothing. */
  open: boolean
  /** Dismiss the sheet ("Später" / backdrop / Escape). */
  onClose: () => void
  /**
   * The canonical scene id (`spatial_scenes.id`) — addresses the
   * `spatial_edit_history` audit rows for Stage-2 corrections AND the
   * `spatial_scenes` verify-state columns. `null` runs the sheet as a bare
   * preview (corrections apply locally, audit + verify-state persist skipped).
   */
  sceneId?: string | null
  /** The base canonical scene — hydrates the canonical store. */
  scene: RoomScene | null
  /** Override stack — hydrated into the store; corrections extend it. */
  overrides?: NodeOverride[]
  /** Variant chain — hydrated into the store. */
  variants?: Variant[]
  /**
   * The persisted `customer_verify_last_stage` — drives the resume target.
   * The host reads it off `spatial_scenes`; pass `null` when unknown.
   */
  lastStage?: number | null
  /**
   * The persisted `customer_verify_state` — gates the resume rule. Defaults
   * to `not_started`.
   */
  verifyState?: CustomerVerifyState
  /**
   * Observation callback — fired when a verify-state transition is written
   * (the `not_started → in_progress` first-edit flip and the Stage-5 `approved`
   * confirm). Persistence itself is done inside the hook; this lets a host
   * mirror the state into a projection.
   */
  onVerifyStateTransition?: (next: CustomerVerifyState) => void
  /**
   * Stage-5 "Provider anfragen" handler — the host wires the workflow-layer
   * `base_ready → inquiry_ready` FSM-flip + provider-discovery start here
   * (Block 3.8). When omitted the verify still completes (`approved`) and the
   * submit reports success — bare-preview parity.
   */
  onRequestProvider?: () => Promise<{ ok: boolean; message?: string }>
  /**
   * Stage-5 VF-2 Re-Quote hook — fired after the verify is confirmed. The host
   * evaluates the change-summary against the project's pending offers and
   * flags stale quotes (Block 3.9). Best-effort.
   */
  onMarkQuotesStale?: (changeSummary: VerifyChangeSummary) => void | Promise<void>
  /** Called after a successful Stage-5 submit — typically closes the sheet. */
  onSubmitted?: () => void
  /**
   * SaFix project id — the media-upload entity for a Stage-4 `photo` pin's
   * image. `null` disables the photo attach (the `photo` pin still works as a
   * marker without an image).
   */
  projectId?: string | null
  /**
   * auth.users.id — the Stage-4 photo-pin media-upload owner. `null` disables
   * the photo attach.
   */
  ownerUserId?: string | null
  /**
   * Stage-1 Quality-Detail seam — opens the full quality-report sheet
   * (Mockup 14 · VF-1 tap-through from the {@link QualityScoreBadge}). When
   * omitted the badge stays non-interactive (score + label only). The full
   * detail sheet is a later block; this prop is the host seam for it.
   */
  onOpenQualityDetail?: () => void
}

export function VerifySheet({
  open,
  onClose,
  sceneId = null,
  scene,
  overrides = EMPTY_OVERRIDES,
  variants = EMPTY_VARIANTS,
  lastStage = null,
  verifyState = 'not_started',
  onVerifyStateTransition,
  onRequestProvider,
  onMarkQuotesStale,
  onSubmitted,
  projectId = null,
  ownerUserId = null,
  onOpenQualityDetail,
}: VerifySheetProps): ReactElement | null {
  const toast = useToast()
  const haptics = useHaptics()

  // The customer-verify edits ALWAYS render + write on the customer_corrections
  // layer (Implementation-Spec §1). The renderer is anchored there so a
  // correction is immediately visible on the layer it actually wrote.
  const activeVariantId: VariantId = STANDARD_VARIANTS.CUSTOMER_CORRECTIONS

  const flow = useVerifyFlow({
    sceneId,
    lastStage,
    verifyState,
    onVerifyStateTransition,
    onRequestProvider,
    onConfirmReQuote: onMarkQuotesStale,
  })

  // The LIVE resolved scene — Stages 2-5 read this (not the static `scene`
  // prop) so a Stage-3 wall-delete / door-add or a Stage-4 pin-drop is
  // immediately reflected in the wall / opening / pin lists. The renderer
  // hydrates the store from the `scene` prop on mount; commands then mutate
  // the store, and `resolved` re-derives. Falls back to the `scene` prop
  // before the store hydrates (first render).
  const resolvedScene = useCanonicalSceneStore((s) => s.resolved)
  const liveScene = resolvedScene ?? scene

  /**
   * Translate a {@link VerifyCorrectionResult} from any verify edit (Stage
   * 2/3/4) into the UI outcome + haptic + toast. The workflow already
   * RBAC-gated, applied, and persisted the edit; this only surfaces feedback.
   */
  const settleEdit = useCallback(
    (
      result: VerifyCorrectionResult,
      successText: string,
    ): VerifyMeasureCorrectionOutcome => {
      if (!result.ok) {
        haptics.error()
        toast.error(result.hint)
        return { ok: false, messages: [result.hint] }
      }
      haptics.success()
      if (result.warnings.length > 0) {
        toast.info(result.warnings[0])
        return { ok: true, messages: result.warnings }
      }
      toast.success(successText)
      return { ok: true, messages: [successText] }
    },
    [haptics, toast],
  )

  // ── Stage-2 · wall-height correction ──────────────────────────────────────
  const handleCorrect = useCallback(
    async (wallId: string, newHeightM: number): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.correctWallHeight(wallId, newHeightM)
      return settleEdit(result, 'Maß übernommen.')
    },
    [flow, settleEdit],
  )

  // ── Stage-3 · layout edits ────────────────────────────────────────────────
  const handleDeleteWall = useCallback(
    async (wallId: string): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.deleteWall(wallId)
      return settleEdit(result, 'Wand entfernt.')
    },
    [flow, settleEdit],
  )

  const handleMoveOpening = useCallback(
    async (openingId: string, newOffsetAlongWallM: number): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.moveOpening(openingId, newOffsetAlongWallM)
      return settleEdit(result, 'Öffnung verschoben.')
    },
    [flow, settleEdit],
  )

  const handleAddDoor = useCallback(
    async (wallId: string, offsetAlongWallM: number): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.addDoor(wallId, offsetAlongWallM)
      return settleEdit(result, 'Tür hinzugefügt.')
    },
    [flow, settleEdit],
  )

  // ── Stage-4 · Wunsch-Pins ─────────────────────────────────────────────────
  const handleAddPin = useCallback(
    async (drop: PinDropTarget, detail: VerifyPinDetail): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.addPin(drop, detail)
      return settleEdit(result, 'Markierung gesetzt.')
    },
    [flow, settleEdit],
  )

  const handleMovePin = useCallback(
    async (pinId: string, drop: PinDropTarget): Promise<VerifyMeasureCorrectionOutcome> => {
      const result = await flow.movePin(pinId, drop)
      return settleEdit(result, 'Markierung verschoben.')
    },
    [flow, settleEdit],
  )

  const handleUndo = useCallback(() => {
    if (!flow.undoLastEdit()) {
      toast.info('Nichts zum Rückgängigmachen.')
    }
  }, [flow, toast])

  // ── Stage-5 · Confirm + submit ────────────────────────────────────────────
  // Both submit paths surface the toast + haptic and, on success, hand back
  // to the host (`onSubmitted` — typically closes the sheet).
  const handleRequestProvider = useCallback(async (): Promise<VerifySubmitOutcome> => {
    const result = await flow.submitRequestProvider()
    if (result.ok) {
      haptics.success()
      toast.success(result.message)
      onSubmitted?.()
    } else {
      haptics.error()
      toast.error(result.message)
    }
    return { ok: result.ok, message: result.message }
  }, [flow, haptics, toast, onSubmitted])

  const handleSaveOnly = useCallback(async (): Promise<VerifySubmitOutcome> => {
    const result = await flow.submitSaveOnly()
    if (result.ok) {
      haptics.success()
      toast.success(result.message)
      onSubmitted?.()
    } else {
      haptics.error()
      toast.error(result.message)
    }
    return { ok: result.ok, message: result.message }
  }, [flow, haptics, toast, onSubmitted])

  if (!open) return null

  const { stage, summary } = flow
  const canProceed = stage !== VerifyStage.Welcome || summary.canProceed
  const isLastStage = computeNextStage(stage) === null

  // Footer copy is stage-specific (Mockup 15). The Welcome stage's primary CTA
  // is disabled on the `unrenderable` path (no forward path · §Stage-1).
  const primaryLabel =
    stage === VerifyStage.Welcome
      ? 'Weiter zu Maße'
      : `Weiter zu ${nextStageLabel(stage)}`

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      maxWidth={440}
      hideHandle
      className="!px-0 !pt-0"
    >
      <div className="flex max-h-[88dvh] flex-col" data-testid="verify-sheet">
        {/* Grabber + step-bar */}
        <div
          className="mx-auto mt-2 h-1 w-9 rounded-full bg-slate-900/20"
          aria-hidden="true"
        />
        <VerifyStepBar stage={stage} />

        {/* Scrollable stage content */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {stage === VerifyStage.Welcome && (
            <VerifyStageWelcome
              summary={summary}
              onOpenQualityDetail={onOpenQualityDetail}
              preview={
                <CanonicalSceneRoot
                  scene={scene}
                  overrides={overrides}
                  variants={variants}
                  activeVariantId={activeVariantId}
                  className="aspect-[4/3] w-full"
                />
              }
            />
          )}

          {stage === VerifyStage.Measure &&
            (scene ? (
              <VerifyStageMeasure
                scene={scene}
                overrides={overrides}
                variants={variants}
                activeVariantId={activeVariantId}
                onCorrect={handleCorrect}
              />
            ) : (
              <VerifyStagePlaceholder
                stage={VerifyStage.Measure}
                note="Der Scan ist noch nicht geladen."
              />
            ))}

          {stage === VerifyStage.Layout &&
            (liveScene ? (
              <VerifyStageLayout
                scene={liveScene}
                overrides={overrides}
                variants={variants}
                activeVariantId={activeVariantId}
                canUndo={flow.canUndo}
                onDeleteWall={handleDeleteWall}
                onMoveOpening={handleMoveOpening}
                onAddDoor={handleAddDoor}
                onUndo={handleUndo}
              />
            ) : (
              <VerifyStagePlaceholder
                stage={VerifyStage.Layout}
                note="Der Scan ist noch nicht geladen."
              />
            ))}
          {stage === VerifyStage.Pins &&
            (liveScene ? (
              <VerifyStagePins
                scene={liveScene}
                overrides={overrides}
                variants={variants}
                activeVariantId={activeVariantId}
                projectId={projectId}
                ownerUserId={ownerUserId}
                canUndo={flow.canUndo}
                onAddPin={handleAddPin}
                onMovePin={handleMovePin}
                onUndo={handleUndo}
              />
            ) : (
              <VerifyStagePlaceholder
                stage={VerifyStage.Pins}
                note="Der Scan ist noch nicht geladen."
              />
            ))}
          {stage === VerifyStage.Confirm && (
            <VerifyStageConfirm
              summary={flow.changeSummary}
              preview={
                <CanonicalSceneRoot
                  scene={liveScene}
                  overrides={overrides}
                  variants={variants}
                  activeVariantId={activeVariantId}
                  className="aspect-[16/9] w-full"
                />
              }
              onRequestProvider={handleRequestProvider}
              onSaveOnly={handleSaveOnly}
            />
          )}
        </div>

        {/* Sticky footer — the Confirm stage owns its own actions, so the
            shared "Weiter" CTA is hidden on Stage 5. */}
        <div className="flex flex-col gap-2 border-t border-slate-900/[0.06] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3.5">
          {!isLastStage && (
            <button
              type="button"
              onClick={flow.goNext}
              disabled={!canProceed}
              data-testid="verify-primary-cta"
              className="w-full rounded-2xl bg-slate-900 px-4 py-3.5 text-[15px] font-bold text-white shadow-[0_6px_16px_rgba(10,15,28,0.3)] transition active:scale-[0.99] disabled:opacity-40"
            >
              {primaryLabel}
            </button>
          )}
          <div className="flex items-center justify-between">
            {stage !== VerifyStage.Welcome ? (
              <button
                type="button"
                onClick={flow.goPrev}
                data-testid="verify-back"
                className="px-2 py-1.5 text-[13px] font-medium text-slate-500"
              >
                ‹ Zurück
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
            <button
              type="button"
              onClick={onClose}
              data-testid="verify-skip"
              className="px-2 py-1.5 text-[13px] font-medium text-slate-500"
            >
              {stage === VerifyStage.Welcome
                ? 'Skip · später machen'
                : 'Später fortsetzen'}
            </button>
          </div>
        </div>
      </div>
    </BottomSheet>
  )
}

/** German label of the stage that follows `stage` (for the primary CTA). */
function nextStageLabel(stage: VerifyStage): string {
  const next = computeNextStage(stage)
  return next ? VERIFY_STAGE_LABEL[next] : ''
}
