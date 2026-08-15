import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, Play, Image as ImageIcon, Trash2 } from 'lucide-react'
import AppShell from '../components/AppShell'
import {
  fetchHighlightsForProvider,
  createHighlight,
  updateHighlight,
  deleteHighlight,
  replaceHighlightItems,
  type ProviderHighlight,
} from '../lib/highlights/highlightRepository'
import { getMyCraftsmanBusinessProfile } from '../lib/craftsman/craftsmanProfileService'
import { fetchOwnerPortfolio } from '../lib/providerMedia'
import type { PortfolioItem } from '../lib/providerMedia'
import { getPlaybackBlockReason, selectVideoSource } from '../lib/media/playbackCompat'
import { logError } from '../lib/observability'
import { useSmartBack } from '../hooks/useSmartBack'

const MAX_ITEMS = 10

export default function HighlightEditScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/highlights')
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'

  const [title, setTitle] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [portfolioItems, setPortfolioItems] = useState<PortfolioItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const existingHighlight = useRef<ProviderHighlight | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const profile = await getMyCraftsmanBusinessProfile()
        if (cancelled || !profile) return
        setUserId(profile.userId)

        const [items, highlights] = await Promise.all([
          fetchOwnerPortfolio(profile.providerId ?? ''),
          isNew ? Promise.resolve([]) : fetchHighlightsForProvider(profile.userId),
        ])
        if (cancelled) return
        setPortfolioItems(items.filter((it) => it.published !== false))

        if (!isNew && id) {
          const hl = highlights.find((h) => h.id === id) ?? null
          existingHighlight.current = hl
          if (hl) {
            setTitle(hl.title)
            setSelectedIds(new Set(hl.items.map((it) => it.portfolioItemId)))
          }
        }
      } catch (err) {
        logError('ui.highlight_edit.load_failed', err, { id })
        if (!cancelled) setError('Daten konnten nicht geladen werden.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [id, isNew])

  const toggleItem = useCallback(
    (portfolioItemId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(portfolioItemId)) {
          next.delete(portfolioItemId)
        } else if (next.size < MAX_ITEMS) {
          next.add(portfolioItemId)
        }
        return next
      })
    },
    [],
  )

  async function handleSave() {
    const trimmed = title.trim()
    if (!trimmed) { setError('Bitte einen Namen eingeben.'); return }
    if (!userId) return
    setSaving(true)
    setError(null)
    try {
      // selectedIds contains portfolio item IDs (provider_media.id = PortfolioItem.id)
      const portfolioItemIds = portfolioItems
        .filter((it) => selectedIds.has(it.id))
        .map((it) => it.id)

      let hlId: string
      if (isNew) {
        hlId = await createHighlight(userId, trimmed, 0)
      } else {
        hlId = id!
        await updateHighlight(hlId, { title: trimmed })
      }
      await replaceHighlightItems(hlId, portfolioItemIds)
      navigate('/craftsman/highlights', { replace: true })
    } catch (err) {
      logError('ui.highlight_edit.save_failed', err, { id })
      setError('Speichern fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!id || isNew) return
    if (!window.confirm('Highlight wirklich löschen?')) return
    setDeleting(true)
    try {
      await deleteHighlight(id)
      navigate('/craftsman/highlights', { replace: true })
    } catch (err) {
      logError('ui.highlight_edit.delete_failed', err, { id })
      setError('Löschen fehlgeschlagen.')
      setDeleting(false)
    }
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
          <span className="flex-1 truncate text-[15px] font-semibold text-ink">
            {isNew ? 'Neues Highlight' : 'Highlight bearbeiten'}
          </span>
          {!isNew && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="flex h-9 w-9 items-center justify-center rounded-full text-danger disabled:opacity-50"
              aria-label="Highlight löschen"
            >
              <Trash2 size={18} aria-hidden />
            </button>
          )}
        </div>

        <div className="px-4 pb-6">
          {loading ? (
            <div className="space-y-3 pt-4">
              <div className="h-12 animate-pulse rounded-xl bg-slate-100" />
              <div className="grid grid-cols-3 gap-[2px]">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="aspect-[9/16] animate-pulse bg-slate-100" />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* Name input */}
              <div className="pt-4">
                <label className="mb-1.5 block text-[12px] font-semibold text-ink-muted">
                  Name (max. 30 Zeichen)
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value.slice(0, 30))}
                  placeholder="z. B. Elektrik"
                  className="w-full rounded-xl bg-surface px-3 py-3 text-[15px] font-semibold text-ink ring-1 ring-edge placeholder:font-normal placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                  autoFocus={isNew}
                />
                <p className="mt-1 text-right text-[11px] text-ink-muted">{title.length} / 30</p>
              </div>

              {/* Portfolio grid selection */}
              <div className="mt-4">
                <p className="mb-2 text-[12px] font-semibold text-ink-muted">
                  Videos auswählen{' '}
                  <span className="font-normal text-ink-muted">
                    ({selectedIds.size} / {MAX_ITEMS})
                  </span>
                </p>

                {portfolioItems.length === 0 ? (
                  <p className="py-8 text-center text-[13px] text-ink-muted">
                    Noch keine veröffentlichten Arbeitsproben.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-[2px]">
                    {portfolioItems.map((item) => {
                          const selected = selectedIds.has(item.id)
                      const isVideo = item.mediaType === 'video'
                      const blockReason = isVideo ? getPlaybackBlockReason(item) : null

                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={!selected && selectedIds.size >= MAX_ITEMS}
                          className={`relative aspect-[9/16] overflow-hidden bg-slate-900 transition-opacity ${
                            !selected && selectedIds.size >= MAX_ITEMS ? 'opacity-40' : ''
                          }`}
                          onClick={() => toggleItem(item.id)}
                        >
                          {item.publicUrl ? (
                            isVideo ? (
                              <video
                                src={selectVideoSource(item) ?? undefined}
                                poster={item.posterUrl ?? undefined}
                                className="h-full w-full object-cover"
                                muted
                                preload="metadata"
                                playsInline
                              />
                            ) : (
                              <img
                                src={item.publicUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            )
                          ) : null}

                          {/* Dark overlay for non-selected */}
                          {!selected && (
                            <div className="pointer-events-none absolute inset-0 bg-black/20" />
                          )}

                          {/* Checkmark / empty circle */}
                          <div
                            className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full ${
                              selected
                                ? 'bg-brand ring-2 ring-white'
                                : 'border-[1.5px] border-white/70 bg-black/30'
                            }`}
                          >
                            {selected && <Check size={11} className="text-white" aria-hidden />}
                          </div>

                          {/* Media type indicator */}
                          {isVideo && !blockReason && (
                            <span className="pointer-events-none absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white">
                              <Play size={9} aria-hidden fill="currentColor" />
                            </span>
                          )}
                          {isVideo && blockReason && (
                            <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/65 px-1.5 py-[2px] text-[9px] font-semibold text-white">
                              {blockReason.shortLabel}
                            </span>
                          )}
                          {!isVideo && (
                            <span className="pointer-events-none absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white">
                              <ImageIcon size={9} aria-hidden />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>

              {error && (
                <p className="mt-3 text-[13px] text-danger">{error}</p>
              )}

              {/* Save button */}
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !title.trim()}
                className="mt-6 w-full rounded-2xl bg-brand py-4 text-[15px] font-semibold text-white transition active:scale-[0.99] disabled:opacity-50"
              >
                {saving ? 'Speichern …' : 'Speichern'}
              </button>
            </>
          )}
        </div>
      </div>
    </AppShell>
  )
}
