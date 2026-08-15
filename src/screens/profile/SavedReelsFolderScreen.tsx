import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, MoreVertical, Pencil, Play, Trash2, Image as ImageIcon } from 'lucide-react'
import AppShell from '../../components/AppShell'
import ScreenSkeleton from '../../components/system/ScreenSkeleton'
import PortfolioLightbox from '../../components/explore/PortfolioLightbox'
import { useSavedFolders } from '../../lib/savedReels/useSavedFolders'
import { useSavedReels } from '../../lib/savedReels/useSavedReels'
import { useToast } from '../../hooks/useToast'
import { supabase } from '../../lib/supabase'
import type { PortfolioItem } from '../../lib/providerMedia'

const DEFAULT_ROUTE = 'default'

/**
 * Profile-Sub-Screen `/profile/saved-reels/:folderId` (`:folderId` =
 * `'default'` für den virtuellen Default-Ordner, sonst Folder-UUID).
 *
 * Rendert ein 3-spaltiges Reel-Grid der gespeicherten Items für den
 * gewählten Ordner. Tap auf eine Tile öffnet den `PortfolioLightbox`
 * mit der Liste als Items + dem getappten Index als Start.
 *
 * ⋯-Menu (nur für Custom-Ordner): Umbenennen / Löschen. Default-Ordner
 * hat kein Menu — er ist virtuell.
 */
export default function SavedReelsFolderScreen() {
  const params = useParams<{ folderId?: string }>()
  const navigate = useNavigate()
  const toast = useToast()

  const isDefault = !params.folderId || params.folderId === DEFAULT_ROUTE
  const folderId = isDefault ? null : params.folderId ?? null

  const folders = useSavedFolders()
  const reels = useSavedReels(folderId)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setCurrentUserId(data.session?.user?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const folder = useMemo(
    () => (folderId ? folders.folders.find((f) => f.id === folderId) ?? null : null),
    [folders.folders, folderId],
  )

  // Folder gelöscht (oder fremder Folder) → zurück
  useEffect(() => {
    if (!folders.hydrated) return
    if (isDefault) return
    if (!folder) {
      navigate('/profile/saved-reels', { replace: true })
    }
  }, [folder, folders.hydrated, isDefault, navigate])

  const items: PortfolioItem[] = useMemo(() => reels.entries.map((e) => e.item), [reels.entries])

  const handleRename = async () => {
    if (!folder) return
    const trimmed = renameDraft.trim()
    if (!trimmed) return
    setRenameBusy(true)
    try {
      await folders.renameFolder(folder.id, trimmed)
      setRenameOpen(false)
      toast.success('Ordner umbenannt')
    } catch {
      // Fehler im Hook-State, hier ignorieren
    } finally {
      setRenameBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!folder) return
    setDeleteBusy(true)
    try {
      await folders.deleteFolder(folder.id)
      toast.success('Ordner gelöscht')
      navigate('/profile/saved-reels', { replace: true })
    } catch {
      setDeleteBusy(false)
    }
  }

  const title = isDefault ? 'Alle gespeicherten' : folder?.name ?? 'Ordner'

  if (!folders.hydrated || !reels.hydrated) {
    return (
      <AppShell active="profile">
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  return (
    <AppShell active="profile">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-12 pt-3">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/profile/saved-reels')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink"
            aria-label="Zurück"
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <h1 className="flex-1 truncate text-[18px] font-semibold text-ink">{title}</h1>
          {!isDefault && folder ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink"
                aria-label="Ordner-Optionen"
              >
                <MoreVertical size={18} aria-hidden />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-10 z-20 w-44 rounded-card bg-white p-1 shadow-lg ring-1 ring-edge">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      setRenameDraft(folder.name)
                      setRenameOpen(true)
                    }}
                    className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-[13px] text-ink hover:bg-canvas"
                  >
                    <Pencil size={14} aria-hidden />
                    Umbenennen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      void handleDelete()
                    }}
                    disabled={deleteBusy}
                    className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden />
                    {deleteBusy ? 'Wird gelöscht…' : 'Ordner löschen'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {renameOpen && folder ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleRename()
            }}
            className="mb-3 flex items-center gap-2 rounded-card bg-canvas p-2"
          >
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={60}
              className="flex-1 rounded-card bg-white px-3 py-2 text-[14px] text-ink outline-none ring-1 ring-edge focus:ring-ink"
              aria-label="Neuer Ordnername"
            />
            <button
              type="submit"
              disabled={renameBusy || renameDraft.trim().length === 0}
              className="rounded-full bg-ink px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
            >
              {renameBusy ? 'Speichern…' : 'Speichern'}
            </button>
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              className="rounded-full bg-white px-3 py-2 text-[12px] font-semibold text-ink ring-1 ring-edge"
            >
              Abbrechen
            </button>
          </form>
        ) : null}

        {folders.error ? (
          <p className="mb-3 rounded-card bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-600">
            {folders.error}
          </p>
        ) : null}

        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          {items.length} {items.length === 1 ? 'Reel' : 'Reels'}
        </p>

        {items.length === 0 ? (
          <div className="mt-8 rounded-card border border-dashed border-edge p-6 text-center">
            <p className="text-[14px] font-semibold text-ink">Ordner ist leer</p>
            <p className="mt-1 text-[12px] text-ink-muted">
              Beim Speichern eines Reels lange auf das Lesezeichen halten und
              {' '}
              <span className="font-semibold text-ink">{title}</span>
              {' '}
              wählen.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-[3px]">
            {items.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setLightbox({ open: true, index: idx })}
                className="relative aspect-[3/4] overflow-hidden bg-slate-200"
                aria-label={item.title ?? item.caption ?? 'Reel öffnen'}
              >
                {item.posterUrl || item.publicUrl ? (
                  <img
                    src={(item.mediaType === 'video' ? item.posterUrl : null) ?? item.publicUrl ?? ''}
                    alt=""
                    aria-hidden
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-ink-muted">
                    <ImageIcon size={18} aria-hidden />
                  </div>
                )}
                <span className="absolute right-1.5 top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-black/60 px-1 text-white">
                  {item.mediaType === 'video' ? (
                    <Play size={10} aria-hidden />
                  ) : (
                    <ImageIcon size={10} aria-hidden />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <PortfolioLightbox
        open={lightbox.open}
        items={items}
        startIndex={lightbox.index}
        onClose={() => setLightbox({ open: false, index: 0 })}
        currentUserId={currentUserId}
        providerOwnerUserId={null}
      />
    </AppShell>
  )
}
