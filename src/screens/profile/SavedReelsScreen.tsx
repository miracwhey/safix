import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, FolderPlus, Bookmark } from 'lucide-react'
import AppShell from '../../components/AppShell'
import ScreenSkeleton from '../../components/system/ScreenSkeleton'
import { useSavedFolders } from '../../lib/savedReels/useSavedFolders'
import { useSavedReels } from '../../lib/savedReels/useSavedReels'
import { useToast } from '../../hooks/useToast'

const DEFAULT_ROUTE = 'default'

/**
 * Profile-Sub-Screen unter `/profile/saved-reels`.
 *
 * Listet Ordner als 2-spaltiges Tile-Grid. Erste Tile ist immer der
 * virtuelle Default-Ordner („Alle gespeicherten"). Tap auf eine Tile
 * navigiert zu `/profile/saved-reels/:folderId` (`:folderId === 'default'`
 * für den Default).
 *
 * Ordner-Cover: 2×2-Mosaik aus den 4 neuesten Reels, holt sich der
 * jeweilige Tile selber via `useSavedReels`. Vermeidet eine
 * Megaquery beim Mount, hält aber jede Tile billig (max 4 Bilder).
 */
export default function SavedReelsScreen() {
  const navigate = useNavigate()
  const toast = useToast()
  const folders = useSavedFolders()
  const [composerOpen, setComposerOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)

  const orderedFolders = useMemo(() => folders.folders, [folders.folders])
  const defaultCount = folders.countsByFolder.get(null) ?? 0

  const handleCreate = async () => {
    const trimmed = draftName.trim()
    if (!trimmed) return
    setCreating(true)
    try {
      await folders.createFolder(trimmed)
      setDraftName('')
      setComposerOpen(false)
      toast.success(`Ordner „${trimmed}" angelegt`)
    } catch {
      // Hook hat bereits state.error gesetzt; UI rendert das Banner.
    } finally {
      setCreating(false)
    }
  }

  if (!folders.hydrated) {
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
            onClick={() => navigate('/profile')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink"
            aria-label="Zurück"
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <h1 className="flex-1 truncate text-[18px] font-semibold text-ink">Gespeicherte Reels</h1>
          <button
            type="button"
            onClick={() => setComposerOpen((o) => !o)}
            className="flex h-9 items-center gap-1 rounded-full bg-ink px-3 text-[12px] font-semibold text-white"
            aria-label="Neuer Ordner"
          >
            <FolderPlus size={14} aria-hidden />
            <span>Ordner</span>
          </button>
        </div>

        {composerOpen ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleCreate()
            }}
            className="mb-3 flex items-center gap-2 rounded-card bg-canvas p-2"
          >
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Ordnername"
              maxLength={60}
              className="flex-1 rounded-card bg-white px-3 py-2 text-[14px] text-ink outline-none ring-1 ring-edge focus:ring-ink"
              aria-label="Ordnername"
            />
            <button
              type="submit"
              disabled={creating || draftName.trim().length === 0}
              className="rounded-full bg-ink px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40"
            >
              {creating ? 'Anlegen…' : 'Anlegen'}
            </button>
          </form>
        ) : null}

        {folders.error ? (
          <p className="mb-3 rounded-card bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-600">
            {folders.error}
          </p>
        ) : null}

        <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          {folders.totalSaved} {folders.totalSaved === 1 ? 'Reel' : 'Reels'} · {orderedFolders.length} {orderedFolders.length === 1 ? 'Ordner' : 'Ordner'}
        </p>

        <div className="grid grid-cols-2 gap-3">
          <FolderTile
            to={`/profile/saved-reels/${DEFAULT_ROUTE}`}
            title="Alle gespeicherten"
            subtitle="Standard"
            count={defaultCount}
            folderId={null}
          />
          {orderedFolders.map((folder) => (
            <FolderTile
              key={folder.id}
              to={`/profile/saved-reels/${folder.id}`}
              title={folder.name}
              count={folders.countsByFolder.get(folder.id) ?? 0}
              folderId={folder.id}
            />
          ))}
        </div>

        {orderedFolders.length === 0 && defaultCount === 0 ? (
          <div className="mt-8 rounded-card border border-dashed border-edge p-6 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-ink-muted">
              <Bookmark size={18} aria-hidden />
            </div>
            <p className="text-[14px] font-semibold text-ink">Noch nichts gespeichert</p>
            <p className="mt-1 text-[12px] text-ink-muted">
              Tippe das Lesezeichen auf einem Reel oder halte es lange für einen
              eigenen Ordner.
            </p>
            <Link
              to="/explore"
              className="mt-4 inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[12px] font-semibold text-white"
            >
              Reels entdecken
            </Link>
          </div>
        ) : null}
      </div>
    </AppShell>
  )
}

function FolderTile({
  to,
  title,
  subtitle,
  count,
  folderId,
}: {
  to: string
  title: string
  subtitle?: string
  count: number
  folderId: string | null
}) {
  const reels = useSavedReels(folderId)
  const cover = reels.entries.slice(0, 4)

  return (
    <Link
      to={to}
      className="group flex flex-col rounded-card bg-canvas ring-1 ring-edge transition active:scale-[0.99]"
    >
      <div className="relative grid aspect-[4/5] grid-cols-2 grid-rows-2 gap-[2px] overflow-hidden rounded-t-card bg-slate-200">
        {cover.length === 0 ? (
          <div className="col-span-2 row-span-2 flex items-center justify-center text-[11px] text-ink-muted">
            Leer
          </div>
        ) : (
          Array.from({ length: 4 }).map((_, i) => {
            const entry = cover[i]
            if (!entry) {
              return <div key={i} className="bg-slate-200" />
            }
            const item = entry.item
            const isVideo = item.mediaType === 'video'
            const src = isVideo ? item.posterUrl ?? item.publicUrl : item.publicUrl
            return (
              <div key={entry.mediaId} className="relative bg-slate-200">
                {src ? (
                  <img
                    src={src ?? undefined}
                    alt=""
                    aria-hidden
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : null}
              </div>
            )
          })
        )}
      </div>
      <div className="p-2.5">
        <p className="line-clamp-1 text-[13px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          {subtitle ? `${subtitle} · ` : ''}
          {count} {count === 1 ? 'Reel' : 'Reels'}
        </p>
      </div>
    </Link>
  )
}
