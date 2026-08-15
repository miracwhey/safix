/**
 * Spatial · Workflow · Verify-Reminder (Phase 3 · Block 3.11 · VF-4)
 *
 * The pure decision layer for the Customer-Verify reminder cadence
 * (Implementation-Spec §3 VF-4): a customer who skipped or abandoned the
 * verify flow is nudged
 *
 *   - after 24 h with a PUSH notification, then
 *   - after 72 h with an EMAIL fallback,
 *
 * both measured from `customer_verify_last_active_at` (the last sheet-open or
 * stage mutation · `spatial_scenes` column, migration 20260520120040).
 *
 * ── De-dup (binding · Implementation-Spec §3.11) ────────────────────────────
 * The cadence is time-driven, so an hourly cron would re-fire the SAME channel
 * on every run for the whole 24h-72h push window (and again for the post-72h
 * email window). The de-dup state lives on two `spatial_scenes` columns
 * (migration 20260520120040): `customer_verify_last_reminder_sent_at` +
 * `customer_verify_last_reminder_channel`. {@link resolveVerifyReminderChannel}
 * takes that state and returns `none` for a channel that was already sent for
 * the current activity anchor — a push is sent ONCE, the email escalation is
 * sent ONCE, and customer activity newer than the last reminder resets both.
 *
 * ── Layer (binding · SaFix architecture rule) ───────────────────────────────
 * PURE workflow logic — no React, no zustand, no DB, no scheduler. Deterministic
 * over `(verifyState, lastActiveAtMs, nowMs)`. This module DECIDES which
 * reminder is due and produces the {@link VerifyReminderSignal} payload; it
 * does NOT send anything and it does NOT schedule anything.
 *
 * ── External step (NOT in this block · Implementation-Spec §3.11) ───────────
 * The time-driven trigger — the cron / Edge-Function that periodically scans
 * `spatial_scenes` for due reminders and calls a notification route — is an
 * EXTERNAL step. Phase 1-4 run on the InMemory repository; nothing is deployed
 * here. This module is the logic that such a job would call per scene.
 *
 * ── Recipient gating ────────────────────────────────────────────────────────
 * A reminder is only ever due while the verify is genuinely UNFINISHED:
 *   - `not_started` — the customer skipped Stage 1 outright,
 *   - `in_progress` — the customer started Stages 2-4 then left.
 * An `approved` scene (verify completed) or a `rejected` / `expired` scene
 * never gets a reminder — there is nothing to nudge.
 */

import type { CustomerVerifyState } from '../canonical/repository/spatialSceneFsm'

// ─────────────────────────────────────────────────────────────────────────────
// VF-4 cadence
// ─────────────────────────────────────────────────────────────────────────────

/** Hours after last verify activity at which the PUSH reminder becomes due. */
export const VERIFY_REMINDER_PUSH_HOURS = 24

/** Hours after last verify activity at which the EMAIL fallback becomes due. */
export const VERIFY_REMINDER_EMAIL_HOURS = 72

const HOUR_MS = 60 * 60 * 1000

/** The PUSH-due threshold in milliseconds. */
export const VERIFY_REMINDER_PUSH_MS = VERIFY_REMINDER_PUSH_HOURS * HOUR_MS

/** The EMAIL-due threshold in milliseconds. */
export const VERIFY_REMINDER_EMAIL_MS = VERIFY_REMINDER_EMAIL_HOURS * HOUR_MS

/** Which reminder channel is due for a scene right now. */
export type VerifyReminderChannel =
  /** No reminder due — too soon, the verify is finished, or already sent. */
  | 'none'
  /** The 24 h push reminder is due (and the 72 h email is not yet). */
  | 'push'
  /** The 72 h email fallback is due. */
  | 'email'

/**
 * The de-dup state for a scene's verify-reminder — the
 * `customer_verify_last_reminder_*` columns (migration 20260520120040)
 * converted to TS. Passed to {@link resolveVerifyReminderChannel} so an
 * hourly cron does not re-fire an already-sent channel.
 *
 * `null` (the default) means "no reminder ever sent" — the resolver then
 * behaves purely time-driven, exactly as before the de-dup landed.
 */
export interface VerifyReminderDedupState {
  /** Unix-ms of the last reminder sent for this scene (`…_last_reminder_sent_at`). */
  lastReminderSentAtMs: number | null
  /** Channel of the last reminder sent (`…_last_reminder_channel`). */
  lastReminderChannel: 'push' | 'email' | null
}

/**
 * The signal a due reminder produces — handed to SaFix's notification system
 * by the (external) scheduler. It is intentionally channel-tagged so the
 * notification layer routes a `push` signal to the push pipeline and an
 * `email` signal to the email-fallback template.
 *
 * `route` is the deep-link the notification opens — the verify-flow-spec §5
 * Customer-Verify route (NOT the stale cross-domain §7 enum · see
 * Implementation-Spec §6 #5).
 */
export interface VerifyReminderSignal {
  /** The scene the reminder is about (`spatial_scenes.id`). */
  sceneId: string
  /** The project the verify belongs to — addresses the route. */
  projectId: string
  /** Which channel to deliver on. */
  channel: 'push' | 'email'
  /** German notification title. */
  title: string
  /** German notification body. */
  body: string
  /** Deep-link route — verify-flow-spec §5. */
  route: string
  /** The `customer_verify_state` at the time the reminder fired. */
  verifyState: CustomerVerifyState
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `true` when a verify-state still has unfinished work worth a reminder.
 * `not_started` (skipped Stage 1) and `in_progress` (abandoned mid-flow)
 * qualify; every terminal state does not.
 */
export function isVerifyReminderEligible(state: CustomerVerifyState): boolean {
  return state === 'not_started' || state === 'in_progress'
}

/**
 * `true` when a prior reminder on `channel` already covers the channel now due
 * — i.e. the cron must NOT re-fire it. A reminder de-dups only while it is
 * still fresh relative to the customer's activity: if the customer became
 * active AFTER the reminder was sent, the prior reminder is stale and the
 * cadence restarts (a fresh push becomes due again).
 *
 * `dueChannel` is the time-driven channel ('push' or 'email'). The rules:
 *   - no prior reminder (`null` state)        → never a duplicate.
 *   - prior reminder older than last activity → stale → never a duplicate.
 *   - prior `push`, due `push`                → duplicate (push sent once).
 *   - prior `email`, due `email`              → duplicate (email sent once).
 *   - prior `push`, due `email`               → NOT a duplicate (72h escalation).
 *   - prior `email`, due `push`               → NOT a duplicate (cannot happen
 *     for a fixed anchor, but a fresh push after re-activity is still allowed).
 */
function reminderAlreadySent(
  dueChannel: 'push' | 'email',
  lastActiveAtMs: number,
  dedup: VerifyReminderDedupState,
): boolean {
  const { lastReminderSentAtMs, lastReminderChannel } = dedup
  if (
    lastReminderChannel == null ||
    lastReminderSentAtMs == null ||
    !Number.isFinite(lastReminderSentAtMs)
  ) {
    return false
  }
  // Activity newer than the last reminder restarts the cadence — the prior
  // reminder no longer counts against the new anchor.
  if (lastActiveAtMs > lastReminderSentAtMs) return false
  // Same channel already sent for this anchor → suppress. A `push` already
  // sent does not suppress the later `email` escalation.
  return lastReminderChannel === dueChannel
}

/**
 * Decide which reminder channel is due for a scene.
 *
 *   - `none`  : the verify is finished (`approved` / `rejected` / `expired`),
 *               `lastActiveAtMs` is missing, less than 24 h has elapsed, OR
 *               the channel now due was already sent (de-dup).
 *   - `push`  : ≥ 24 h and < 72 h since last activity, not yet sent.
 *   - `email` : ≥ 72 h since last activity (the fallback), not yet sent.
 *
 * `lastActiveAtMs` is the `customer_verify_last_active_at` column converted to
 * unix-ms. `null` (the customer never opened the sheet) yields `none` — there
 * is no anchor to measure the cadence from.
 *
 * `dedup` is the `customer_verify_last_reminder_*` state (migration
 * 20260520120040). It defaults to "nothing sent yet", which keeps the resolver
 * purely time-driven; an hourly cron supplies the real columns so a channel is
 * fired exactly once per activity anchor.
 *
 * @param state          the persisted `customer_verify_state`.
 * @param lastActiveAtMs unix-ms of the last verify activity, or `null`.
 * @param nowMs          the current time (injected for deterministic tests).
 * @param dedup          the persisted last-reminder state — defaults to none.
 */
export function resolveVerifyReminderChannel(
  state: CustomerVerifyState,
  lastActiveAtMs: number | null,
  nowMs: number = Date.now(),
  dedup: VerifyReminderDedupState = { lastReminderSentAtMs: null, lastReminderChannel: null },
): VerifyReminderChannel {
  if (!isVerifyReminderEligible(state)) return 'none'
  if (lastActiveAtMs == null || !Number.isFinite(lastActiveAtMs)) return 'none'

  const elapsed = nowMs - lastActiveAtMs
  let due: 'push' | 'email' | 'none' = 'none'
  if (elapsed >= VERIFY_REMINDER_EMAIL_MS) due = 'email'
  else if (elapsed >= VERIFY_REMINDER_PUSH_MS) due = 'push'

  if (due === 'none') return 'none'
  // De-dup — suppress a channel the cron already fired for this anchor.
  if (reminderAlreadySent(due, lastActiveAtMs, dedup)) return 'none'
  return due
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal construction
// ─────────────────────────────────────────────────────────────────────────────

/** German copy per reminder channel. */
const REMINDER_COPY: Record<'push' | 'email', { title: string; body: string }> = {
  push: {
    title: 'Scan fertig — stimmt alles?',
    body: 'Schau kurz über deinen Raum-Scan, damit Handwerker passende Angebote machen können.',
  },
  email: {
    title: 'Dein Raum-Scan wartet noch auf dich',
    body: 'Du hast deinen Scan noch nicht bestätigt. Eine kurze Prüfung reicht — dann kannst du Angebote anfragen.',
  },
}

/**
 * Build the verify-flow-spec §5 deep-link route for the reminder. The route
 * opens the customer's Spatial-Verify surface for the project.
 */
export function verifyReminderRoute(projectId: string): string {
  return `/customer/projects/${projectId}/spatial/verify`
}

/**
 * Build the {@link VerifyReminderSignal} for a scene whose reminder is due.
 *
 * Returns `null` when no reminder is due (`resolveVerifyReminderChannel`
 * yielded `none`, including the de-dup suppression) — the caller (the external
 * scheduler) then skips this scene. This is the single function the cron /
 * Edge-Function calls per scene; after a non-null result the cron persists the
 * `customer_verify_last_reminder_*` columns so the next run de-dups.
 *
 * @param sceneId        the `spatial_scenes.id`.
 * @param projectId      the project the verify belongs to.
 * @param state          the persisted `customer_verify_state`.
 * @param lastActiveAtMs unix-ms of last verify activity, or `null`.
 * @param nowMs          the current time (injected for deterministic tests).
 * @param dedup          the persisted last-reminder state — defaults to none.
 */
export function buildVerifyReminderSignal(
  sceneId: string,
  projectId: string,
  state: CustomerVerifyState,
  lastActiveAtMs: number | null,
  nowMs: number = Date.now(),
  dedup: VerifyReminderDedupState = { lastReminderSentAtMs: null, lastReminderChannel: null },
): VerifyReminderSignal | null {
  const channel = resolveVerifyReminderChannel(state, lastActiveAtMs, nowMs, dedup)
  if (channel === 'none') return null

  const copy = REMINDER_COPY[channel]
  return {
    sceneId,
    projectId,
    channel,
    title: copy.title,
    body: copy.body,
    route: verifyReminderRoute(projectId),
    verifyState: state,
  }
}
