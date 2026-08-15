import { useMemo } from 'react'
import type { ChatMessageStatus, ChatMessageType } from '../../lib/chat'
import { ChatStatusIcon } from './ChatStatusIcon'
import { ChatReplyQuote } from './ChatReplyQuote'
import { BubbleTail } from './BubbleTail'
import {
  bubbleAlignClass,
  bubbleRadiusClass,
  bubbleToneClass,
  bubbleTailSide,
} from './chatBubbleSide'

type ReplyTo = {
  senderName: string
  preview: string
  onPress?: () => void
}

type Props = {
  body: string | null | undefined
  createdAt: number
  status: ChatMessageStatus
  isOwnBubble: boolean
  /** Sender name shown above peer bubbles in group chats. */
  senderName?: string | null
  /** When true, renders the sender label above the bubble. */
  showSenderName?: boolean
  /** When true, renders a smaller continuation bubble (no top corner radius). */
  isContinuation?: boolean
  replyTo?: ReplyTo | null
  messageType?: ChatMessageType
  /** Called when user taps a failed own bubble to retry (retryCount < 3). */
  onRetry?: () => void
  /** Called when user taps a failed own bubble to discard (retryCount >= 3). */
  onDiscard?: () => void
  /** How many retry attempts have been made for this message. */
  retryCount?: number
  /**
   * 'v5' renders the steelivory chat look (own bubble white with dark ink +
   * cyan read tick) used by the customer↔craftsman thread. 'default' keeps the
   * brand-blue own bubble (internal team thread screens) — see ADR D-5.
   */
  variant?: 'default' | 'v5'
}

/**
 * Block D Slice 1b-B Bubble v2. Implements ADR D-5/D-6:
 *   – Own bubble: brand-blue with white text + 4-stage status glyph
 *   – Peer bubble: surface-white with slate text, no status
 *   – Cyan-jump on read tick is the canonical visual anchor
 *   – Animations: transform + opacity only (60 fps floor)
 *
 * Channel-cue colours live on the avatar/header, NOT on the bubble bg —
 * see ADR D-2. Bubble bg stays brand-blue regardless of channelType.
 */
export function ChatBubble({
  body,
  createdAt,
  status,
  isOwnBubble,
  senderName,
  showSenderName = false,
  isContinuation = false,
  replyTo,
  messageType = 'text',
  onRetry,
  onDiscard,
  retryCount = 0,
  variant = 'default',
}: Props) {
  const timeLabel = useMemo(() => formatTime(createdAt), [createdAt])

  const align = bubbleAlignClass(isOwnBubble)
  const bubbleBase =
    'relative px-3.5 py-2 text-[15.5px] leading-snug break-words'
  const bubbleTone = bubbleToneClass(isOwnBubble)
  const bubbleRadius = bubbleRadiusClass(isOwnBubble, isContinuation)
  const isMuted = status === 'pending'
  const isFailed = status === 'failed' && isOwnBubble
  const failedAction = isFailed ? (retryCount < 3 ? onRetry : onDiscard) : undefined
  // Tail only on the first bubble of a group (continuations carry none) and not
  // on the rose failed state, whose palette the blue/white tail would clash with.
  const showTail = !isContinuation && !isFailed

  return (
    <div
      className={`flex flex-col ${align} ${isContinuation ? 'mt-0.5' : 'mt-1.5'} ${failedAction ? 'cursor-pointer' : ''}`}
      onClick={failedAction}
    >
      {showSenderName && !isOwnBubble && senderName ? (
        <span className="mb-0.5 px-1 text-[11px] font-medium text-slate-500">
          {senderName}
        </span>
      ) : null}
      <div className="relative max-w-[78%]">
        <div
          className={`${bubbleBase} ${bubbleTone} ${bubbleRadius} ${isFailed ? 'ring-2 ring-red-400/40' : ''}`}
          style={{ opacity: isMuted ? 0.85 : 1, transition: 'opacity 140ms ease-out' }}
          data-message-type={messageType}
          data-status={status}
        >
          {replyTo ? (
            <ChatReplyQuote
              senderName={replyTo.senderName}
              preview={replyTo.preview}
              isOwnBubble={isOwnBubble}
              onPress={replyTo.onPress}
            />
          ) : null}
          {body ? (
            <div className="whitespace-pre-wrap font-medium">
              {body}
              {/* Reserve space on the LAST line so the timestamp (absolute,
                  bottom-right) sits flush at its end — WhatsApp-style, filling
                  the bubble instead of dropping the time onto its own line. */}
              <span aria-hidden className="inline-block align-bottom" style={{ width: isOwnBubble ? 58 : 42, height: 1 }} />
            </div>
          ) : null}
          <div
            className={`absolute bottom-2 right-3.5 flex items-center gap-1 ${
              isOwnBubble ? 'text-white/70' : 'text-slate-400'
            }`}
          >
            <span className="text-[10.5px]">{timeLabel}</span>
            <ChatStatusIcon status={status} isOwnBubble={isOwnBubble} variant={variant} />
          </div>
        </div>
        {showTail ? <BubbleTail side={bubbleTailSide(isOwnBubble)} tone={isOwnBubble ? 'own' : 'peer'} /> : null}
      </div>
      {isFailed ? (
        <span className="mt-0.5 px-1 text-[10.5px] text-red-400">
          {retryCount < 3 ? 'Senden fehlgeschlagen · Tippen zum Wiederholen' : 'Tippen zum Verwerfen'}
        </span>
      ) : null}
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}
