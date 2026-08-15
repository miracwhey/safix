/**
 * Push-Action Dispatcher · Block A2
 *
 * Pure Funktion: nimmt einen Push-Action-Tap (`actionId` aus
 * `pushNotificationActionPerformed`-Listener), validiert ihn gegen Schema-
 * Version, Expiry, Session-Role und Idempotenz, und liefert ein
 * discriminated-union-Outcome zurück.
 *
 * Keine Side-Effects, kein React-Router-Import, kein IndexedDB-Touch — der
 * Dispatcher entscheidet WAS passieren soll, der Caller (Bridge in Layer 4)
 * führt es aus. Idempotenz-State ist module-scoped, damit Doppel-Tap aus
 * dem iOS-Notification-Center innerhalb von 5 s als no-op behandelt werden
 * kann.
 *
 * Validation-Reihenfolge fest (jeder Fail → fallback oder queue, nie throw):
 *   1. Payload existiert + ist Objekt
 *   2. `actionId` ∈ {APPROVE, REJECT}
 *   3. `actionVersion` matcht `PUSH_ROUTE_SCHEMA_VERSION`
 *   4. `expiresAt > now`
 *   5. Session vorhanden (sonst → queue_for_auth)
 *   6. Session-Role matcht `roleTarget` (+ optional `craftsmanRoleTarget`)
 *   7. Idempotenz: gleiches `entityId+actionId` innerhalb 5 s = duplicate
 *   8. Route ist in `PUSH_ROUTE_WHITELIST`
 *   → navigate_with_sheet liefert die Ziel-Route + welches Sheet zu mounten ist
 *
 * Workflow-Aufruf (approve/reject) passiert NIE im Dispatcher — der UI-Layer
 * (Sheets in Layer 3) ruft die Domain-Workflows nach explizitem User-Confirm.
 */

import { isWhitelistedRoute, PUSH_ROUTE_SCHEMA_VERSION } from './pushRoutes'
import type { PendingPushAction } from './pendingPushAction'
import { isPushActionId, type PushActionId } from './pushActionRegistry'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Action-Payload aus dem APNs-Push (`data`-Feld). Spiegelt das Schema, das
 * der Server (Block B3 + Action-Erweiterung) liefert.
 */
export interface PushActionData {
  // B1/B3 routing
  route?: string | null
  fallbackRoute?: string | null
  focus?: string | null
  actionVersion?: number | null
  expiresAt?: number | null
  // Action-Identifikation (Block A)
  actionType?: string | null
  entityType?: string | null
  entityId?: string | null
  categoryId?: string | null
  // Sicherheit
  roleTarget?: string | null
  craftsmanRoleTarget?: string | null
  expectedStatus?: string | null
  requiresConfirmation?: boolean | null
  createdAt?: number | null
  // Block A · M1 — `notification_signals.id` (uuid). Wird vom Trigger in
  // `data.signalId` gesetzt. Bridge nutzt es als persistent-Idempotenz-Key
  // im `record_push_action_attempt` RPC. Optional: alte Backend-Versionen
  // setzen es nicht — Bridge fällt dann auf reine 5 s-Module-Idempotenz
  // zurück (backwards-compat).
  signalId?: string | null
}

/**
 * Slim subset of `SessionState` — Dispatcher braucht nur Identität + Rolle.
 * Vermeidet harten Import-Zyklus mit `src/lib/session.ts`.
 */
export interface DispatcherSession {
  userId: string | null
  role: string | null
  craftsmanRole?: string | null
}

export type DispatcherFallbackReason =
  | 'malformed'
  | 'unknown_action_id'
  | 'unknown_version'
  | 'expired'
  | 'role_mismatch'
  | 'duplicate_tap'
  | 'no_route'

export type DispatcherOutcome =
  | {
      kind: 'navigate_with_sheet'
      path: string
      search: string
      sheet: 'approve_confirm' | 'reject_reason'
    }
  | {
      kind: 'queue_for_auth'
      action: PendingPushAction
    }
  | {
      kind: 'fallback'
      reason: DispatcherFallbackReason
      fallbackRoute: string | null
    }

export interface DispatcherInput {
  actionId: string
  data: PushActionData | null | undefined
  session: DispatcherSession | null
}

export interface DispatcherOptions {
  /** Injizierbarer Zeitstempel — Default `Date.now()`. */
  now?: number
}

// ── Idempotenz ───────────────────────────────────────────────────────────────

const IDEMPOTENCY_WINDOW_MS = 5_000

const recentTaps = new Map<string, number>()

function idempotencyKey(entityId: string, actionId: PushActionId): string {
  return `${actionId}:${entityId}`
}

function isDuplicateTap(entityId: string, actionId: PushActionId, now: number): boolean {
  const key = idempotencyKey(entityId, actionId)
  const last = recentTaps.get(key)
  if (last !== undefined && now - last < IDEMPOTENCY_WINDOW_MS) {
    return true
  }
  recentTaps.set(key, now)
  // Light cleanup — entferne Einträge, die garantiert außerhalb des Windows sind.
  for (const [k, ts] of recentTaps) {
    if (now - ts >= IDEMPOTENCY_WINDOW_MS) recentTaps.delete(k)
  }
  return false
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export function dispatchPushAction(
  input: DispatcherInput,
  options: DispatcherOptions = {},
): DispatcherOutcome {
  const now = options.now ?? Date.now()
  const data = input.data
  const fallbackRoute =
    typeof data?.fallbackRoute === 'string' && data.fallbackRoute.length > 0
      ? data.fallbackRoute
      : null

  // 1. Payload-Shape
  if (data === null || data === undefined || typeof data !== 'object') {
    return { kind: 'fallback', reason: 'malformed', fallbackRoute: null }
  }

  // 2. Action-ID
  if (!isPushActionId(input.actionId)) {
    return { kind: 'fallback', reason: 'unknown_action_id', fallbackRoute }
  }
  const actionId: PushActionId = input.actionId

  // 3. Schema-Version
  if (
    typeof data.actionVersion !== 'number' ||
    data.actionVersion !== PUSH_ROUTE_SCHEMA_VERSION
  ) {
    return { kind: 'fallback', reason: 'unknown_version', fallbackRoute }
  }

  // 4. Expiry
  if (typeof data.expiresAt !== 'number' || data.expiresAt <= now) {
    return { kind: 'fallback', reason: 'expired', fallbackRoute }
  }

  // 5/8. Required identification fields (für queue UND navigate)
  if (
    typeof data.entityId !== 'string' ||
    data.entityId.length === 0 ||
    typeof data.entityType !== 'string' ||
    data.entityType.length === 0 ||
    typeof data.actionType !== 'string' ||
    typeof data.roleTarget !== 'string' ||
    data.roleTarget.length === 0 ||
    typeof data.expectedStatus !== 'string' ||
    typeof data.route !== 'string' ||
    data.route.length === 0
  ) {
    return { kind: 'fallback', reason: 'malformed', fallbackRoute }
  }

  const { path: routePath } = splitRoute(data.route)
  if (!isWhitelistedRoute(routePath)) {
    return { kind: 'fallback', reason: 'no_route', fallbackRoute }
  }

  // 5. Session
  if (input.session === null || input.session.userId === null) {
    const action: PendingPushAction = {
      actionId,
      actionType: data.actionType,
      entityType: data.entityType,
      entityId: data.entityId,
      roleTarget: data.roleTarget,
      craftsmanRoleTarget:
        typeof data.craftsmanRoleTarget === 'string' ? data.craftsmanRoleTarget : null,
      expectedStatus: data.expectedStatus,
      route: data.route,
      fallbackRoute: fallbackRoute ?? data.route,
      actionVersion: data.actionVersion,
      enqueuedAt: now,
      expiresAt: data.expiresAt,
    }
    return { kind: 'queue_for_auth', action }
  }

  // 6. Role
  if (input.session.role !== data.roleTarget) {
    return { kind: 'fallback', reason: 'role_mismatch', fallbackRoute }
  }
  if (
    typeof data.craftsmanRoleTarget === 'string' &&
    data.craftsmanRoleTarget.length > 0 &&
    input.session.craftsmanRole !== data.craftsmanRoleTarget
  ) {
    return { kind: 'fallback', reason: 'role_mismatch', fallbackRoute }
  }

  // 7. Idempotenz
  if (isDuplicateTap(data.entityId, actionId, now)) {
    return { kind: 'fallback', reason: 'duplicate_tap', fallbackRoute: data.route }
  }

  // 8. Build navigate-with-sheet outcome
  const sheet: 'approve_confirm' | 'reject_reason' =
    actionId === 'APPROVE' ? 'approve_confirm' : 'reject_reason'
  const sheetParam = actionId === 'APPROVE' ? 'approve' : 'reject'
  const { path, search } = appendActionParam(data.route, sheetParam)
  return { kind: 'navigate_with_sheet', path, search, sheet }
}

function splitRoute(route: string): { path: string; search: string } {
  const hashIdx = route.indexOf('#')
  const trimmed = hashIdx >= 0 ? route.slice(0, hashIdx) : route
  const queryIdx = trimmed.indexOf('?')
  if (queryIdx < 0) return { path: trimmed, search: '' }
  return { path: trimmed.slice(0, queryIdx), search: trimmed.slice(queryIdx) }
}

function appendActionParam(route: string, action: string): { path: string; search: string } {
  const { path, search } = splitRoute(route)
  if (search.length === 0) return { path, search: `?action=${action}` }
  return { path, search: `${search}&action=${action}` }
}

/**
 * Test-only: Idempotenz-Map leeren. Verhindert Cross-Test-Kontamination.
 */
export function __testOnly_resetIdempotency(): void {
  recentTaps.clear()
}
