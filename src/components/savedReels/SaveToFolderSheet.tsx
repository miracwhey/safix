import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, Check, FolderPlus, Trash2, X } from 'lucide-react'
import { useSavedFolders } from '../../lib/savedReels/useSavedFolders'
import { useToast } from '../../hooks/useToast'
import { useKeyboardInset } from '../../hooks/useKeyboardInset'

type Props = {
  open: boolean
  onClose: () => void
  /**
   * Currently saved folder for the active reel. `null` = saved in the
   * default folder. `undefined` = not saved yet.
   */
  currentFolderId: string | null | undefined
  /** Whether the active reel is saved at all. */
  isSaved: boolean
  /** Tap on a folder (incl. default with `null`) → assign / move there. */
  onPick: (folderId: string | null) => Promise<void> | void
  /** Tap on the trash row → remove the save altogether. */
  onUnsave: () => Promise<void> | void
}

/**
 * Bottom sheet that surfaces from a long-press on a Reel's bookmark
 * button. Shows the user's folder list (incl. virtual default), an
 * inline "Neuer Ordner" composer, and an "Aus Gespeicherten entfernen"
 * row when the reel is currently saved. Z-index sits above the
 * lightbox (60) so it works equally from feed-card and lightbox.
 *
 * Auth-gated: the consumer is responsible for not opening the sheet
 * when the user is anonymous (we cannot fetch folders RLS-wise).
 */
export default function SaveToFolderSheet({
  open,
  onClose,
  currentFolderId,
  isSaved,
  onPick,
  onUnsave,
}: Props) {
  const toast = useToast()
  // Lift the sheet above the keyboard when the "Neuer Ordner" input is focused.
  useKeyboardInset()
  const { folders, countsByFolder, loading, error, hydrated, createFolder } = useSavedFolders()
  const [composerOpen, setComposerOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)
  // Sentinel-basiert: 'idle' = nichts pending, '__default__' = Default-Folder
  // pending, '__unsave__' = Unsave pending, sonst Folder-UUID. Vorher war
  // hier `null | string | 'unsave'` was den Default-Folder-Row permanent
  // disabled hat (busy={busyFolderId === null} ist im Idle-State true).
  type Busy = 'idle' | '__default__' | '__unsave__' | string
  const [busy, setBusy] = useState<Busy>('idle')

  // Reset internal state every time the sheet opens for a different reel.
  useEffect(() => {
    if (!open) return
    setComposerOpen(false)
    setDraftName('')
    setCreating(false)
    setBusy('idle')
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const defaultCount = countsByFolder.get(null) ?? 0
  const orderedFolders = useMemo(() => folders, [folders])

  if (!open) return null

  const handlePick = async (folderId: string | null) => {
    // Refuse a concurrent mutation while one is already in flight. The hook's
    // own pending-guard resolves false, which the caller would (correctly) treat
    // as a failure and surface a red error toast — even though the in-flight
    // write succeeds. Gating here keeps the second tap a clean no-op.
    if (busy !== 'idle') return
    setBusy(folderId === null ? '__default__' : folderId)
    try {
      await onPick(folderId)
      onClose()
    } catch {
      // Toast handled by caller
    } finally {
      setBusy('idle')
    }
  }

  const handleUnsave = async () => {
    if (busy !== 'idle') return
    setBusy('__unsave__')
    try {
      await onUnsave()
      onClose()
    } catch {
      // Toast handled by caller
    } finally {
      setBusy('idle')
    }
  }

  const handleCreate = async () => {
    const trimmed = draftName.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      const folder = await createFolder(trimmed)
      toast.success(`Ordner „${folder.name}" angelegt`)
      // Auto-pick the new folder for the current reel — that's the
      // reason the user invoked the create flow during a save action.
      await handlePick(folder.id)
    } catch {
      // useSavedFolders sets the human-readable error; surface via toast.
      toast.error('Ordner konnte nicht angelegt werden.')
    } finally {
      setCreating(false)
    }
  }

  // Portal to <body>: opened from a reel card (inside the feed's momentum-scroll
  // <main>), a plain `position: fixed` is trapped by iOS WKWebView and painted
  // under the bottom nav. As a body child it is truly viewport-fixed.
  return createPortal(
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="In Ordner speichern"
      onClick={onClose}
      style={{ paddingBottom: 'var(--keyboard-height, 0px)' }}
    >
      <div
        data-kb-pinned-composer
        className="w-full max-w-[480px] rounded-t-[24px] bg-white px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-12px_30px_rgba(0,0,0,0.18)]"
        onClick={(event) => event.stopPropagation()}
        // Stop touch events from bubbling through the body portal up the React
        // tree to a host gesture handler (PortfolioLightbox reel-nav swipe /
        // ExploreReelCard asset swipe). Scrolling the folder list or pulling the
        // grabber pill must not flip the reel behind the sheet.
        onTouchStart={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
        onTouchEnd={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" aria-hidden />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-slate-900">Speichern in</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600"
            aria-label="Schließen"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {error ? (
          <p className="mb-2 rounded-card bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-600">
            {error}
          </p>
        ) : null}

        <ul className="max-h-[44dvh] divide-y divide-slate-100 overflow-y-auto">
          <li>
            <FolderRow
              label="Alle gespeicherten"
              sublabel="Standard-Ordner"
              count={defaultCount}
              selected={isSaved && (currentFolderId ?? null) === null}
              busy={busy === '__default__'}
              onClick={() => handlePick(null)}
            />
          </li>
          {orderedFolders.map((folder) => (
            <li key={folder.id}>
              <FolderRow
                label={folder.name}
                count={countsByFolder.get(folder.id) ?? 0}
                selected={isSaved && currentFolderId === folder.id}
                busy={busy === folder.id}
                onClick={() => handlePick(folder.id)}
              />
            </li>
          ))}
          {!loading && hydrated && orderedFolders.length === 0 ? (
            <li className="py-3 text-center text-[12px] text-slate-500">
              Noch keine eigenen Ordner. Lege unten einen an.
            </li>
          ) : null}
        </ul>

        <div className="mt-3 border-t border-slate-100 pt-3">
          {composerOpen ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void handleCreate()
              }}
              className="flex items-center gap-2"
            >
              <input
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="Ordnername"
                maxLength={60}
                className="flex-1 rounded-card bg-slate-50 px-3 py-2 text-[14px] text-slate-900 outline-none ring-1 ring-slate-200 focus:ring-slate-900"
                aria-label="Ordnername"
              />
              <button
                type="submit"
                disabled={creating || draftName.trim().length === 0}
                className="rounded-full bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {creating ? 'Anlegen…' : 'Anlegen'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setComposerOpen(false)
                  setDraftName('')
                }}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600"
                aria-label="Abbrechen"
              >
                <X size={14} aria-hidden />
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              className="flex w-full items-center gap-3 rounded-card px-2 py-3 text-left text-[14px] text-slate-900 hover:bg-slate-50"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                <FolderPlus size={16} aria-hidden />
              </span>
              <span className="flex-1 font-semibold">Neuer Ordner</span>
            </button>
          )}
        </div>

        {isSaved ? (
          <button
            type="button"
            onClick={() => void handleUnsave()}
            disabled={busy === '__unsave__'}
            className="mt-2 flex w-full items-center gap-3 rounded-card px-2 py-3 text-left text-[14px] text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-red-50">
              <Trash2 size={16} aria-hidden />
            </span>
            <span className="flex-1 font-semibold">
              {busy === '__unsave__' ? 'Wird entfernt…' : 'Aus Gespeicherten entfernen'}
            </span>
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

function FolderRow({
  label,
  sublabel,
  count,
  selected,
  busy,
  onClick,
}: {
  label: string
  sublabel?: string
  count: number
  selected: boolean
  busy: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center gap-3 px-2 py-3 text-left disabled:opacity-50"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700">
        <Bookmark size={16} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-slate-900">{label}</span>
        <span className="block text-[11px] text-slate-500">
          {sublabel ? `${sublabel} · ` : ''}
          {count} {count === 1 ? 'Reel' : 'Reels'}
        </span>
      </span>
      {selected ? (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-white">
          <Check size={12} aria-hidden />
        </span>
      ) : null}
    </button>
  )
}
