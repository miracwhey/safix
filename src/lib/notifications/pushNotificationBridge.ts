import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import type { Token, PushNotificationSchema, ActionPerformed } from '@capacitor/push-notifications'
import { logInfo, logError, logWarning } from '../observability'
import { supabase } from '../supabase'
import { pushRouteResolver } from './pushRouteResolver'
import type { PushRouteData } from './pushRoutes'
import * as pendingPushRoute from './pendingPushRoute'
import { tryNavigate } from './pushBridgeNavigationAdapter'
import {
  dispatchPushAction,
  type DispatcherSession,
  type PushActionData,
} from './pushActionDispatcher'
import { enqueuePendingAction } from './pendingPushAction'
import { emitFailureNotif } from './pushActionFeedback'
import { isPushActionId } from './pushActionRegistry'
import { recordPushActionAttempt } from './pushActionAudit'

/**
 * Liefert die Bridge bei jedem Action-Tap eine aktuelle Session, damit der
 * Dispatcher Role + Identity validieren kann ohne harten Import-Zyklus.
 * App.tsx setzt den Provider via `setBridgeSessionProvider` während des
 * Bootstrap.
 */
type SessionProvider = () => DispatcherSession | null
let sessionProvider: SessionProvider = () => null

export function setBridgeSessionProvider(provider: SessionProvider): void {
  sessionProvider = provider
}

let listenersAdded = false
let authReArmAttached = false
// Der Device-Token (APNs auf iOS, FCM auf Android) kann eintreffen BEVOR eine
// Session existiert (Boot ohne Login). Das 'registration'-Event feuert dann
// nicht erneut (Token ändert sich nicht), darum wird der letzte Token gecacht
// und beim nächsten SIGNED_IN nachgeschrieben.
let lastKnownToken: string | null = null

/**
 * Schreibt den Device-Token (APNs/iOS bzw. FCM/Android) für den aktuell
 * eingeloggten User. Idempotent (Upsert onConflict) — mehrfaches Schreiben
 * desselben Tokens ist harmlos. Die `platform`-Spalte trägt die reale
 * Plattform, damit der `notify-push`-Sender pro Token zwischen APNs und FCM
 * routen kann. Ohne Session wird verworfen und via `lastKnownToken` beim
 * SIGNED_IN nachgeholt (siehe `attachAuthReArm`).
 */
async function persistDeviceToken(tokenValue: string): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const userId = session?.user?.id
    if (!userId) {
      logWarning('push.registration.no_user_id')
      return
    }
    const { error } = await supabase
      .from('notification_device_tokens')
      .upsert(
        {
          user_id: userId,
          token: tokenValue,
          platform: Capacitor.getPlatform(),
          updated_at: Date.now(),
        },
        { onConflict: 'user_id,token' },
      )
    if (error) {
      logError('push.registration.token_save_failed', error, { userId })
    } else {
      logInfo('push.registration.token_saved', { userId })
    }
  } catch (err: unknown) {
    logError(
      'push.registration.token_save_error',
      err instanceof Error ? err : undefined,
      {},
    )
  }
}

/**
 * Re-Arm der Push-Registrierung an den Auth-Lifecycle (einmalig attached).
 * Deckt zwei Fälle ab, die der Boot-once-Aufruf allein nicht heilt:
 *   - Token kam vor dem Login an → beim SIGNED_IN den gecachten Token schreiben.
 *   - Listener wurden bei Sign-out abgebaut → beim nächsten SIGNED_IN die
 *     Registrierung nachziehen (register() liefert den Token erneut).
 */
function attachAuthReArm(): void {
  if (authReArmAttached) return
  authReArmAttached = true
  supabase.auth.onAuthStateChange((event) => {
    if (event !== 'SIGNED_IN') return
    if (!listenersAdded) {
      void registerForPushNotifications()
    } else if (lastKnownToken) {
      void persistDeviceToken(lastKnownToken)
    }
  })
}

/**
 * Registers the device for push notifications on native platforms.
 *
 * The `@capacitor/push-notifications` plugin abstracts the transport: on iOS
 * `register()` returns an APNs token, on Android an FCM token. The client flow
 * is identical — only the persisted `platform` differs, which the server uses
 * to route delivery (APNs vs FCM HTTP v1). Web has no native push and is a
 * no-op.
 *
 * Safe to call multiple times — subsequent calls are no-ops if listeners are
 * already registered.  All errors are caught internally so a failure here
 * never propagates to the bootstrap sequence.
 *
 * External requirements before delivery reaches a device:
 *   - iOS: APNs auth key uploaded (Apple Developer Portal) + APNS_* secrets.
 *   - Android: Firebase project's `google-services.json` bundled + the
 *     `FIREBASE_SERVICE_ACCOUNT` secret on the `notify-push` function.
 * This function prepares the complete client-side stack for both.
 */
export async function registerForPushNotifications(): Promise<void> {
  if (Capacitor.getPlatform() === 'web') return
  // Re-Arm unabhängig vom listeners-Latch aufsetzen, damit ein Login den Token
  // auch dann noch retten kann, wenn dieser Aufruf gleich als No-op zurückkehrt.
  attachAuthReArm()
  if (listenersAdded) return

  try {
    const { receive: status } = await PushNotifications.requestPermissions()
    if (status !== 'granted') {
      logWarning('push.registration.permission_denied', { status })
      return
    }

    // Attach listeners BEFORE register() — on iOS the system can fire the
    // 'registration' callback synchronously as a result of register(), so any
    // listener added afterward would miss the first token delivery.
    PushNotifications.addListener('registration', async (tokenPayload: Token) => {
      logInfo('push.registration.token_received', {
        platform: Capacitor.getPlatform(),
      })
      // Cache first: falls (noch) keine Session existiert, holt der SIGNED_IN
      // Re-Arm den Token hier ab und schreibt ihn nach dem Login.
      lastKnownToken = tokenPayload.value
      await persistDeviceToken(tokenPayload.value)
    })

    PushNotifications.addListener('registrationError', (err: unknown) => {
      logError(
        'push.registration.error',
        err instanceof Error ? err : new Error(String(err)),
        {},
      )
    })

    PushNotifications.addListener(
      'pushNotificationReceived',
      (notification: PushNotificationSchema) => {
        logInfo('push.notification.received_foreground', {
          title: notification.title,
          body: notification.body,
          data: notification.data,
        })
      },
    )

    PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (action: ActionPerformed) => {
        logInfo('push.notification.action_performed', {
          actionId: action.actionId,
          title: action.notification.title,
          data: action.notification.data,
        })
        // Block 7.2 / B2 — Default-Tap routing.
        //
        // Capacitor liefert `actionId === 'tap'` für jeden Default-Tap auf
        // die Notification (kein Inline-Action-Button).
        if (action.actionId === 'tap') {
          handlePushTapRoute(action.notification.data as unknown)
          return
        }

        // Block A2 — Inline-Action-Tap (APPROVE / REJECT auf Lockscreen).
        if (isPushActionId(action.actionId)) {
          void handlePushActionTap(
            action.actionId,
            action.notification.data as unknown,
          )
          return
        }

        // Unbekannter actionId → bewusst ignorieren (kein Crash, kein
        // silent-drop weil das initial logInfo am Anfang des Listeners die
        // Audit-Spur enthält).
      },
    )

    await PushNotifications.register()

    listenersAdded = true
    logInfo('push.registration.listeners_ready', {
      platform: Capacitor.getPlatform(),
    })
  } catch (err: unknown) {
    logError(
      'push.registration.setup_failed',
      err instanceof Error ? err : undefined,
      { platform: Capacitor.getPlatform() },
    )
  }
}

/**
 * Resolves the push payload's `data` block and either navigates immediately
 * (warm: React-Router is mounted via the navigation adapter) or queues the
 * route in `pendingPushRoute` so App.tsx's consume-hook can pick it up
 * after Session-Restore (cold-start, login-pending).
 *
 * Drops malformed / expired / unwhitelisted payloads silently in the
 * routing path — the listener-level logInfo above keeps the audit trail.
 * In Block A2 this gets richer Local-Notification feedback for action
 * pushes; for Block B2 (default-tap only) the silent drop is acceptable
 * because the Notification was already delivered to the user.
 */
export function handlePushTapRoute(data: unknown): void {
  // Capacitor liefert data als beliebiges Record — Resolver toleriert
  // null/undefined/non-object und liefert dann `{kind:'drop', reason:'malformed'}`.
  const resolution = pushRouteResolver(data as PushRouteData | null)

  if (resolution.kind === 'drop') {
    logWarning('push.tap.drop', { reason: resolution.reason })
    return
  }

  const navigated = tryNavigate(resolution.path, resolution.search, {
    replace: false,
  })

  if (navigated) {
    logInfo('push.tap.navigated_warm', {
      kind: resolution.kind,
      path: resolution.path,
      search: resolution.search,
      ...(resolution.kind === 'fallback' ? { reason: resolution.reason } : {}),
    })
    return
  }

  // Cold-start: React-Router noch nicht gemountet. Pending-Route wird vom
  // App.tsx-Hook konsumiert sobald Session-Restore + Bootstrap durch sind.
  pendingPushRoute.set({
    path: resolution.path,
    search: resolution.search,
  })
  logInfo('push.tap.queued_cold', {
    kind: resolution.kind,
    path: resolution.path,
    search: resolution.search,
    ...(resolution.kind === 'fallback' ? { reason: resolution.reason } : {}),
  })
}

/**
 * Block A2 — Inline-Action-Tap (APPROVE / REJECT) Handler.
 *
 * Lädt die aktuelle Session via `sessionProvider`, gibt sie dem
 * Dispatcher zur Validation, und führt das Outcome aus:
 *   - navigate_with_sheet → tryNavigate (warm) oder pendingPushRoute.set
 *     (cold) — Sheet mountet automatisch über `?action=`-Param
 *   - queue_for_auth → enqueuePendingAction + ggf. navigate('/login')
 *   - fallback → emitFailureNotif (außer duplicate_tap = silent), dann
 *     fallbackRoute oder Korrekturen-Liste
 *
 * Workflow-Aufruf passiert NICHT hier — der UI-Layer (Sheet-Submit) ruft
 * approveCorrectionWorkflow / rejectCorrectionWorkflow nach explizitem
 * User-Confirm. Bridge ist Routing-only.
 */
export async function handlePushActionTap(
  actionId: string,
  rawData: unknown,
): Promise<void> {
  const data = (rawData ?? null) as PushActionData | null
  const session = sessionProvider()
  const outcome = dispatchPushAction({ actionId, data, session })

  switch (outcome.kind) {
    case 'navigate_with_sheet': {
      // Block A · M1 — persistent idempotency layer above the in-memory 5 s
      // window in pushActionDispatcher. Uses `signalId`
      // (`notification_signals.id`) + `actionId` as the dedup key, recorded
      // via SECURITY DEFINER RPC. A re-tap from Notification Center after
      // app-kill is rejected here even when the module-scoped 5 s map has
      // been cleared. If signalId is missing (older backend before
      // migration 20260507000006), we fall back to the 5 s window only —
      // backwards-compat with mid-deploy clients.
      const signalId =
        typeof data?.signalId === 'string' && data.signalId.length > 0
          ? data.signalId
          : null
      if (signalId) {
        // Cold-Start-Hardening: bei einem Lockscreen-Action-Tap aus dem
        // Killed-State braucht der RPC eine restoredJWT (`auth.uid()`
        // server-side). `sessionProvider()` liest aus React-State, der
        // schneller mounted als der Supabase-Auth-Client hydratet. Ohne
        // diesen `getSession()` würde der erste Tap jedes Cold-Starts als
        // `unauthenticated` returnen → false → silent abort als "duplicate".
        try {
          await supabase.auth.getSession()
        } catch (err) {
          logWarning('push.action.session_restore_warn', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
        const recorded = await recordPushActionAttempt(signalId, actionId)
        if (!recorded) {
          logWarning('push.action.duplicate_persistent', { signalId, actionId })
          void emitFailureNotif({
            reason: 'duplicate_tap',
            action: isPushActionId(actionId) ? actionId : undefined,
            entityType:
              typeof data?.entityType === 'string' ? data.entityType : undefined,
            entityId:
              typeof data?.entityId === 'string' ? data.entityId : undefined,
          })
          return
        }
      }
      const navigated = tryNavigate(outcome.path, outcome.search, {
        replace: false,
      })
      if (!navigated) {
        pendingPushRoute.set({ path: outcome.path, search: outcome.search })
      }
      logInfo('push.action.dispatched', {
        actionId,
        path: outcome.path,
        sheet: outcome.sheet,
        warm: navigated,
      })
      return
    }
    case 'queue_for_auth': {
      try {
        await enqueuePendingAction(outcome.action)
      } catch (err) {
        logError(
          'push.action.queue_failed',
          err instanceof Error ? err : undefined,
          { actionId, entityId: outcome.action.entityId },
        )
      }
      // Falls App-Container noch ready ist, wechsel auf /login — sonst
      // läuft der Cold-Bootstrap-Flow ohnehin in Richtung Login.
      tryNavigate('/login', '', { replace: false })
      logInfo('push.action.queued_for_auth', {
        actionId,
        entityId: outcome.action.entityId,
      })
      return
    }
    case 'fallback': {
      void emitFailureNotif({
        reason: outcome.reason,
        action: isPushActionId(actionId) ? actionId : undefined,
        entityType:
          typeof data?.entityType === 'string' ? data.entityType : undefined,
        entityId:
          typeof data?.entityId === 'string' ? data.entityId : undefined,
      })
      const fallbackPath = outcome.fallbackRoute ?? '/craftsman/korrekturen'
      const navigated = tryNavigate(fallbackPath, '', { replace: false })
      if (!navigated) {
        pendingPushRoute.set({ path: fallbackPath, search: '' })
      }
      logWarning('push.action.fallback', {
        actionId,
        reason: outcome.reason,
        fallbackPath,
      })
      return
    }
  }
}

/**
 * Removes all push notification listeners and resets bridge state.
 * Primarily used during sign-out or testing.
 */
export async function stopPushNotificationListeners(): Promise<void> {
  if (!listenersAdded) return
  try {
    await PushNotifications.removeAllListeners()
    listenersAdded = false
  } catch (err: unknown) {
    logError(
      'push.registration.remove_listeners_failed',
      err instanceof Error ? err : undefined,
      {},
    )
  }
}
