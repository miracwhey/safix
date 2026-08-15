import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Lock, Plus } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  fetchHighlightsForProvider,
  type ProviderHighlight,
} from '../lib/highlights/highlightRepository'
import { getMyCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import { logError } from '../lib/observability'
import { useSubscription } from '../hooks/useSubscription'
import ProActionGuard from '../components/subscription/ProActionGuard'
import { useSmartBack } from '../hooks/useSmartBack'

const FREE_HIGHLIGHT_LIMIT = 1

export default function HighlightManagerScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/profile')
  const subscription = useSubscription()
  const [highlights, setHighlights] = useState<ProviderHighlight[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const profile = await getMyCraftsmanBusinessProfile()
        if (cancelled || !profile) return
        const hls = await fetchHighlightsForProvider(profile.userId)
        if (cancelled) return
        setHighlights(hls)
      } catch (err) {
        logError('ui.highlight_manager.load_failed', err, {})
        if (!cancelled) setError('Highlights konnten nicht geladen werden.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const isAtFreeLimit =
    subscription.scope === 'owner' &&
    (subscription.effectiveState === 'trial_available' || subscription.effectiveState === 'expired') &&
    highlights.length >= FREE_HIGHLIGHT_LIMIT

  function handleCreate() {
    navigate('/craftsman/highlights/new')
  }

  function handleEdit(id: string) {
    navigate(`/craftsman/highlights/${id}`)
  }

  return (
    <AppShell active="profile" noSafeTop>
      <div className="mx-auto w-full max-w-[420px]">
        {/* Topbar */}
        <div className="sticky top-0 z-30 flex h-[calc(env(safe-area-inset-top,0px)+48px)] items-end gap-2 bg-canvas/95 px-3 pb-2 backdrop-blur">
          <button
            type="button"
            onClick={goBack}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
            aria-label="Zurück"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          <span className="flex-1 truncate text-[15px] font-semibold text-ink">Highlights</span>
          <ProActionGuard
            action="create_highlight_extra"
            effectiveState={subscription.effectiveState}
            scope={subscription.scope}
            onAction={handleCreate}
          >
            {(guardedClick) => (
              <button
                type="button"
                onClick={isAtFreeLimit ? guardedClick : handleCreate}
                className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-3 text-[13px] font-semibold text-white"
              >
                {isAtFreeLimit ? <Lock size={13} aria-hidden /> : <Plus size={14} aria-hidden />}
                Neu
              </button>
            )}
          </ProActionGuard>
        </div>

        <div className="px-4 pb-6 pt-2">
          {loading ? (
            <div className="space-y-3 pt-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-slate-100" />
              ))}
            </div>
          ) : error ? (
            <p className="pt-4 text-[13px] text-danger">{error}</p>
          ) : (
            <div className="space-y-3 pt-2">
              {highlights.map((hl) => (
                <HighlightRow key={hl.id} highlight={hl} onEdit={() => handleEdit(hl.id)} />
              ))}

              <button
                type="button"
                onClick={handleCreate}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-edge py-5 text-[14px] font-medium text-ink-muted transition active:bg-canvas"
              >
                <Plus size={18} aria-hidden />
                Neues Highlight erstellen
              </button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  )
}

function HighlightRow({
  highlight,
  onEdit,
}: {
  highlight: ProviderHighlight
  onEdit: () => void
}) {
  const cover = highlight.coverPublicUrl ?? highlight.items[0]?.publicUrl ?? null
  const previewItems = highlight.items.slice(0, 3)

  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex w-full items-center gap-3 rounded-2xl bg-surface p-3 shadow-subtle ring-1 ring-edge transition active:scale-[0.99]"
    >
      {/* Cover ring */}
      <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 via-rose-500 to-fuchsia-500 p-[2px]">
        <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 border-surface bg-surface">
          {cover ? (
            <img src={cover} alt="" className="h-full w-full rounded-full object-cover" loading="lazy" />
          ) : (
            <span className="text-[16px] font-semibold text-ink-sub">
              {highlight.title.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
      </span>

      {/* Name + count */}
      <div className="min-w-0 flex-1 text-left">
        <p className="truncate text-[14px] font-semibold text-ink">{highlight.title}</p>
        <p className="text-[12px] text-ink-muted">
          {highlight.items.length} {highlight.items.length === 1 ? 'Video' : 'Videos'}
        </p>
      </div>

      {/* Preview thumbnails */}
      <div className="flex shrink-0 gap-1">
        {previewItems.map((item) =>
          item.publicUrl ? (
            <div
              key={item.id}
              className="h-[44px] w-[33px] overflow-hidden rounded-md bg-slate-200"
            >
              <img
                src={item.publicUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </div>
          ) : null,
        )}
      </div>

      <ChevronRight size={16} className="shrink-0 text-ink-muted" aria-hidden />
    </button>
  )
}
