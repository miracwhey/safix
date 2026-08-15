/**
 * Block D Slice B — Document-message bubble with optimistic pending state.
 *
 * Pending: shows filename + size immediately (from attachment.fileName) + spinner.
 * Sent: tap opens via Capacitor Browser / new tab.
 * Failed: rose background + retry tap.
 * Transition pending→sent: 160ms fade on the pending indicator.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment, ChatMessageStatus } from '../../lib/chat'
import { resolveChatAttachmentUrl } from '../../lib/chat/voice/storageUrl'
import { openExternal } from '../../lib/platform'
import { logWarning } from '../../lib/observability'
import { ChatStatusIcon } from './ChatStatusIcon'
import { BubbleTail } from './BubbleTail'
import { bubbleAlignClass, bubbleRadiusClass, bubbleTailSide } from './chatBubbleSide'
import Spinner from '../system/Spinner'

type Props = {
  attachment: ChatAttachment
  caption?: string | null
  createdAt: number
  status: ChatMessageStatus
  isOwnBubble: boolean
  /** Called when user taps the failed bubble to retry (own bubbles only). */
  onRetry?: () => void
  /** Called when the user discards a permanently-failed send (3+ retries). */
  onDiscardFailed?: () => void
  /** How many retries have already failed (3+ → discard CTA). */
  failedRetryCount?: number
}

export function DocumentMessageBubble({
  attachment,
  caption,
  createdAt,
  status,
  isOwnBubble,
  onRetry,
  onDiscardFailed,
  failedRetryCount = 0,
}: Props) {
  const isPending = status === 'pending'
  const isFailed = status === 'failed'

  const [opening, setOpening] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  // Track for 160ms fade-out of pending indicator.
  const [pendingVisible, setPendingVisible] = useState(isPending)
  const prevPendingRef = useRef(isPending)

  useEffect(() => {
    const prev = prevPendingRef.current
    prevPendingRef.current = isPending
    if (prev && !isPending) {
      queueMicrotask(() => setPendingVisible(false))
    } else if (!prev && isPending) {
      queueMicrotask(() => setPendingVisible(true))
    }
  }, [isPending])

  const handleOpen = useCallback(async () => {
    if (isPending || isFailed || opening) return
    setOpening(true)
    setOpenFailed(false)
    try {
      const url = await resolveChatAttachmentUrl(
        attachment.storageBucket,
        attachment.storagePath,
      )
      await openExternal(url, 'tab')
    } catch (err) {
      logWarning('chat.document.open_failed', {
        attachmentId: attachment.id,
        error: err instanceof Error ? err.message : String(err),
      })
      setOpenFailed(true)
    } finally {
      setOpening(false)
    }
  }, [attachment.id, attachment.storageBucket, attachment.storagePath, isPending, isFailed, opening])

  const handleTap = useCallback(() => {
    if (isFailed && isOwnBubble) {
      if (failedRetryCount >= 3 && onDiscardFailed) {
        onDiscardFailed()
      } else {
        onRetry?.()
      }
      return
    }
    void handleOpen()
  }, [isFailed, isOwnBubble, failedRetryCount, onDiscardFailed, onRetry, handleOpen])

  const label = deriveDocumentLabel(attachment)
  const sizeLabel = formatBytes(attachment.sizeBytes)

  const showTail = !isFailed

  return (
    <div className={`flex flex-col ${bubbleAlignClass(isOwnBubble)} mt-1.5`}>
      <div className="relative max-w-[78%]">
      <div
        className={`relative flex flex-col gap-1.5 ${bubbleRadiusClass(isOwnBubble)} px-3 py-2 ${
          isFailed
            ? isOwnBubble
              ? 'bg-rose-500 text-white'
              : 'bg-rose-50 text-rose-900 ring-1 ring-rose-200'
            : isOwnBubble
              ? 'bg-blue-600 text-white'
              : 'bg-white text-slate-900 ring-1 ring-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_20px_-10px_rgba(15,23,42,0.22)]'
        }`}
        data-message-type="document"
        data-status={status}
      >
        {/* Pending shimmer strip */}
        {(isPending || pendingVisible) ? (
          <div
            className={`absolute inset-0 overflow-hidden ${bubbleRadiusClass(isOwnBubble)} pointer-events-none transition-opacity duration-[160ms]`}
            style={{ opacity: pendingVisible ? 1 : 0 }}
            aria-hidden
          >
            <div className="absolute inset-y-0 w-[60%] animate-[fx-skeleton-sweep_1.5s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/12 to-transparent" />
          </div>
        ) : null}

        <button
          type="button"
          onClick={handleTap}
          aria-label={
            isFailed
              ? `${label} — Senden fehlgeschlagen, antippen für Wiederholung`
              : isPending
                ? `${label} wird gesendet…`
                : `${label} öffnen`
          }
          disabled={opening}
          className={`flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition active:scale-[0.98] ${
            isFailed
              ? isOwnBubble
                ? 'bg-white/15 hover:bg-white/20'
                : 'bg-rose-100 hover:bg-rose-150'
              : isOwnBubble
                ? 'bg-white/12 hover:bg-white/18'
                : 'bg-slate-50 hover:bg-slate-100'
          } disabled:opacity-60`}
        >
          {/* File icon / state indicator */}
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              isFailed
                ? isOwnBubble ? 'bg-white/20 text-white' : 'bg-rose-200 text-rose-700'
                : isOwnBubble ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
            }`}
            aria-hidden
          >
            {isPending ? (
              <Spinner size="md" tone="current" />
            ) : isFailed ? (
              <RetryIcon />
            ) : (
              <DocIcon />
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-[13.5px] font-semibold ${
                isFailed
                  ? isOwnBubble ? 'text-white' : 'text-rose-900'
                  : isOwnBubble ? 'text-white' : 'text-slate-900'
              }`}
            >
              {label}
            </span>
            <span
              className={`block text-[11px] ${
                isFailed
                  ? isOwnBubble ? 'text-white/70' : 'text-rose-600'
                  : isOwnBubble ? 'text-white/70' : 'text-slate-500'
              }`}
            >
              {isPending
                ? 'Sende…'
                : isFailed
                  ? failedRetryCount >= 3
                    ? 'Antippen zum Verwerfen'
                    : 'Nicht gesendet — antippen'
                  : opening
                    ? 'Öffne…'
                    : sizeLabel}
            </span>
          </span>

          {!isPending && !isFailed ? (
            <DownloadIcon className={isOwnBubble ? 'text-white/80' : 'text-slate-400'} />
          ) : null}
        </button>

        {openFailed ? (
          <span className={`px-1 text-[11px] ${isOwnBubble ? 'text-white/80' : 'text-rose-600'}`}>
            Konnte das Dokument nicht öffnen. Bitte erneut versuchen.
          </span>
        ) : null}

        {caption ? (
          <div className="whitespace-pre-wrap px-1 text-[14px] leading-snug">{caption}</div>
        ) : null}

        <div
          className={`flex items-center justify-end gap-1 px-1 text-[10.5px] ${
            isFailed
              ? isOwnBubble ? 'text-white/60' : 'text-rose-400'
              : isOwnBubble ? 'text-white/70' : 'text-slate-400'
          }`}
        >
          <span>{formatClockTime(createdAt)}</span>
          <ChatStatusIcon status={status} isOwnBubble={isOwnBubble} variant="v5" />
        </div>
      </div>
        {showTail ? <BubbleTail side={bubbleTailSide(isOwnBubble)} tone={isOwnBubble ? 'own' : 'peer'} /> : null}
      </div>
    </div>
  )
}

function deriveDocumentLabel(attachment: ChatAttachment): string {
  // Prefer original filename if available (set during pending state).
  const name = attachment.fileName
  if (name) return name

  // Fall back to storage path extension inference.
  const ext = attachment.storagePath.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return 'Dokument.pdf'
  if (ext === 'doc' || ext === 'docx') return `Word-Dokument.${ext}`
  if (ext === 'xls' || ext === 'xlsx') return `Excel-Tabelle.${ext}`
  if (ext === 'ppt' || ext === 'pptx') return `Präsentation.${ext}`
  if (ext === 'txt') return 'Notiz.txt'
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return `Archiv.${ext}`
  if (ext && /^[a-z0-9]{1,8}$/.test(ext)) return `Datei.${ext}`
  return 'Dokument'
}

function formatBytes(size: number): string {
  if (size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log10(size) / 3))
  const value = size / Math.pow(1000, exponent)
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[exponent]}`
}

function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours()
  const m = d.getMinutes()
  return `${h < 10 ? `0${h}` : h}:${m < 10 ? `0${m}` : m}`
}

function DocIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 2h6L12.5 5v9h-9V2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9.5 2v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5.5 8.5h5M5.5 11h5M5.5 6h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function RetryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      <path d="M15 9A6 6 0 1 1 11 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <polyline points="11,1 11,5 15,5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

function DownloadIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M8 2.5v8M5 8l3 3 3-3M3 13.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
