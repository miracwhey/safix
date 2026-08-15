/**
 * Push-Action Feedback · Block A3
 *
 * Emittiert Local-Notifications nach Workflow-Run, damit der User
 * unabhängig von der App-Sicht sieht, dass seine Aktion durchging
 * (oder warum nicht).
 *
 * Warum Local-Notif statt nur In-App-Card?
 * - User taped APPROVE auf Lockscreen → App öffnet → Confirm-Sheet → confirmt
 * - direkt danach swipt der User die App weg, geht zurück zur Notif-Center
 * - Local-Notif ist die einzige verlässliche Bestätigung „durchgegangen"
 * - Keine Push-Loop nötig (Server-Bestätigung kommt async, kann sekundenlang
 *   dauern)
 *
 * Plugin: `@capacitor/local-notifications` (in #837 installiert).
 *
 * Sicherheits-Default: jedes Failure mit user-readable reason. Kein
 * silent-drop.
 *
 * Dedup: in-memory `Set<string>` per (entityId, action, resultKind), TTL
 * 30 s. Verhindert dass Workflow-Retries 2 Notifs für gleiche Action
 * triggern.
 */

import { LocalNotifications } from '@capacitor/local-notifications'

import type { PushActionId } from './pushActionRegistry'
import type { DispatcherFallbackReason } from './pushActionDispatcher'
import { logError } from '../observability'

const DEDUP_WINDOW_MS = 30_000

const recent = new Map<string, number>()

function dedupKey(parts: string[]): string {
  return parts.join('|')
}

function recentlyEmitted(key: string, now: number): boolean {
  const last = recent.get(key)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return true
  recent.set(key, now)
  for (const [k, ts] of recent) {
    if (now - ts >= DEDUP_WINDOW_MS) recent.delete(k)
  }
  return false
}

function nextNotificationId(): number {
  // Capacitor benötigt int32. Nehme einen 28-bit-Counter, damit auch nach
  // tagelanger Session keine Kollisionen entstehen.
  return ((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0xffffff)) >>> 0
}

async function safeSchedule(notification: {
  title: string
  body: string
  id: number
}): Promise<void> {
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: notification.title,
          body: notification.body,
          id: notification.id,
          // Sofort feuern — `schedule.at` weglassen heißt fire ASAP.
        },
      ],
    })
  } catch (error) {
    // Plugin nicht verfügbar (Web-Build, Test-Env) oder Permission revoked:
    // sichtbares Log statt Crash. Caller soll trotzdem in-app feedback
    // rendern.
    logError('notifications.local_notification_failed', error, {
      scope: 'push-action-feedback',
      title: notification.title,
    })
  }
}

// ── Success ──────────────────────────────────────────────────────────────────

export interface SuccessNotifInput {
  entityType: string
  entityId: string
  action: PushActionId
}

const SUCCESS_TITLES: Record<string, Record<PushActionId, string>> = {
  correction: {
    APPROVE: 'Korrektur angenommen',
    REJECT: 'Korrektur abgelehnt',
  },
}

const SUCCESS_BODIES: Record<string, Record<PushActionId, string>> = {
  correction: {
    APPROVE: 'Der Vorschlag wurde übernommen.',
    REJECT: 'Du hast den Vorschlag mit Begründung abgelehnt.',
  },
}

export async function emitSuccessNotif(
  input: SuccessNotifInput,
  options: { now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now()
  const key = dedupKey(['success', input.entityType, input.entityId, input.action])
  if (recentlyEmitted(key, now)) return

  const titles = SUCCESS_TITLES[input.entityType]
  const bodies = SUCCESS_BODIES[input.entityType]
  const title = titles?.[input.action] ?? 'Aktion erfolgreich'
  const body = bodies?.[input.action] ?? 'Die Aktion wurde verarbeitet.'

  await safeSchedule({ title, body, id: nextNotificationId() })
}

// ── Failure ──────────────────────────────────────────────────────────────────

export interface FailureNotifInput {
  reason: DispatcherFallbackReason | 'workflow_failed' | 'replay_aborted'
  entityType?: string
  entityId?: string
  action?: PushActionId
}

const FAILURE_BODIES: Record<FailureNotifInput['reason'], string> = {
  malformed: 'App öffnen — Aktion konnte nicht verarbeitet werden.',
  unknown_action_id: 'App öffnen — unbekannter Aktions-Typ.',
  unknown_version: 'App-Update verfügbar. App öffnen für aktuellen Stand.',
  expired: 'Veraltete Aktion. App öffnen für aktuellen Stand.',
  role_mismatch: 'Konto wechseln — die Aktion war für ein anderes Konto.',
  duplicate_tap: '',
  no_route: 'App öffnen — Ziel nicht erreichbar.',
  workflow_failed: 'App öffnen — Aktion konnte nicht ausgeführt werden.',
  replay_aborted: 'Aktion wurde nicht ausgeführt.',
}

export async function emitFailureNotif(
  input: FailureNotifInput,
  options: { now?: number } = {},
): Promise<void> {
  const body = FAILURE_BODIES[input.reason]
  // Kein Body = bewusst silent (z.B. duplicate_tap — User hat es eh gerade
  // selbst getriggert, doppelt-Notif wäre Lärm).
  if (!body) return

  const now = options.now ?? Date.now()
  const key = dedupKey([
    'failure',
    input.reason,
    input.entityType ?? '-',
    input.entityId ?? '-',
    input.action ?? '-',
  ])
  if (recentlyEmitted(key, now)) return

  await safeSchedule({
    title: 'Aktion nicht ausgeführt',
    body,
    id: nextNotificationId(),
  })
}

// ── Test-only ────────────────────────────────────────────────────────────────

export function __testOnly_resetFeedbackDedup(): void {
  recent.clear()
}
