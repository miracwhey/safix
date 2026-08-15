/**
 * Push-Action Replay-Modal · Block A2/A3
 *
 * Wird in `App.tsx` nach Auth-Ready gemounted. Pollt `peekAllPendingActions`
 * (IndexedDB-Queue aus Layer 2). Zeigt ein Bestätigungs-Modal nur dann, wenn
 * der User vor dem aktuellen Login eine Push-Action getriggert hat (Lockscreen
 * APPROVE/REJECT, App killed bevor Login fertig).
 *
 * Sicherheits-Default: KEIN Auto-Replay. Selbst wenn der User sich gerade
 * eingeloggt hat — die Action war ein Lockscreen-Tap, der eventuell von einer
 * fremden Person kam (vor Face-ID gestoppt) oder versehentlich. Modal
 * verlangt explizites „Ja, fortsetzen".
 *
 * Verwerfen → `clearPendingActions` + Failure-Notif (replay_aborted, kein Body
 *   um nicht zu nerven).
 * Bestätigen → `dequeuePendingAction` → Dispatcher mit aktueller Session →
 *   navigate-with-sheet (Sheet auf KorrekturDetailScreen mountet automatisch).
 */
import { useEffect, useState } from 'react'

import {
  peekAllPendingActions,
  dequeuePendingAction,
  clearPendingActions,
  type PendingPushAction,
} from '../../lib/notifications/pendingPushAction'
import {
  dispatchPushAction,
  type DispatcherSession,
} from '../../lib/notifications/pushActionDispatcher'
import { emitFailureNotif } from '../../lib/notifications/pushActionFeedback'
import type { PushActionId } from '../../lib/notifications/pushActionRegistry'

const ACTION_LABELS: Record<PushActionId, string> = {
  APPROVE: 'annehmen',
  REJECT: 'ablehnen',
}

const ENTITY_LABELS: Record<string, string> = {
  correction: 'Korrektur',
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return 'gerade eben'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `vor ${minutes} Min.`
  const hours = Math.floor(minutes / 60)
  return `vor ${hours} Std.`
}

export interface PushActionReplayModalProps {
  /** Aktive Session — wird nach Auth-Ready aus session.ts gepasst. */
  session: DispatcherSession | null
  /** Navigate-Funktion vom React-Router-Adapter. */
  navigate: (path: string) => void
  /** Test-Hook: now-Override für deterministische „vor X Min." Anzeige. */
  now?: number
}

/**
 * Headless-Hook-Komponente: rendert das Modal nur, wenn die Queue gefüllt ist
 * UND der User eingeloggt ist. Sonst gibt sie `null` zurück (kein DOM, keine
 * unsichtbare Wrapper-Div).
 */
export default function PushActionReplayModal({
  session,
  navigate,
  now,
}: PushActionReplayModalProps) {
  const [pending, setPending] = useState<PendingPushAction | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  // Poll die Queue beim Auth-Ready-Switch + alle 30 s, damit ein nach dem
  // Login eintreffender Push (rare) auch gesehen wird.
  useEffect(() => {
    if (!session || session.userId === null) {
      setPending(null)
      return
    }
    let cancelled = false
    async function refresh() {
      const all = await peekAllPendingActions()
      if (cancelled) return
      setPending(all[0] ?? null)
    }
    refresh()
    const handle = setInterval(refresh, 30_000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [session])

  if (!session || session.userId === null) return null
  if (!pending) return null

  const entityLabel = ENTITY_LABELS[pending.entityType] ?? pending.entityType
  const actionLabel = ACTION_LABELS[pending.actionId]
  const relative = formatRelative((now ?? Date.now()) - pending.enqueuedAt)

  async function handleConfirm() {
    if (!pending) return
    setIsProcessing(true)
    try {
      const head = await dequeuePendingAction()
      if (!head) {
        setPending(null)
        return
      }
      const outcome = dispatchPushAction(
        {
          actionId: head.actionId,
          data: {
            route: head.route,
            fallbackRoute: head.fallbackRoute,
            actionVersion: head.actionVersion,
            expiresAt: head.expiresAt,
            actionType: head.actionType,
            entityType: head.entityType,
            entityId: head.entityId,
            roleTarget: head.roleTarget,
            craftsmanRoleTarget: head.craftsmanRoleTarget,
            expectedStatus: head.expectedStatus,
          },
          session,
        },
      )
      if (outcome.kind === 'navigate_with_sheet') {
        navigate(`${outcome.path}${outcome.search}`)
      } else if (outcome.kind === 'fallback') {
        await emitFailureNotif({
          reason: outcome.reason,
          entityType: head.entityType,
          entityId: head.entityId,
          action: head.actionId,
        })
        if (outcome.fallbackRoute) navigate(outcome.fallbackRoute)
      }
      setPending(null)
    } finally {
      setIsProcessing(false)
    }
  }

  async function handleDiscard() {
    setIsProcessing(true)
    try {
      await clearPendingActions()
      await emitFailureNotif({ reason: 'replay_aborted' })
      setPending(null)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div
      data-testid="push-action-replay-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="push-replay-title"
    >
      <div className="w-full max-w-[360px] rounded-[20px] bg-white px-5 py-5 shadow-[0_18px_44px_rgba(0,0,0,0.16)]">
        <h2
          id="push-replay-title"
          className="text-[17px] font-semibold text-slate-900"
        >
          Aktion fortsetzen?
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          {entityLabel} {pending.entityId} {actionLabel} — {relative} aus Push gestartet.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            data-testid="push-action-replay-confirm"
            onClick={handleConfirm}
            disabled={isProcessing}
            className="h-12 rounded-[14px] bg-emerald-600 text-white text-[15px] font-semibold disabled:opacity-50"
          >
            {isProcessing ? 'Wird geöffnet…' : 'Ja, fortsetzen'}
          </button>
          <button
            type="button"
            data-testid="push-action-replay-discard"
            onClick={handleDiscard}
            disabled={isProcessing}
            className="h-12 rounded-[14px] bg-slate-100 text-slate-700 text-[15px] font-medium disabled:opacity-50"
          >
            Verwerfen
          </button>
        </div>
      </div>
    </div>
  )
}
