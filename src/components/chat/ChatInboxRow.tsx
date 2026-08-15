import { useMemo } from 'react'
import type { ChatChannelType, ChatRole, ChatThreadDisplayMetadata } from '../../lib/chat'
import { channelStyle } from './chatChannelStyle'
import {
  inboxRowDisplay,
  inboxRowPreview,
  inboxRowTimestamp,
  inboxRowUnreadBadge,
} from './chatInboxRowFormat'

type Props = {
  channelType: ChatChannelType
  role: ChatRole
  displayMetadata?: ChatThreadDisplayMetadata | null
  fallbackTitle?: string | null
  lastMessageBody?: string | null
  lastMessageAt?: number | null
  unreadCount?: number | null
  pinned?: boolean
  onPress: () => void
  /** Override "now" for deterministic rendering in tests. */
  now?: number
}

/**
 * Inbox-Row v2 (ADR D-5). Hierarchy:
 *   • Preview prominent (14.5 px)
 *   • Name above (12.5 px)
 *   • Sub below (10.5 px)
 * Channel-cue lives on the avatar ring + a small pill — never the bubble.
 */
export function ChatInboxRow({
  channelType,
  role,
  displayMetadata,
  fallbackTitle,
  lastMessageBody,
  lastMessageAt,
  unreadCount,
  pinned = false,
  onPress,
  now,
}: Props) {
  const display = useMemo(
    () => inboxRowDisplay(displayMetadata, role, fallbackTitle),
    [displayMetadata, role, fallbackTitle],
  )
  const style = channelStyle(channelType)
  const ts = inboxRowTimestamp(lastMessageAt, now)
  const preview = inboxRowPreview(lastMessageBody)
  const badge = inboxRowUnreadBadge(unreadCount)
  const hasUnread = badge.length > 0

  return (
    <button
      type="button"
      onClick={onPress}
      className="relative flex w-full items-center gap-3 rounded-2xl bg-white px-3 py-2.5 text-left transition active:scale-[0.99]"
    >
      <span className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${style.stripeClass}`} aria-hidden />
      <Avatar url={display.avatarUrl} name={display.name} ringClass={style.ringClass} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-slate-900">{display.name}</span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${style.pillBgClass} ${style.pillTextClass}`}
          >
            {style.label}
          </span>
          {pinned ? (
            <span className="shrink-0 text-[10px] text-slate-400" aria-label="Angeheftet">📌</span>
          ) : null}
          <span className="ml-auto shrink-0 text-[10.5px] text-slate-400">{ts}</span>
        </div>
        <div
          className={`mt-0.5 truncate text-[14.5px] ${
            hasUnread ? 'font-semibold text-slate-900' : 'font-normal text-slate-700'
          }`}
        >
          {preview || <span className="italic text-slate-400">Noch keine Nachricht</span>}
        </div>
        {display.subtitle ? (
          <div className="mt-0.5 truncate text-[10.5px] text-slate-400">{display.subtitle}</div>
        ) : null}
      </div>
      {hasUnread ? (
        <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] font-semibold text-white">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

function Avatar({ url, name, ringClass }: { url: string | null; name: string; ringClass: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={`h-11 w-11 shrink-0 rounded-full object-cover ring-2 ring-offset-2 ring-offset-white ${ringClass}`}
      />
    )
  }
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[13px] font-semibold text-slate-600 ring-2 ring-offset-2 ring-offset-white ${ringClass}`}
      aria-hidden
    >
      {initials(name)}
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0]?.[0] ?? '?').toUpperCase()
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase()
}
