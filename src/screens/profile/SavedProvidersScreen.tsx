import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, Bookmark, BookmarkX, MapPin } from 'lucide-react'
import AppShell from '../../components/AppShell'
import ScreenSkeleton from '../../components/system/ScreenSkeleton'
import {
  listSavedProvidersWithDetails,
  unsaveProvider,
  type SavedProviderDetail,
} from '../../lib/savedProviders/savedProviderService'
import { supabase } from '../../lib/supabase'

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export default function SavedProvidersScreen() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState<SavedProviderDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Set<string>>(new Set())
  const generationRef = useRef(0)

  const fetchAll = useCallback(async () => {
    const generation = ++generationRef.current
    setError(null)
    try {
      const data = await listSavedProvidersWithDetails()
      if (generation !== generationRef.current) return
      setEntries(data)
    } catch {
      if (generation !== generationRef.current) return
      setError('Gespeicherte Handwerker konnten nicht geladen werden.')
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    const init = async () => {
      const { data } = await supabase.auth.getSession()
      const userId = data.session?.user?.id ?? null
      if (cancelled) return
      await fetchAll()
      if (cancelled || !userId) return

      channel = supabase
        .channel(`saved-providers-screen-${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'provider_saves', filter: `user_id=eq.${userId}` },
          () => {
            if (!cancelled) void fetchAll()
          },
        )
        .subscribe()
    }

    void init()

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [fetchAll])

  const handleRemove = async (providerId: string) => {
    if (removing.has(providerId)) return
    setRemoving((s) => new Set(s).add(providerId))
    try {
      await unsaveProvider(providerId)
      setEntries((prev) => prev.filter((e) => e.providerId !== providerId))
    } finally {
      setRemoving((s) => {
        const next = new Set(s)
        next.delete(providerId)
        return next
      })
    }
  }

  if (loading) {
    return (
      <AppShell active="profile">
        <ScreenSkeleton variant="detail" />
      </AppShell>
    )
  }

  return (
    <AppShell active="profile">
      <div className="mx-auto w-full max-w-[680px] px-4 pb-12 pt-3">
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink"
            aria-label="Zurück"
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <h1 className="flex-1 truncate text-[18px] font-semibold text-ink">
            Gespeicherte Handwerker
          </h1>
        </div>

        {error ? (
          <p className="mb-4 rounded-card bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-600">
            {error}
          </p>
        ) : null}

        {entries.length === 0 ? (
          <div className="mt-8 rounded-card border border-dashed border-edge p-6 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-ink-muted">
              <Bookmark size={18} aria-hidden />
            </div>
            <p className="text-[14px] font-semibold text-ink">Noch keine Handwerker gespeichert</p>
            <p className="mt-1 text-[12px] text-ink-muted">
              Tippe auf der Profilseite eines Handwerkers auf „Merken".
            </p>
            <Link
              to="/explore"
              className="mt-4 inline-flex items-center justify-center rounded-full bg-ink px-4 py-2 text-[12px] font-semibold text-white"
            >
              Handwerker entdecken
            </Link>
          </div>
        ) : (
          <>
            <p className="mb-3 text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              {entries.length} Handwerker
            </p>
            <ul className="space-y-2">
              {entries.map((entry) => (
                <ProviderRow
                  key={entry.providerId}
                  entry={entry}
                  removing={removing.has(entry.providerId)}
                  onRemove={() => void handleRemove(entry.providerId)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </AppShell>
  )
}

function ProviderRow({
  entry,
  removing,
  onRemove,
}: {
  entry: SavedProviderDetail
  removing: boolean
  onRemove: () => void
}) {
  const profilePath = `/explore/craftsman/${entry.providerId}`
  const firstCategory = entry.tradeCategories[0] ?? null

  return (
    <li className="flex items-center gap-3 rounded-container bg-surface px-4 py-3 ring-1 ring-edge shadow-elevated">
      <Link to={profilePath} className="flex flex-1 items-center gap-3 min-w-0">
        {entry.avatarUrl ? (
          <img
            src={entry.avatarUrl}
            alt={entry.name}
            className="h-11 w-11 shrink-0 rounded-full object-cover ring-1 ring-edge"
          />
        ) : (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 ring-1 ring-edge">
            <span className="text-[15px] font-semibold text-slate-500">
              {getInitials(entry.name)}
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-ink">{entry.name}</p>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-muted">
            {firstCategory ? <span className="truncate">{firstCategory}</span> : null}
            {entry.city ? (
              <span className="flex shrink-0 items-center gap-0.5">
                <MapPin size={10} aria-hidden />
                {entry.city}
              </span>
            ) : null}
          </div>
        </div>
      </Link>
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition active:scale-90 disabled:opacity-40"
        aria-label={`${entry.name} entfernen`}
      >
        <BookmarkX size={17} aria-hidden />
      </button>
    </li>
  )
}
