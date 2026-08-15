/**
 * Pure formatters for the Inbox-Row v2 hierarchy. All testable in node.
 *
 * Visual hierarchy from ADR D-5:
 *   Preview (14.5 px, prominent) > Name (12.5 px) > Sub (10.5 px)
 */

import type { ChatRole, ChatThreadDisplayMetadata } from '../../lib/chat'

const SAFE_FALLBACK_NAME = 'Unbenannter Chat'

export interface InboxRowDisplay {
  name: string
  avatarUrl: string | null
  subtitle: string | null
}

/**
 * Picks the right counterparty name + avatar based on viewer role.
 * Customer sees craftsman; craftsman/owner sees customer; worker sees the
 * assignment / project subtitle.
 */
export function inboxRowDisplay(
  meta: ChatThreadDisplayMetadata | null | undefined,
  role: ChatRole,
  fallbackTitle?: string | null,
): InboxRowDisplay {
  const m = meta ?? {}

  if (role === 'customer') {
    return {
      name: m.craftsmanName ?? fallbackTitle ?? SAFE_FALLBACK_NAME,
      avatarUrl: m.craftsmanAvatarUrl ?? null,
      subtitle: m.projectTitle ?? m.projectSubtitle ?? null,
    }
  }

  if (role === 'worker') {
    return {
      name: m.projectTitle ?? fallbackTitle ?? SAFE_FALLBACK_NAME,
      avatarUrl: m.craftsmanAvatarUrl ?? null,
      subtitle: m.projectSubtitle ?? m.projectLocation ?? null,
    }
  }

  // craftsman / owner / admin → look at the customer side
  return {
    name: m.customerName ?? fallbackTitle ?? SAFE_FALLBACK_NAME,
    avatarUrl: m.customerAvatarUrl ?? null,
    subtitle: m.projectTitle ?? m.projectSubtitle ?? null,
  }
}

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN
const MS_PER_DAY = 24 * MS_PER_HOUR
const MS_PER_WEEK = 7 * MS_PER_DAY

/**
 * Compact iMessage-style relative timestamp. Returns:
 *   • "" for null / 0
 *   • "Jetzt" for <1 min
 *   • "12:34" for same calendar day
 *   • "Gestern" for yesterday
 *   • "Mo" / "Di" / "Mi" / "Do" / "Fr" / "Sa" / "So" for last 6 days
 *   • "12.05." for older within current year
 *   • "12.05.2025" for older years
 */
export function inboxRowTimestamp(
  lastMessageAt: number | null | undefined,
  now: number = Date.now(),
): string {
  if (!lastMessageAt) return ''

  const diff = now - lastMessageAt
  if (diff < 0) return formatTime(lastMessageAt)
  if (diff < MS_PER_MIN) return 'Jetzt'

  const lastDate = new Date(lastMessageAt)
  const nowDate = new Date(now)

  if (sameDay(lastDate, nowDate)) return formatTime(lastMessageAt)

  const yesterday = new Date(nowDate)
  yesterday.setDate(yesterday.getDate() - 1)
  if (sameDay(lastDate, yesterday)) return 'Gestern'

  if (diff < MS_PER_WEEK) return weekday(lastDate)

  if (lastDate.getFullYear() === nowDate.getFullYear()) {
    return `${pad(lastDate.getDate())}.${pad(lastDate.getMonth() + 1)}.`
  }
  return `${pad(lastDate.getDate())}.${pad(lastDate.getMonth() + 1)}.${lastDate.getFullYear()}`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
function weekday(d: Date): string {
  return WEEKDAYS[d.getDay()] ?? ''
}

/** Formats unread-count badge text. >99 → "99+", null/0 → "". */
export function inboxRowUnreadBadge(count: number | null | undefined): string {
  if (!count || count <= 0) return ''
  if (count > 99) return '99+'
  return String(count)
}

/**
 * Truncates the preview body to a safe length for one-line rendering.
 * The Inbox-Row v2 hierarchy uses a single-line clamp via `line-clamp-1`,
 * but pre-trimming avoids layout flicker for messages with embedded
 * line breaks.
 */
export function inboxRowPreview(body: string | null | undefined, max = 140): string {
  if (!body) return ''
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}
