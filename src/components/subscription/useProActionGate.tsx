/**
 * useProActionGate — Block 6 programmatic counterpart of `<ProActionGuard>`.
 *
 * For composers / picker UIs (e.g. ChatComposer) whose internal click
 * targets can't be wrapped via render-prop, this hook exposes the same
 * state-machine + modals through an awaitable gate function.
 *
 * Behavior by entitlement level (mirrors ProActionGuard.tsx):
 *   'full' | 'exception'  → gate resolves true immediately
 *   'trial_start'         → shows TrialStartSheet; resolves true after
 *                           successful trial start, false on dismiss
 *   'blocked'             → shows UpgradeSheet; resolves false on dismiss
 *   non-owner             → gate resolves true (passthrough)
 *   owner-loading         → gate resolves false (block silently)
 *   re-entry              → gate resolves false (modal already open)
 *
 * Usage:
 *   const sendGate = useProActionGate({
 *     action: 'send_message',
 *     effectiveState: sub.effectiveState,
 *     scope: sub.scope,
 *     jobContext,
 *     onTrialStarted: sub.refetch,
 *   })
 *   // In a callback:
 *   const ok = await sendGate.gate()
 *   if (!ok) return
 *   // …proceed with the action
 *   // Render once inside the tree:
 *   {sendGate.modals}
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'
import {
  resolveActionEntitlement,
  isFreeAction,
  type ProAction,
  type ActiveWorkContext,
  type EffectiveSubscriptionStatus,
  type SubscriptionScope,
  type EntitlementLevel,
} from '../../lib/subscription'
import { startTrial } from '../../lib/subscription/trialService'
import TrialStartSheet from './TrialStartSheet'
import UpgradeSheet from './UpgradeSheet'

type Phase = 'idle' | 'confirming' | 'starting_trial' | 'showing_upgrade'

type GateProps = {
  action: ProAction
  effectiveState: EffectiveSubscriptionStatus | null
  scope: SubscriptionScope
  jobContext?: ActiveWorkContext
  onTrialStarted?: () => void
}

export type ProActionGate = {
  entitlement: EntitlementLevel | null
  /** Programmatic gate. Resolves true on permit, false on deny / dismiss. */
  gate: () => Promise<boolean>
  /** Modal portal JSX. Render once inside the component tree. */
  modals: ReactNode
}

export function useProActionGate({
  action,
  effectiveState,
  scope,
  jobContext,
  onTrialStarted,
}: GateProps): ProActionGate {
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const [trialError, setTrialError] = useState<string | null>(null)
  const pendingResolverRef = useRef<((permitted: boolean) => void) | null>(null)

  const isNotApplicable = scope === 'not_applicable'
  const isOwnerLoading = scope === 'owner' && effectiveState === null
  const entitlement = isNotApplicable || isOwnerLoading
    ? null
    : resolveActionEntitlement(action, effectiveState!, jobContext)

  const setPhaseSync = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const gate = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // Free earning-loop actions (send_message, open_quote_composer, …) are
      // NEVER gated — resolved before the owner-loading guard. Without this a
      // craftsman owner whose craftsman_subscriptions row is still loading (or
      // permanently null after a failed fetch) had every send/photo/voice
      // silently swallowed by isOwnerLoading → resolve(false). The guard below
      // exists only for genuinely Pro actions.
      if (isFreeAction(action)) {
        resolve(true)
        return
      }
      if (isNotApplicable) {
        resolve(true)
        return
      }
      if (isOwnerLoading) {
        resolve(false)
        return
      }
      if (phaseRef.current !== 'idle') {
        resolve(false)
        return
      }
      if (!entitlement) {
        resolve(false)
        return
      }
      switch (entitlement.level) {
        case 'full':
        case 'exception':
          resolve(true)
          return
        case 'trial_start':
          pendingResolverRef.current = resolve
          setPhaseSync('confirming')
          return
        case 'blocked':
          pendingResolverRef.current = resolve
          setPhaseSync('showing_upgrade')
          return
      }
    })
  }, [action, isNotApplicable, isOwnerLoading, entitlement, setPhaseSync])

  const handleTrialConfirm = useCallback(async () => {
    if (phaseRef.current !== 'confirming') return
    setPhaseSync('starting_trial')
    setTrialError(null)
    try {
      const result = await startTrial()
      if (!result.ok) {
        setTrialError(
          result.error === 'trial_already_used'
            ? 'Du hast den Testzeitraum bereits genutzt.'
            : result.error === 'invalid_state'
              ? 'Trial kann in diesem Zustand nicht gestartet werden.'
              : 'Trial konnte nicht gestartet werden.',
        )
        setPhaseSync('confirming')
        return
      }
      onTrialStarted?.()
      const resolver = pendingResolverRef.current
      pendingResolverRef.current = null
      setPhaseSync('idle')
      resolver?.(true)
    } catch (e) {
      setTrialError(e instanceof Error ? e.message : 'Technischer Fehler')
      setPhaseSync('confirming')
    }
  }, [onTrialStarted, setPhaseSync])

  const handleDismiss = useCallback(() => {
    setPhaseSync('idle')
    setTrialError(null)
    const resolver = pendingResolverRef.current
    pendingResolverRef.current = null
    resolver?.(false)
  }, [setPhaseSync])

  const modals = (
    <>
      {(phase === 'confirming' || phase === 'starting_trial') && (
        <TrialStartSheet
          isStarting={phase === 'starting_trial'}
          error={trialError}
          onConfirm={handleTrialConfirm}
          onDismiss={handleDismiss}
        />
      )}
      {phase === 'showing_upgrade' && <UpgradeSheet onDismiss={handleDismiss} />}
    </>
  )

  return {
    entitlement: entitlement?.level ?? null,
    gate,
    modals,
  }
}
