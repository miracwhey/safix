/**
 * Pending-Push-Action Queue · Block A2
 *
 * IndexedDB-backed queue für Push-Actions, die nicht sofort ausgeführt werden
 * können (User tippt APPROVE/REJECT auf dem Lockscreen, App öffnet, aber
 * Session ist abgelaufen oder noch nicht restored).
 *
 * Im Unterschied zu `pendingPushRoute` (B2, in-memory):
 * - überlebt App-Kill (User loggt sich nach Kill neu ein → Action soll
 *   replay-bar sein)
 * - Pflicht-Bestätigung via `PushActionReplayModal` (kein Auto-Replay,
 *   weil Lockscreen-Versehen sonst silent durchläuft)
 * - max 10 Entries (älteste fliegt raus, wenn Queue voll)
 *
 * Atomicity: alle Mutationen laufen über `idb-keyval`'s read-modify-write
 * pattern. Parallel-enqueue ist sicher, weil idb-keyval intern einen Mutex
 * über das Object-Store-Lock hat.
 *
 * Cleanup: jeder Read filtert expired Entries (`expiresAt <= now`) raus —
 * keine separate Cron, kein Memory-Leak nach App-Kill ohne Read.
 */

import { get, set, del } from 'idb-keyval'

import type { PushActionId } from './pushActionRegistry'

const STORAGE_KEY = 'fixup.notifications.pending-push-actions:v1'
const MAX_QUEUE_SIZE = 10

/**
 * Action-Payload, der für späteren Replay persistiert wird. Enthält genug
 * Information, damit der Dispatcher die Validation-Chain erneut laufen
 * lassen kann — Workflow-Aufruf passiert NIE direkt aus dem Replay,
 * sondern immer über User-Confirm im `PushActionReplayModal`.
 */
export interface PendingPushAction {
  /** APPROVE oder REJECT — gespiegelt aus iOS Action-Identifier. */
  actionId: PushActionId
  /** Domain-Entity-Typ, z.B. 'correction'. */
  entityType: string
  /** Domain-Entity-ID, z.B. 'c-123'. */
  entityId: string
  /** Original-Action-Type aus Push-Payload, z.B. 'correction.submitted'. */
  actionType: string
  /** Erforderliche Top-Level-Rolle des Empfängers ('craftsman' | 'customer'). */
  roleTarget: string
  /** Erforderliche Sub-Rolle (für craftsman: 'owner' | 'worker'); optional. */
  craftsmanRoleTarget?: string | null
  /** Erwarteter Entity-Status zum Zeitpunkt der Action (gegen Stale-Mutation). */
  expectedStatus: string
  /** Ziel-Route (already validated against B1-Whitelist). */
  route: string
  /** Fallback-Route falls Replay scheitert. */
  fallbackRoute: string
  /** APNs-Schema-Version zum Push-Zeitpunkt. */
  actionVersion: number
  /** Zeitpunkt des Lockscreen-Taps (für UI-„vor X Min."-Hinweis). */
  enqueuedAt: number
  /** Action verfällt — älter als das = silent-drop beim Read. */
  expiresAt: number
}

async function readQueue(): Promise<PendingPushAction[]> {
  const raw = await get<unknown>(STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter(isPendingPushAction)
}

async function writeQueue(queue: PendingPushAction[]): Promise<void> {
  if (queue.length === 0) {
    await del(STORAGE_KEY)
    return
  }
  await set(STORAGE_KEY, queue)
}

function pruneExpired(queue: PendingPushAction[], now: number): PendingPushAction[] {
  return queue.filter((entry) => entry.expiresAt > now)
}

function enforceMaxSize(queue: PendingPushAction[]): PendingPushAction[] {
  if (queue.length <= MAX_QUEUE_SIZE) return queue
  // Älteste fliegt raus (FIFO-Drop).
  return queue.slice(queue.length - MAX_QUEUE_SIZE)
}

/**
 * Hängt eine Action an die Queue. Auto-Cleanup von expired Entries läuft
 * mit. Wenn die Queue nach Cleanup über MAX_QUEUE_SIZE liegen würde,
 * fliegen die ältesten raus.
 */
export async function enqueuePendingAction(
  action: PendingPushAction,
  now: number = Date.now(),
): Promise<void> {
  const existing = await readQueue()
  const pruned = pruneExpired(existing, now)
  const next = enforceMaxSize([...pruned, action])
  await writeQueue(next)
}

/**
 * Liest die älteste noch valide Action und entfernt sie atomar. Returnt
 * `null` wenn die Queue leer ist oder alle Entries expired sind.
 */
export async function dequeuePendingAction(
  now: number = Date.now(),
): Promise<PendingPushAction | null> {
  const existing = await readQueue()
  const pruned = pruneExpired(existing, now)
  if (pruned.length === 0) {
    if (existing.length > 0) {
      // Existing waren alle expired → Queue persistent leeren.
      await writeQueue([])
    }
    return null
  }
  const [head, ...rest] = pruned
  await writeQueue(rest)
  return head
}

/**
 * Liest alle nicht-expirierten Actions ohne sie zu konsumieren. Wird von
 * `PushActionReplayModal` genutzt, um zu entscheiden ob ein Replay-Hint
 * gerendert wird.
 */
export async function peekAllPendingActions(
  now: number = Date.now(),
): Promise<PendingPushAction[]> {
  const existing = await readQueue()
  return pruneExpired(existing, now)
}

/**
 * Verwirft die komplette Queue. User-Trigger: „Verwerfen" im Replay-Modal,
 * oder Test-Reset.
 */
export async function clearPendingActions(): Promise<void> {
  await writeQueue([])
}

function isPendingPushAction(value: unknown): value is PendingPushAction {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<PendingPushAction>
  return (
    (v.actionId === 'APPROVE' || v.actionId === 'REJECT') &&
    typeof v.entityType === 'string' &&
    typeof v.entityId === 'string' &&
    typeof v.actionType === 'string' &&
    typeof v.roleTarget === 'string' &&
    typeof v.expectedStatus === 'string' &&
    typeof v.route === 'string' &&
    typeof v.fallbackRoute === 'string' &&
    typeof v.actionVersion === 'number' &&
    typeof v.enqueuedAt === 'number' &&
    typeof v.expiresAt === 'number'
  )
}

/**
 * Test-only: garantiert leeren Queue-State, auch bei Mock-IDB-Mismatch.
 */
export async function __testOnly_resetQueue(): Promise<void> {
  await del(STORAGE_KEY)
}
