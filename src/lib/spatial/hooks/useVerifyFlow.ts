/**
 * Spatial · Hooks · useVerifyFlow (Phase 3 · Block 3.1-3.4 + 3.8 + 3.12)
 *
 * The React adapter the VerifySheet container drives. It owns ONLY view-state
 * + the wiring to the pure layers — every decision lives in
 * `workflow/spatialVerifyWorkflow.ts`, `workflow/verifySceneSummary.ts`, and
 * `workflow/verifyChangeSummary.ts`.
 *
 * Responsibilities:
 *   1. hold the current {@link VerifyStage} (resume-aware on mount),
 *   2. expose multi-click-safe next / prev / goto stage navigation,
 *   3. derive the Stage-1 sanity-check summary + the Stage-5 change summary,
 *   4. drive a Stage-2/3/4 verify edit:
 *        build → RBAC-gate → `editHistoryStore.apply()` → persist (best-effort)
 *        → `customer_verify_state` `not_started → in_progress` transition,
 *   5. drive the Stage-5 confirm — walk `customer_verify_state` to `approved`
 *      (Block 3.8 / 3.12), exposing the "Provider anfragen" / "Erstmal
 *      speichern" submit methods,
 *   6. report branchable results so the UI can show a reject / soft-warn toast.
 *
 * Layer: this hook is the UI↔workflow seam. It calls the WORKFLOW helpers
 * (`buildWallCorrectionCommand`, `verifyStateAfterFirstEdit`, …) and the
 * canonical WORKFLOW persistence helpers (`persistEditCommand`,
 * `persistVerifyState`) — never a repository directly. The verify-state column
 * writes go through `canonical/workflow/persistVerifyState.ts` (Block 3.12);
 * `onVerifyStateTransition` stays as an OBSERVATION callback so a host can
 * mirror the state into a projection if it needs to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useCanonicalSceneStore } from '../canonical/store/sceneStore'
import { useEditHistoryStore } from '../canonical/store/editHistoryStore'
import { persistEditCommand } from '../canonical/workflow/persistEditCommand'
import {
  persistVerifyProgress,
  persistVerifyConfirm,
  touchVerifyActivity,
} from '../canonical/workflow/persistVerifyState'
import type { CustomerVerifyState } from '../canonical/repository/spatialSceneFsm'
import { toSpatialEditUser } from '../workflow/spatialEditPermissions'
import {
  buildWallCorrectionCommand,
  buildWallDeleteCommand,
  buildOpeningMoveCommand,
  buildAddDoorCommand,
  buildAddPinCommand,
  buildMovePinCommand,
  resolveResumeStage,
  verifyStateAfterFirstEdit,
  nextStage as computeNextStage,
  prevStage as computePrevStage,
  VerifyStage,
  type PinDropTarget,
  type VerifyPinDetail,
} from '../workflow/spatialVerifyWorkflow'
import type { BaseCommand } from '../canonical/commands/BaseCommand'
import {
  deriveVerifySceneSummary,
  type VerifySceneSummary,
} from '../workflow/verifySceneSummary'
import {
  deriveVerifyChangeSummary,
  type VerifyChangeSummary,
} from '../workflow/verifyChangeSummary'
import { useSession } from '../../../hooks/useSession'
import { logError } from '../../observability'
import { recordPersistenceFailure } from '../../persistence'

/** Outcome of a Stage-2/3/4 verify edit. */
export type VerifyCorrectionResult =
  /**
   * The correction was applied. `warnings` carries any Phase-2 soft-constraint
   * messages the UI should surface as a confirm-toast. `verifyStateTransition`
   * is the `customer_verify_state` target if this edit triggered the
   * `not_started → in_progress` flip (`null` when no transition was needed).
   */
  | {
      ok: true
      warnings: string[]
      verifyStateTransition: CustomerVerifyState | null
    }
  /**
   * The correction was REJECTED — no command applied, no override written.
   * `hint` is a short German line for the reject-toast.
   */
  | { ok: false; hint: string }

/** Outcome of a Stage-5 submit (`requestProvider` / `saveOnly`). */
export interface VerifySubmitResult {
  ok: boolean
  /** German line for the toast — success copy or failure hint. */
  message: string
  /** The `customer_verify_state` the scene landed on (best-effort). */
  verifyState: CustomerVerifyState | null
}

/** Public surface of {@link useVerifyFlow}. */
export interface VerifyFlowApi {
  /** The current verify sub-stage. */
  stage: VerifyStage
  /** Move to the next stage — no-op on the last stage. Multi-click-safe. */
  goNext: () => void
  /** Move to the previous stage — no-op on the first stage. Multi-click-safe. */
  goPrev: () => void
  /** Jump to a specific stage (e.g. step-bar tap / resume). Multi-click-safe. */
  goToStage: (stage: VerifyStage) => void
  /** Stage-1 sanity-check summary derived from the resolved scene. */
  summary: VerifySceneSummary
  /**
   * Stage-5 change overview — every measurement / layout / pin change the
   * customer made, diffed base-scene vs resolved-scene (Block 3.8).
   */
  changeSummary: VerifyChangeSummary
  /**
   * Apply a Stage-2 wall-height correction. RBAC-gated to `customer_corrections`,
   * runs through the Phase-2 command stack + constraint validator, persists the
   * edit to the audit trail (best-effort), and computes the verify-state flip.
   */
  correctWallHeight: (wallId: string, newHeightM: number) => Promise<VerifyCorrectionResult>
  /**
   * Stage-3 · delete a mis-detected wall. RBAC-gated; refuses below the
   * minimum wall count BEFORE building a command (Edge-Case §9).
   */
  deleteWall: (wallId: string) => Promise<VerifyCorrectionResult>
  /** Stage-3 · re-position a door / window opening along its host wall. */
  moveOpening: (openingId: string, newOffsetAlongWallM: number) => Promise<VerifyCorrectionResult>
  /** Stage-3 · insert a new door, centred at `offsetAlongWallM` on `wallId`. */
  addDoor: (wallId: string, offsetAlongWallM: number) => Promise<VerifyCorrectionResult>
  /** Stage-4 · drop a new Wunsch-Pin (3D-native anchored at creation). */
  addPin: (drop: PinDropTarget, detail: VerifyPinDetail) => Promise<VerifyCorrectionResult>
  /** Stage-4 · re-anchor an existing pin onto a (possibly different) surface. */
  movePin: (pinId: string, drop: PinDropTarget) => Promise<VerifyCorrectionResult>
  /** Undo the most recent verify edit (Stage-2/3/4). No-op when nothing to undo. */
  undoLastEdit: () => boolean
  /** True when there is at least one verify edit on the undo stack. */
  canUndo: boolean
  /**
   * Stage-5 · "Provider anfragen". Walks `customer_verify_state` to `approved`
   * (Block 3.12), then runs the host-supplied inquiry handler (the
   * `base_ready → inquiry_ready` flip + provider-discovery · Block 3.8).
   * Idempotent — a second call after a success is a no-op.
   */
  submitRequestProvider: () => Promise<VerifySubmitResult>
  /**
   * Stage-5 · "Erstmal speichern". Walks `customer_verify_state` to `approved`
   * without the inquiry flip — the scene stays `base_ready`. Idempotent.
   */
  submitSaveOnly: () => Promise<VerifySubmitResult>
}

/** Inputs to {@link useVerifyFlow}. */
export interface UseVerifyFlowOptions {
  /**
   * The canonical scene id — addresses the `spatial_edit_history` audit rows
   * AND the `spatial_scenes` verify-state columns. When absent the corrections
   * still apply + undo locally; the audit + verify-state persist is skipped
   * (bare-preview parity with `EditModeViewerHost`).
   */
  sceneId?: string | null
  /**
   * The persisted `customer_verify_last_stage` — drives the resume target on
   * mount (App-Kill / Re-Enter · Implementation-Spec §2.3).
   */
  lastStage?: number | null
  /**
   * The persisted `customer_verify_state` — gates the resume rule. An
   * `approved` scene re-opens fresh at Welcome.
   */
  verifyState?: CustomerVerifyState
  /**
   * Observation callback — fired whenever a verify-state transition is written
   * (the `not_started → in_progress` first-edit flip and the Stage-5 `approved`
   * confirm). A host can mirror the state into a projection; persistence itself
   * is already done by this hook via `persistVerifyState`.
   */
  onVerifyStateTransition?: (next: CustomerVerifyState) => void
  /**
   * Stage-5 "Provider anfragen" handler — the host wires the workflow-layer
   * `base_ready → inquiry_ready` FSM-flip + provider-discovery start here
   * (Block 3.8). Resolves to a success flag + German message. When omitted the
   * verify-state still moves to `approved` and the submit reports success
   * (bare-preview parity).
   */
  onRequestProvider?: () => Promise<{ ok: boolean; message?: string }>
  /**
   * Stage-5 submit hook for the VF-2 Re-Quote-Trigger. Fired AFTER the verify
   * is confirmed; the host runs `evaluateReQuoteTrigger` + `planMarkQuotesStale`
   * against the project's pending offers and flags them stale (Block 3.9).
   * Best-effort — a failure here never blocks the submit.
   */
  onConfirmReQuote?: (changeSummary: VerifyChangeSummary) => void | Promise<void>
}

/**
 * Drive the Customer-Verify-Flow for the VerifySheet container.
 */
export function useVerifyFlow(options: UseVerifyFlowOptions = {}): VerifyFlowApi {
  const {
    sceneId = null,
    lastStage = null,
    verifyState = 'not_started',
    onVerifyStateTransition,
    onRequestProvider,
    onConfirmReQuote,
  } = options

  const session = useSession()
  const baseScene = useCanonicalSceneStore((s) => s.scene)
  const resolved = useCanonicalSceneStore((s) => s.resolved)
  const apply = useEditHistoryStore((s) => s.apply)
  const undo = useEditHistoryStore((s) => s.undo)
  const canUndo = useEditHistoryStore((s) => s.canUndo)

  // Resume target is computed ONCE on mount — re-deriving it on every render
  // would yank the customer back to the resume stage after they navigate.
  const resumeStage = useMemo(
    () => resolveResumeStage(lastStage, verifyState),
    // Mount-stable inputs — recomputing would fight the live `stage` state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [stage, setStage] = useState<VerifyStage>(() => resumeStage)

  // The furthest stage the customer has legitimately reached this session
  // (F15 ordered-forward-progression invariant). It seeds from the resume
  // stage — a resume can never land past the furthest stage because the
  // resume value IS the persisted furthest stage. Navigation only ever
  // raises it; `goToStage` is clamped to it so a jump cannot skip ahead, and
  // the Stage-5 submit requires it to have actually reached Confirm.
  const furthestStageRef = useRef<VerifyStage>(resumeStage)

  // The verify-state flip is once-per-session: the first correction flips
  // `not_started → in_progress`; subsequent corrections must not re-fire it.
  const verifyStateRef = useRef<CustomerVerifyState>(verifyState)

  // Guards the Stage-5 submit against a double-tap reaching the FSM walk twice.
  const submittingRef = useRef(false)
  const submittedRef = useRef(false)

  // ── Mount · stamp customer_verify_last_active_at (Implementation-Spec §Stage-1)
  // Opening the sheet refreshes the VF-4 reminder anchor + the re-prompt copy.
  // Best-effort; fired once. A bare preview (`sceneId === null`) skips it.
  useEffect(() => {
    if (sceneId == null) return
    void touchVerifyActivity(
      { sceneId },
      resolveResumeStage(lastStage, verifyState),
    )
    // Intentionally mount-only — `sceneId` is stable for a sheet session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Commit a stage navigation: raise the furthest-reached marker and persist
   * the resume columns (F14 — pure navigation must persist `last_stage` /
   * `last_active_at`, not only edits). `customer_verify_last_stage` is stamped
   * with the FURTHEST stage so an App-Kill resume reflects the furthest-seen
   * stage and the F15 clamp holds. Best-effort — a bare preview (no scene id)
   * skips the write; a failed write never blocks navigation.
   */
  const commitStageNavigation = useCallback((target: VerifyStage) => {
    if (target > furthestStageRef.current) {
      furthestStageRef.current = target
    }
    if (sceneId) {
      // `null` target-state — navigation never moves the FSM column; it only
      // refreshes the resume anchor (`persistVerifyProgress` skips the FSM
      // write when the target is null).
      void persistVerifyProgress({ sceneId }, null, furthestStageRef.current)
    }
  }, [sceneId])

  const goToStage = useCallback((next: VerifyStage) => {
    // Ordered-forward-progression invariant (F15): a jump may revisit any
    // already-reached stage or step exactly one stage past the furthest, but
    // it can never skip ahead. A forward jump beyond `furthest + 1` is clamped
    // to the next legal stage so the customer cannot land at Confirm unseen.
    setStage((current) => {
      const maxReachable = computeNextStage(furthestStageRef.current) ?? furthestStageRef.current
      const clamped: VerifyStage = next > maxReachable ? maxReachable : next
      if (clamped === current) return current
      commitStageNavigation(clamped)
      return clamped
    })
  }, [commitStageNavigation])

  const goNext = useCallback(() => {
    setStage((current) => {
      const next = computeNextStage(current)
      if (next == null) return current
      commitStageNavigation(next)
      return next
    })
  }, [commitStageNavigation])

  const goPrev = useCallback(() => {
    setStage((current) => {
      const prev = computePrevStage(current)
      if (prev == null) return current
      // A back-step never lowers the furthest marker; `commitStageNavigation`
      // still refreshes `last_active_at` and re-stamps the furthest stage.
      commitStageNavigation(prev)
      return prev
    })
  }, [commitStageNavigation])

  const summary = useMemo(() => deriveVerifySceneSummary(resolved), [resolved])

  // Stage-5 change overview — base scene vs resolved scene. Survives an
  // App-Kill resume because it reads the persisted `customer_corrections`
  // override layer, not the ephemeral undo stack (Block 3.8).
  const changeSummary = useMemo(
    () => deriveVerifyChangeSummary(baseScene, resolved),
    [baseScene, resolved],
  )

  /**
   * Run a pre-built {@link BaseCommand} through the shared verify edit-pipeline:
   *   apply → constraint-gate → verify-state flip + persist → audit-persist.
   *
   * Every Stage-2/3/4 mutation funnels through here so the command stack, the
   * `not_started → in_progress` FSM flip, and the audit-append symmetry are
   * implemented in exactly ONE place. The command is already RBAC-gated by its
   * workflow build helper — this helper never targets a variant itself.
   */
  const runVerifyCommand = useCallback(
    async (command: BaseCommand): Promise<VerifyCorrectionResult> => {
      // Capture the override stack BEFORE the command for the audit hash.
      const overridesBefore = useCanonicalSceneStore.getState().overrides.slice()

      // Run through the Phase-2 command stack — the constraint validator gates
      // inside `apply()`. A hard-reject returns `applied:false`.
      const result = apply(command)
      if (!result.applied) {
        return { ok: false, hint: result.hint ?? result.error.message }
      }

      // customer_verify_state FSM — flip `not_started → in_progress` on the
      // first verify mutation. Once-per-session via the ref.
      let verifyStateTransition: CustomerVerifyState | null = null
      const transition = verifyStateAfterFirstEdit(verifyStateRef.current)
      if (transition) {
        verifyStateRef.current = transition
        verifyStateTransition = transition
        onVerifyStateTransition?.(transition)
      }

      // Persist the verify-state flip + the resume columns (Block 3.12). Always
      // touches `last_stage` / `_last_active_at` (resume anchor) even when no
      // FSM change is needed. `last_stage` is the FURTHEST reached stage (F14 /
      // F15) so an App-Kill resume never lands past it. Best-effort — a failure
      // never rolls back the local edit.
      if (sceneId) {
        void persistVerifyProgress({ sceneId }, transition, furthestStageRef.current)
      }

      // Persist the edit to the audit trail — best-effort. A persistence
      // failure does NOT roll back the local edit (persistEditCommand's
      // documented one-way symmetry); it is reported as a non-fatal warning.
      const warnings = result.warnings.map((w) => w.message)
      if (sceneId) {
        const overridesAfter = useCanonicalSceneStore.getState().overrides.slice()
        const persisted = await persistEditCommand(result.command, {
          sceneId,
          overridesBefore,
          overridesAfter,
        })
        if (!persisted.persisted) {
          warnings.push('Änderung übernommen — Verlauf konnte nicht gesichert werden.')
        }
      }

      return { ok: true, warnings, verifyStateTransition }
    },
    [apply, sceneId, onVerifyStateTransition],
  )

  const correctWallHeight = useCallback(
    async (wallId: string, newHeightM: number): Promise<VerifyCorrectionResult> => {
      if (!resolved) {
        return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      }
      const build = buildWallCorrectionCommand(
        toSpatialEditUser(session),
        resolved,
        wallId,
        newHeightM,
      )
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const deleteWall = useCallback(
    async (wallId: string): Promise<VerifyCorrectionResult> => {
      if (!resolved) return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      const build = buildWallDeleteCommand(toSpatialEditUser(session), resolved, wallId)
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const moveOpening = useCallback(
    async (openingId: string, newOffsetAlongWallM: number): Promise<VerifyCorrectionResult> => {
      if (!resolved) return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      const build = buildOpeningMoveCommand(
        toSpatialEditUser(session),
        resolved,
        openingId,
        newOffsetAlongWallM,
      )
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const addDoor = useCallback(
    async (wallId: string, offsetAlongWallM: number): Promise<VerifyCorrectionResult> => {
      if (!resolved) return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      const build = buildAddDoorCommand(
        toSpatialEditUser(session),
        resolved,
        wallId,
        offsetAlongWallM,
      )
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const addPin = useCallback(
    async (drop: PinDropTarget, detail: VerifyPinDetail): Promise<VerifyCorrectionResult> => {
      if (!resolved) return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      const user = toSpatialEditUser(session)
      const build = buildAddPinCommand(user, resolved, drop, detail, user.userId ?? 'unknown')
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const movePin = useCallback(
    async (pinId: string, drop: PinDropTarget): Promise<VerifyCorrectionResult> => {
      if (!resolved) return { ok: false, hint: 'Der Scan ist noch nicht geladen.' }
      const build = buildMovePinCommand(toSpatialEditUser(session), resolved, pinId, drop)
      if (!build.ok) return { ok: false, hint: build.hint }
      return runVerifyCommand(build.command)
    },
    [resolved, session, runVerifyCommand],
  )

  const undoLastEdit = useCallback((): boolean => {
    return undo() !== null
  }, [undo])

  /**
   * The shared Stage-5 submit pipeline (Block 3.8 / 3.12):
   *   1. multi-click guard — a second call while one runs, or after a success,
   *      is a no-op,
   *   2. walk `customer_verify_state` to `approved` (`persistVerifyConfirm` —
   *      it reads the current state + applies the legal FSM chain),
   *   3. for "Provider anfragen": run the host inquiry handler (the
   *      `base_ready → inquiry_ready` flip),
   *   4. fire the VF-2 Re-Quote hook (best-effort),
   *   5. emit the `approved` observation callback.
   *
   * NEVER throws — every failure is folded into the {@link VerifySubmitResult}.
   */
  const runSubmit = useCallback(
    async (
      kind: 'inquiry' | 'save',
    ): Promise<VerifySubmitResult> => {
      // Multi-click + double-submit guard. A re-tap after success is a no-op
      // success (the verify is already approved).
      if (submittedRef.current) {
        return {
          ok: true,
          message: kind === 'inquiry' ? 'Bereits an Provider gesendet.' : 'Bereits gespeichert.',
          verifyState: verifyStateRef.current,
        }
      }
      if (submittingRef.current) {
        return { ok: false, message: 'Wird bereits gesendet …', verifyState: null }
      }

      // Per-stage completion gate (F15): the submit is only legal once the
      // customer has actually progressed through the flow to the Confirm
      // stage. `furthestStageRef` only ever advances via ordered forward
      // navigation (`goNext` / a `goToStage` clamped to `furthest + 1`), so a
      // customer who only ever saw Welcome cannot reach an approved submit.
      if (furthestStageRef.current < VerifyStage.Confirm) {
        return {
          ok: false,
          message: 'Bitte erst alle Schritte durchgehen.',
          verifyState: null,
        }
      }

      submittingRef.current = true
      try {
        // Step 2 — walk customer_verify_state to `approved`. Skipped for a
        // bare preview (no scene id); the submit then relies on the host.
        let verifyStateLanded: CustomerVerifyState | null = verifyStateRef.current
        if (sceneId) {
          const confirmed = await persistVerifyConfirm({ sceneId })
          if (!confirmed.applied) {
            submittingRef.current = false
            return {
              ok: false,
              message: 'Verifizierung konnte nicht abgeschlossen werden.',
              verifyState: null,
            }
          }
          verifyStateLanded = confirmed.state
        } else {
          verifyStateLanded = 'approved'
        }
        verifyStateRef.current = verifyStateLanded

        // Step 3 — the inquiry flip runs only for "Provider anfragen".
        if (kind === 'inquiry' && onRequestProvider) {
          const inquiry = await onRequestProvider()
          if (!inquiry.ok) {
            // The verify is approved but the inquiry flip failed — the customer
            // can retry. Do NOT latch `submittedRef` so a retry is allowed.
            submittingRef.current = false
            return {
              ok: false,
              message: inquiry.message ?? 'Anfrage konnte nicht gestartet werden.',
              verifyState: verifyStateLanded,
            }
          }
        }

        // Step 4 — VF-2 Re-Quote hook. Best-effort: a failure here must not
        // fail the submit (the customer's verify is already confirmed). But a
        // silently-failed quote-stale-mark means a provider could quote against
        // stale room geometry — a money / trust bug — so the failure is routed
        // through `logError` + `recordPersistenceFailure` to stay observable.
        if (onConfirmReQuote) {
          try {
            await onConfirmReQuote(changeSummary)
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err))
            logError('workflow.spatial.verify_requote_failed', error, {
              sceneId: sceneId ?? 'bare-preview',
            })
            recordPersistenceFailure({
              domain: 'offers',
              operation: 'update',
              entityId: sceneId ?? 'verify-requote',
              error,
              occurredAt: Date.now(),
            })
          }
        }

        // Step 5 — emit the `approved` observation callback.
        if (verifyStateLanded === 'approved') {
          onVerifyStateTransition?.('approved')
        }

        submittedRef.current = true
        submittingRef.current = false
        return {
          ok: true,
          message:
            kind === 'inquiry'
              ? 'An Provider gesendet — du bekommst bald Angebote.'
              : 'Gespeichert. Du kannst später Provider anfragen.',
          verifyState: verifyStateLanded,
        }
      } catch {
        submittingRef.current = false
        return { ok: false, message: 'Senden nicht möglich.', verifyState: null }
      }
    },
    [sceneId, changeSummary, onRequestProvider, onConfirmReQuote, onVerifyStateTransition],
  )

  const submitRequestProvider = useCallback(
    () => runSubmit('inquiry'),
    [runSubmit],
  )
  const submitSaveOnly = useCallback(() => runSubmit('save'), [runSubmit])

  return useMemo(
    () => ({
      stage,
      goNext,
      goPrev,
      goToStage,
      summary,
      changeSummary,
      correctWallHeight,
      deleteWall,
      moveOpening,
      addDoor,
      addPin,
      movePin,
      undoLastEdit,
      canUndo,
      submitRequestProvider,
      submitSaveOnly,
    }),
    [
      stage,
      goNext,
      goPrev,
      goToStage,
      summary,
      changeSummary,
      correctWallHeight,
      deleteWall,
      moveOpening,
      addDoor,
      addPin,
      movePin,
      undoLastEdit,
      canUndo,
      submitRequestProvider,
      submitSaveOnly,
    ],
  )
}
