import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  Flag,
  Heart,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { useKeyboardInset } from '../../hooks/useKeyboardInset'
import { useComments, type SortOrder } from '../../lib/providerMedia/useComments'
import {
  COMMENT_BODY_MAX_LEN,
  type PortfolioComment,
} from '../../lib/providerMedia/portfolioCommentService'
import ReportUserSheet from '../moderation/ReportUserSheet'

type Props = {
  open: boolean
  mediaId: string | null
  /** Auth user id of the currently signed-in viewer; null when anonymous. */
  currentUserId: string | null
  /** Auth user id of the provider that owns the media (host moderation). */
  providerOwnerUserId: string | null
  onClose: () => void
}

type SnapPoint = 'half' | 'full'

/**
 * TikTok-Parity Comments-Panel (Block 2).
 *
 * Snap-Points:
 *  - half: ~60dvh (Quick-Glance ohne den Reel zu verlieren)
 *  - full: ~90dvh (für Reply-Threads, Sortieren, Schreiben)
 *
 * Bottom-Nav-Cut-off-Fix: wenn `bottomNavSafe` true ist, wird der
 * Composer-Footer mit `bottom: var(--bottom-nav-h)` versetzt, sodass die
 * Bodennavigation den Footer NIE überlappt — der zentrale Bug aus dem
 * Audit ("Hälfte der Kommentarsektion ist abgeschnitten").
 *
 * Threading: 1-Level (Top + Replies). Reply-on-Reply verbietet der
 * DB-Trigger; UI rendert stattdessen einen Reply-Composer für den
 * Top-Level-Parent.
 *
 * Per-Comment-Heart + Count: Realtime-broadcast über
 * `provider_media_comment_likes`.
 *
 * Edit: nur eigene Comments. Provider hat KEIN Edit-Recht (RLS).
 * Delete: eigener Comment ODER Provider/Media-Owner (RLS).
 *
 * Sort: Top (likeCount DESC) | Neueste (createdAt DESC).
 */
export default function PortfolioCommentsPanel({
  open,
  mediaId,
  currentUserId,
  providerOwnerUserId,
  onClose,
}: Props) {
  const effectiveMediaId = open ? mediaId : null
  const {
    topLevel,
    repliesByParent,
    summaryById,
    expandedSet,
    loading,
    error,
    sort,
    count,
    setSort,
    expandReplies,
    collapseReplies,
    post,
    edit,
    remove,
    toggleLike,
  } = useComments(effectiveMediaId)

  const [snap, setSnap] = useState<SnapPoint>('full')
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [replyTarget, setReplyTarget] = useState<{ id: string; authorName: string | null } | null>(
    null,
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  // Swipe-to-dismiss: live downward drag offset + active-drag flag.
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartRef = useRef<{ y: number; t: number } | null>(null)
  const didDragRef = useRef(false)
  // Apple-1.2: single hoisted report sheet, keyed by the target comment.
  const [reportTarget, setReportTarget] = useState<{
    userId: string
    commentId: string
    authorName: string | null
  } | null>(null)

  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  // Reset draft + ephemerals when opening for a new media item.
  useEffect(() => {
    if (!open) return
    setDraft('')
    setSubmitting(false)
    setReplyTarget(null)
    setEditingId(null)
    setEditingDraft('')
    setOpenMenuId(null)
    setReportTarget(null)
    setSnap('full')
    setDragY(0)
    setDragging(false)
    dragStartRef.current = null
    didDragRef.current = false
  }, [open, mediaId])

  // Escape closes
  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The nested report sheet owns Escape while it is open — let its own
      // handler close just the report instead of tearing down the whole panel.
      if (reportTarget) return
      event.preventDefault()
      if (replyTarget) {
        setReplyTarget(null)
        return
      }
      if (editingId) {
        setEditingId(null)
        setEditingDraft('')
        return
      }
      onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, replyTarget, editingId, reportTarget])

  // iOS / mobile keyboard: reuse the shared chat keyboard rig. It publishes the
  // live keyboard height as `--keyboard-height` AND flips the native resize mode
  // to 'none' while the composer is focused — without that flip the WebView's
  // own `resize:'body'` and our offset double-compensate (the old hand-rolled
  // visualViewport path's bug: composer covered / janky on native). The panel is
  // mounted only while open (conditional render in ExploreReelCard), so this
  // runs only when comments are actually visible.
  useKeyboardInset()

  if (!open || !mediaId) return null

  const trimmed = draft.trim()
  const submittable = trimmed.length > 0 && trimmed.length <= COMMENT_BODY_MAX_LEN && !submitting

  async function handleSubmit() {
    if (!submittable) return
    setSubmitting(true)
    try {
      await post(draft, replyTarget?.id ?? null)
      setDraft('')
      setReplyTarget(null)
    } catch {
      // useComments setzt state.error
    } finally {
      setSubmitting(false)
    }
  }

  function startEdit(comment: PortfolioComment) {
    setEditingId(comment.id)
    setEditingDraft(comment.body)
    setOpenMenuId(null)
  }

  async function commitEdit() {
    if (!editingId) return
    const t = editingDraft.trim()
    if (t.length === 0 || t.length > COMMENT_BODY_MAX_LEN) return
    try {
      await edit(editingId, editingDraft)
      setEditingId(null)
      setEditingDraft('')
    } catch {
      // bleibt im Edit-Mode, error-state via Hook
    }
  }

  // --- Swipe-to-dismiss (drag handle / header grab zone) -------------------
  // A short, deliberate tap toggles the snap point (handle onClick). A pull
  // down past the threshold OR a fast downward flick closes the sheet. Drag
  // tracking only engages once the pointer moves > 6px, so taps on the close
  // button / sort toggle inside the grab zone keep firing their own onClick.
  function handleDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    dragStartRef.current = { y: e.clientY, t: e.timeStamp }
    didDragRef.current = false
  }

  function handleDragMove(e: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current
    if (!start) return
    const dy = e.clientY - start.y
    if (!didDragRef.current && Math.abs(dy) > 6) {
      didDragRef.current = true
      setDragging(true)
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // pointer capture unsupported / pointer already released — ignore
      }
    }
    if (didDragRef.current) {
      // Only follow downward drags; clamp upward movement to the resting pos.
      setDragY(dy > 0 ? dy : 0)
    }
  }

  function handleDragEnd(e: ReactPointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (!start) return
    const dy = e.clientY - start.y
    const dt = Math.max(1, e.timeStamp - start.t)
    const velocity = dy / dt // px per ms, positive = downward
    const dragged = didDragRef.current
    didDragRef.current = false
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // pointer already released — ignore
    }
    if (dragged && (dy > 120 || (dy > 40 && velocity > 0.6))) {
      onClose()
      return
    }
    // Not dismissed: animate back to the resting position.
    setDragY(0)
  }

  function handleDragCancel() {
    dragStartRef.current = null
    didDragRef.current = false
    setDragging(false)
    setDragY(0)
  }

  // Snap-bounded max-height. `min(…, 100%)` keeps the sheet inside the
  // nav-/keyboard-shortened backdrop container, so it can NEVER overflow the
  // top under the Dynamic Island (root cause of the un-closable sheet).
  // Use a FIXED height (not max-height) so the sheet opens tall like TikTok even
  // when there are no comments yet — content-sizing made an empty sheet only
  // half the screen, "zu weit unten". `min(.., 100%)` keeps it inside the
  // keyboard-/island-shortened backdrop so it can never overflow the top.
  const sheetHeight = snap === 'half' ? 'min(60dvh, 100%)' : 'min(90dvh, 100%)'

  // BottomNav-Cut-off-Fix: in Card-Mode (bottomNavSafe=true) lassen wir
  // das Panel ÜBER der Nav enden — die Nav bleibt sichtbar (TikTok/Insta-
  // Convention), und der Sheet-Footer kann nicht mehr von der Nav überdeckt
  // werden. iOS-Keyboard-Inset wird zusätzlich addiert, damit der Composer
  // beim Aufklappen der Tastatur nicht unter ihr verschwindet.
  // Keyboard closed → end above the bottom nav (TikTok/Insta convention).
  // Keyboard open → the keyboard height takes over (≫ nav), so `max()` drops the
  // now-meaningless nav term and the composer footer sits right on the keyboard.
  // Cover the bottom nav while open (TikTok convention) so the sheet reaches the
  // screen bottom — the nav peeking out below looked unfinished. Keyboard open →
  // the sheet bottom rides the keyboard top.
  const outerBottom = 'var(--keyboard-height, 0px)'

  // Portal to <body> so the sheet escapes the reels feed's momentum-scroll
  // container (`<main>` carries `-webkit-overflow-scrolling: touch` +
  // `overflow-y: auto`). Inside that container iOS WKWebView treats our
  // `position: fixed` as scroll-relative and traps its stacking context, so the
  // root-level header pills (z-30) and bottom nav (z-40) painted OVER the sheet
  // — the "comments cut off under the nav" + "tabs overlap the header" bugs.
  // As a body child the backdrop is truly viewport-fixed and z-[70] wins
  // globally. Mirrors QuoteCreationSheet / ProjectPickerSheet.
  return createPortal(
    <div
      className="fixed left-0 right-0 top-0 z-[70] flex items-end bg-black/45 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Kommentare"
      onClick={onClose}
      // Safe-area top inset on the backdrop keeps a tappable strip under the
      // Dynamic Island AND pushes the sheet's content box below it, so the
      // header (title + X) always clears the island.
      style={{ bottom: outerBottom, paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div
        className="relative flex w-full flex-col overflow-hidden rounded-t-[24px] bg-white shadow-[0_-12px_30px_rgba(0,0,0,0.18)]"
        style={{
          height: sheetHeight,
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? 'none' : 'transform 220ms ease, height 200ms ease',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Drag-Handle + Snap-Toggle + swipe-to-dismiss grab zone */}
        <div
          className="shrink-0"
          style={{ touchAction: 'none' }}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragCancel}
        >
          <button
            type="button"
            onClick={() => {
              // Suppress the snap toggle when the gesture was an actual drag.
              if (didDragRef.current) return
              setSnap((s) => (s === 'full' ? 'half' : 'full'))
            }}
            className="mx-auto mt-2 mb-1 flex h-5 w-16 items-center justify-center"
            aria-label={snap === 'full' ? 'Sheet verkleinern' : 'Sheet vergrößern'}
          >
            <span className="h-1 w-10 rounded-full bg-slate-300" aria-hidden />
          </button>

          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 pb-3 pt-1">
            <div className="flex flex-1 items-center gap-3">
              <h2 className="text-[15px] font-semibold text-slate-900">
                Kommentare {count > 0 ? <span className="text-slate-400">· {count}</span> : null}
              </h2>
              <SortToggle sort={sort} onChange={setSort} />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600"
              aria-label="Kommentare schließen"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && topLevel.length === 0 ? (
            <p className="text-center text-[12px] text-slate-500">Wird geladen …</p>
          ) : topLevel.length === 0 ? (
            <p className="mt-6 text-center text-[14px] text-slate-500">
              Noch keine Kommentare. Sei der/die Erste.
            </p>
          ) : (
            <ul className="space-y-4">
              {topLevel.map((comment) => {
                const summary = summaryById.get(comment.id) ?? {
                  replyCount: 0,
                  likeCount: 0,
                  likedByMe: false,
                }
                const expanded = expandedSet.has(comment.id)
                const replies = expanded ? repliesByParent.get(comment.id) ?? [] : []
                const isAuthor = !!currentUserId && comment.userId === currentUserId
                const isHost =
                  !!currentUserId &&
                  !!providerOwnerUserId &&
                  providerOwnerUserId === currentUserId
                // Apple-1.2: non-author viewers can report a comment. Hidden
                // for the author (self-report) — the DB CHECK would reject it.
                const canReport = !!currentUserId && !isAuthor && !!comment.userId
                return (
                  <li key={comment.id} className="space-y-2">
                    <CommentRow
                      comment={comment}
                      summary={summary}
                      isAuthor={isAuthor}
                      canDelete={isAuthor || isHost}
                      canReport={canReport}
                      currentUserId={currentUserId}
                      menuOpen={openMenuId === comment.id}
                      onMenuToggle={() =>
                        setOpenMenuId((prev) => (prev === comment.id ? null : comment.id))
                      }
                      onReport={() => {
                        setOpenMenuId(null)
                        setReportTarget({
                          userId: comment.userId,
                          commentId: comment.id,
                          authorName: comment.authorName,
                        })
                      }}
                      onLike={() => void toggleLike(comment.id)}
                      onReply={() =>
                        setReplyTarget({ id: comment.id, authorName: comment.authorName })
                      }
                      onEdit={() => startEdit(comment)}
                      onDelete={() => {
                        setOpenMenuId(null)
                        void remove(comment.id)
                      }}
                      editing={editingId === comment.id}
                      editingDraft={editingDraft}
                      onEditingDraftChange={setEditingDraft}
                      onCommitEdit={commitEdit}
                      onCancelEdit={() => {
                        setEditingId(null)
                        setEditingDraft('')
                      }}
                    />

                    {/* Replies */}
                    {summary.replyCount > 0 ? (
                      <div className="ml-12">
                        {expanded ? (
                          <button
                            type="button"
                            onClick={() => collapseReplies(comment.id)}
                            className="text-[12px] font-semibold text-slate-500"
                          >
                            <ChevronDown size={12} className="inline -mt-0.5" aria-hidden />{' '}
                            Antworten ausblenden
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void expandReplies(comment.id)}
                            className="text-[12px] font-semibold text-slate-500"
                          >
                            — {summary.replyCount === 1
                              ? '1 Antwort anzeigen'
                              : `${summary.replyCount} Antworten anzeigen`}
                          </button>
                        )}
                        {expanded ? (
                          <ul className="mt-2 space-y-3">
                            {replies.map((reply) => {
                              const rs = summaryById.get(reply.id) ?? {
                                replyCount: 0,
                                likeCount: 0,
                                likedByMe: false,
                              }
                              const replyIsAuthor =
                                !!currentUserId && reply.userId === currentUserId
                              const replyCanReport =
                                !!currentUserId && !replyIsAuthor && !!reply.userId
                              return (
                                <li key={reply.id}>
                                  <CommentRow
                                    comment={reply}
                                    summary={rs}
                                    isAuthor={replyIsAuthor}
                                    canDelete={replyIsAuthor || isHost}
                                    canReport={replyCanReport}
                                    currentUserId={currentUserId}
                                    avatarSize="sm"
                                    menuOpen={openMenuId === reply.id}
                                    onMenuToggle={() =>
                                      setOpenMenuId((prev) =>
                                        prev === reply.id ? null : reply.id,
                                      )
                                    }
                                    onReport={() => {
                                      setOpenMenuId(null)
                                      setReportTarget({
                                        userId: reply.userId,
                                        commentId: reply.id,
                                        authorName: reply.authorName,
                                      })
                                    }}
                                    onLike={() => void toggleLike(reply.id)}
                                    onReply={() =>
                                      setReplyTarget({
                                        id: comment.id,
                                        authorName: reply.authorName,
                                      })
                                    }
                                    onEdit={() => startEdit(reply)}
                                    onDelete={() => {
                                      setOpenMenuId(null)
                                      void remove(reply.id)
                                    }}
                                    editing={editingId === reply.id}
                                    editingDraft={editingDraft}
                                    onEditingDraftChange={setEditingDraft}
                                    onCommitEdit={commitEdit}
                                    onCancelEdit={() => {
                                      setEditingId(null)
                                      setEditingDraft('')
                                    }}
                                  />
                                </li>
                              )
                            })}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Composer-Footer — in-flow am unteren Sheet-Rand (shrink-0). The
            data-kb-pinned-composer marker tells useKeyboardInset to flip the
            native keyboard resize mode to 'none' while this textarea is focused
            so the sheet's --keyboard-height lift is the sole offset. */}
        <div
          data-kb-pinned-composer
          // pb via class (not inline) so the `html[data-keyboard-open]
          // [data-kb-pinned-composer]` rule in index.css can collapse the
          // home-indicator pad to 8px while the keyboard is up — an inline style
          // would win over that selector and leave a ~34px dead gap above the
          // keyboard (native resize mode is 'none' here, so the safe-area inset
          // stays nonzero).
          className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]"
        >
          {error ? (
            <p className="mb-2 text-[12px] font-semibold text-red-500" role="alert">
              {error}
            </p>
          ) : null}
          {currentUserId ? (
            <>
              {replyTarget ? (
                <div className="mb-2 flex items-center justify-between rounded-card bg-slate-100 px-3 py-1.5 text-[12px] text-slate-700">
                  <span>
                    Antwort an{' '}
                    <span className="font-semibold">
                      {replyTarget.authorName ?? 'Nutzer:in'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setReplyTarget(null)}
                    className="ml-2 text-slate-500"
                    aria-label="Antwort abbrechen"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSubmit()
                }}
                className="flex items-end gap-2"
              >
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={replyTarget ? 'Antwort schreiben …' : 'Kommentar schreiben …'}
                  rows={1}
                  maxLength={COMMENT_BODY_MAX_LEN}
                  className="min-h-[40px] flex-1 resize-none rounded-card bg-slate-50 px-3 py-2 text-[14px] text-slate-900 outline-none ring-1 ring-slate-200 focus:ring-slate-900"
                />
                <button
                  type="submit"
                  disabled={!submittable}
                  aria-label="Senden"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white transition active:scale-[0.95] disabled:opacity-40"
                >
                  <Send size={16} aria-hidden />
                </button>
              </form>
              <p className="mt-1 text-right text-[10px] text-slate-400">
                {draft.length} / {COMMENT_BODY_MAX_LEN}
              </p>
            </>
          ) : (
            <p className="py-1 text-center text-[12px] text-slate-500">
              Bitte logge dich ein, um zu kommentieren.
            </p>
          )}
        </div>
      </div>

      {reportTarget ? (
        <ReportUserSheet
          targetUserId={reportTarget.userId}
          targetLabel={reportTarget.authorName ?? 'Nutzer:in'}
          contextType="portfolio_comment"
          contextId={reportTarget.commentId}
          onClose={() => setReportTarget(null)}
        />
      ) : null}
    </div>,
    document.body,
  )
}

function SortToggle({ sort, onChange }: { sort: SortOrder; onChange: (s: SortOrder) => void }) {
  const opts = useMemo<{ value: SortOrder; label: string }[]>(
    () => [
      { value: 'top', label: 'Top' },
      { value: 'new', label: 'Neueste' },
    ],
    [],
  )
  return (
    <div className="flex items-center gap-1 rounded-full bg-slate-100 p-0.5">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
            sort === o.value ? 'bg-white text-slate-900 shadow' : 'text-slate-500'
          }`}
          aria-pressed={sort === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CommentRow({
  comment,
  summary,
  isAuthor,
  canDelete,
  canReport,
  currentUserId,
  menuOpen,
  onMenuToggle,
  onLike,
  onReply,
  onReport,
  onEdit,
  onDelete,
  editing,
  editingDraft,
  onEditingDraftChange,
  onCommitEdit,
  onCancelEdit,
  avatarSize = 'md',
}: {
  comment: PortfolioComment
  summary: { replyCount: number; likeCount: number; likedByMe: boolean }
  isAuthor: boolean
  canDelete: boolean
  canReport: boolean
  currentUserId: string | null
  menuOpen: boolean
  onMenuToggle: () => void
  onLike: () => void
  onReply: () => void
  onReport: () => void
  onEdit: () => void
  onDelete: () => void
  editing: boolean
  editingDraft: string
  onEditingDraftChange: (s: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  avatarSize?: 'md' | 'sm'
}) {
  const initial = (comment.authorName ?? 'N').slice(0, 1).toUpperCase()
  const sizeClass = avatarSize === 'sm' ? 'h-8 w-8 text-[11px]' : 'h-9 w-9 text-[12px]'
  const ageLabel = formatAge(comment.createdAt)

  return (
    <div className="flex items-start gap-3">
      <div
        className={`flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600 ${sizeClass}`}
        aria-hidden
      >
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] text-slate-700">
          <span className="font-semibold text-slate-900">
            {comment.authorName ?? 'Nutzer:in'}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-500">{ageLabel}</span>
          {comment.editedAt ? (
            <span className="text-slate-400">· bearbeitet</span>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1.5 space-y-2">
            <textarea
              value={editingDraft}
              onChange={(event) => onEditingDraftChange(event.target.value)}
              maxLength={COMMENT_BODY_MAX_LEN}
              rows={2}
              className="w-full resize-none rounded-card bg-slate-50 px-3 py-2 text-[13px] text-slate-900 outline-none ring-1 ring-slate-200 focus:ring-slate-900"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCommitEdit}
                disabled={editingDraft.trim().length === 0}
                className="rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
              >
                Speichern
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                className="rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200"
              >
                Abbrechen
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-snug text-slate-800">
            {comment.body}
          </p>
        )}
        {!editing ? (
          <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
            <button
              type="button"
              onClick={onReply}
              disabled={!currentUserId}
              className="font-semibold disabled:opacity-50"
            >
              Antworten
            </button>
            {summary.likeCount > 0 ? (
              <span className="tabular-nums">
                {summary.likeCount} {summary.likeCount === 1 ? 'Like' : 'Likes'}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Right rail */}
      {!editing ? (
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={onLike}
            disabled={!currentUserId}
            aria-label={summary.likedByMe ? 'Like entfernen' : 'Kommentar liken'}
            aria-pressed={summary.likedByMe}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition active:scale-90 disabled:opacity-40"
          >
            <Heart
              size={14}
              strokeWidth={1.8}
              className={summary.likedByMe ? 'fill-red-500 stroke-red-500' : 'stroke-slate-500'}
              aria-hidden
            />
          </button>
          <span className="min-h-[10px] text-[10px] tabular-nums text-slate-400">
            {summary.likeCount > 0 ? summary.likeCount : ''}
          </span>
          {(isAuthor || canDelete || canReport) ? (
            <div className="relative">
              <button
                type="button"
                onClick={onMenuToggle}
                className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400"
                aria-label="Kommentar-Optionen"
              >
                <MoreHorizontal size={14} aria-hidden />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-7 z-10 w-36 rounded-card bg-white p-1 shadow-lg ring-1 ring-slate-200">
                  {isAuthor ? (
                    <button
                      type="button"
                      onClick={onEdit}
                      className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-[12px] text-slate-700 hover:bg-slate-50"
                    >
                      <Pencil size={12} aria-hidden /> Bearbeiten
                    </button>
                  ) : null}
                  {canDelete ? (
                    <button
                      type="button"
                      onClick={onDelete}
                      className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-[12px] text-red-600 hover:bg-red-50"
                    >
                      <Trash2 size={12} aria-hidden /> Löschen
                    </button>
                  ) : null}
                  {canReport ? (
                    <button
                      type="button"
                      onClick={onReport}
                      className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-[12px] text-slate-700 hover:bg-slate-50"
                    >
                      <Flag size={12} aria-hidden /> Melden
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function formatAge(createdAtMs: number): string {
  const diff = Math.max(0, Date.now() - createdAtMs)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'jetzt'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} Min.`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} Std.`
  const day = Math.floor(hour / 24)
  if (day < 7) return `${day} T.`
  const week = Math.floor(day / 7)
  if (week < 5) return `${week} Wo.`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} Mon.`
  const year = Math.floor(day / 365)
  return `${year} J.`
}
