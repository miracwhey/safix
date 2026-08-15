/**
 * ProActionGuard — Block 6
 *
 * Wraps a pro action trigger and gates it based on subscription state.
 * State machine prevents re-entry / double-tap via phaseRef.
 *
 * Behavior by entitlement level:
 *   'full'        → execute action immediately
 *   'trial_start' → show TrialStartSheet, then execute on success
 *   'exception'   → execute action (caller verified thread/job context)
 *   'blocked'     → show UpgradeSheet
 *
 * For non-owner scope: passes through children unchanged (no gate).
 *
 * Usage:
 *   <ProActionGuard action="send_message" subscription={sub} onAction={handleSend}>
 *     {(guardedOnClick) => <button onClick={guardedOnClick}>Send</button>}
 *   </ProActionGuard>
 */

import { useCallback, useRef, useState } from 'react'
import {
  resolveActionEntitlement,
  type ProAction,
  type ActiveWorkContext,
  type EffectiveSubscriptionStatus,
  type SubscriptionScope,
  type EntitlementLevel,
} from '../../lib/subscription'
import { startTrial } from '../../lib/subscription/trialService'
import TrialStartSheet from './TrialStartSheet'
import UpgradeSheet from './UpgradeSheet'

type Phase = 'idle' | 'confirming' | 'starting_trial' | 'executing_action' | 'showing_upgrade'

// Programmatic counterpart for non-wrappable click targets:
// see `./useProActionGate`.

type Props = {
  action: ProAction
  effectiveState: EffectiveSubscriptionStatus | null
  scope: SubscriptionScope
  jobContext?: ActiveWorkContext
  onAction: () => void | Promise<void>
  onTrialStarted?: () => void
  children: (guardedOnClick: () => void, entitlement: EntitlementLevel | null) => React.ReactNode
}

export default function ProActionGuard({
  action,
  effectiveState,
  scope,
  jobContext,
  onAction,
  onTrialStarted,
  children,
}: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const [trialError, setTrialError] = useState<string | null>(null)

  // not_applicable = non-owner role, always passthrough.
  // owner + null effectiveState = subscription still loading → block action.
  const isNotApplicable = scope === 'not_applicable'
  const isOwnerLoading = scope === 'owner' && effectiveState === null
  const entitlement = isNotApplicable || isOwnerLoading
    ? null
    : resolveActionEntitlement(action, effectiveState!, jobContext)

  const setPhaseSync = (next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }

  const handleGuardedClick = useCallback(() => {
    // Non-owner — execute immediately
    if (isNotApplicable) {
      void onAction()
      return
    }
    // Owner subscription still loading — block silently
    if (isOwnerLoading) return

    // Re-entry prevention
    if (phaseRef.current !== 'idle') return

    if (!entitlement) return

    switch (entitlement.level) {
      case 'full':
      case 'exception':
        setPhaseSync('executing_action')
        try {
          const result = onAction()
          if (result instanceof Promise) {
            result.finally(() => setPhaseSync('idle'))
          } else {
            setPhaseSync('idle')
          }
        } catch {
          setPhaseSync('idle')
        }
        break

      case 'trial_start':
        setPhaseSync('confirming')
        break

      case 'blocked':
        setPhaseSync('showing_upgrade')
        break
    }
  }, [isNotApplicable, isOwnerLoading, entitlement, onAction])

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

      // Trial started — notify parent to refetch subscription, then execute action
      onTrialStarted?.()

      setPhaseSync('executing_action')
      try {
        const actionResult = onAction()
        if (actionResult instanceof Promise) {
          await actionResult
        }
      } finally {
        setPhaseSync('idle')
      }
    } catch (e) {
      setTrialError(e instanceof Error ? e.message : 'Technischer Fehler')
      setPhaseSync('confirming')
    }
  }, [onAction, onTrialStarted])

  const handleDismiss = useCallback(() => {
    setPhaseSync('idle')
    setTrialError(null)
  }, [])

  // Non-owner passthrough — no sheets, no gating
  if (isNotApplicable) {
    return <>{children(handleGuardedClick, null)}</>
  }

  // Owner loading — render children in blocked/disabled state
  if (isOwnerLoading) {
    return <>{children(() => {}, null)}</>
  }

  return (
    <>
      {children(handleGuardedClick, entitlement!.level)}

      {(phase === 'confirming' || phase === 'starting_trial') && (
        <TrialStartSheet
          isStarting={phase === 'starting_trial'}
          error={trialError}
          onConfirm={handleTrialConfirm}
          onDismiss={handleDismiss}
        />
      )}

      {phase === 'showing_upgrade' && (
        <UpgradeSheet onDismiss={handleDismiss} />
      )}
    </>
  )
}
