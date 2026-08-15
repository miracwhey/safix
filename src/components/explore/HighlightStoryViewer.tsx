import { useCallback, useEffect, useReducer } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ProviderHighlight } from '../../lib/highlights/highlightRepository'
import { useVideoTeardown } from '../../lib/media/useVideoTeardown'

const IMAGE_DURATION_MS = 5_000
const MAX_VIDEO_DURATION_MS = 15_000

type Props = {
  highlights: ProviderHighlight[]
  startHighlightIndex: number
  providerName: string
  providerAvatarUrl?: string | null
  onClose: () => void
}

type State = {
  hlIdx: number
  itemIdx: number
  animKey: number
  itemDuration: number
}

type Action =
  | { type: 'NEXT'; itemCount: number; hlCount: number }
  | { type: 'PREV' }
  | { type: 'SET_DURATION'; ms: number }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'NEXT': {
      const nextItem = state.itemIdx + 1
      if (nextItem < action.itemCount) {
        return { ...state, itemIdx: nextItem, itemDuration: IMAGE_DURATION_MS, animKey: state.animKey + 1 }
      }
      if (state.hlIdx + 1 < action.hlCount) {
        return { hlIdx: state.hlIdx + 1, itemIdx: 0, itemDuration: IMAGE_DURATION_MS, animKey: state.animKey + 1 }
      }
      return state
    }
    case 'PREV': {
      if (state.itemIdx > 0) {
        return { ...state, itemIdx: state.itemIdx - 1, itemDuration: IMAGE_DURATION_MS, animKey: state.animKey + 1 }
      }
      if (state.hlIdx > 0) {
        return { hlIdx: state.hlIdx - 1, itemIdx: 0, itemDuration: IMAGE_DURATION_MS, animKey: state.animKey + 1 }
      }
      return state
    }
    case 'SET_DURATION':
      return { ...state, itemDuration: action.ms, animKey: state.animKey + 1 }
  }
}

export default function HighlightStoryViewer({
  highlights,
  startHighlightIndex,
  providerName,
  providerAvatarUrl,
  onClose,
}: Props) {
  const [{ hlIdx, itemIdx, animKey, itemDuration }, dispatch] = useReducer(reducer, {
    hlIdx: startHighlightIndex,
    itemIdx: 0,
    animKey: 0,
    itemDuration: IMAGE_DURATION_MS,
  })

  const currentHighlight = highlights[hlIdx]
  const items = currentHighlight?.items ?? []
  const currentItem = items[itemIdx]
  const isVideo = currentItem?.mediaType === 'video'

  const goNext = useCallback(() => {
    if (itemIdx + 1 >= items.length && hlIdx + 1 >= highlights.length) {
      onClose()
    } else {
      dispatch({ type: 'NEXT', itemCount: items.length, hlCount: highlights.length })
    }
  }, [itemIdx, items.length, hlIdx, highlights.length, onClose])

  const goPrev = useCallback(() => {
    dispatch({ type: 'PREV' })
  }, [])

  // Auto-advance images via timer.
  useEffect(() => {
    if (!currentItem || isVideo) return
    const t = setTimeout(goNext, itemDuration)
    return () => clearTimeout(t)
  }, [currentItem, isVideo, goNext, itemDuration])

  // Video safety net: a normal clip advances via onEnded at its true end, and a
  // decode failure / null src advances via onError. This is only the hard
  // backstop for when NEITHER fires (a silent stall). It is fixed at the 15s
  // story cap (+500ms), NOT itemDuration: before onLoadedMetadata refines it,
  // itemDuration is the 5s IMAGE default, and arming the cap there would skip a
  // slow-buffering clip before it ever played. A >15s clip is intentionally
  // advanced at the cap to keep story pacing.
  useEffect(() => {
    if (!currentItem || !isVideo) return
    const t = setTimeout(goNext, MAX_VIDEO_DURATION_MS + 500)
    return () => clearTimeout(t)
  }, [currentItem, isVideo, goNext])

  // Release the decoder/source on close + every item swap. iOS WKWebView caps
  // concurrent media decoders; the muted story <video> remounts per item via
  // its key, so detach the outgoing source instead of leaking a held decoder.
  const videoRef = useVideoTeardown(`${hlIdx}-${itemIdx}`)

  if (!currentHighlight || !currentItem) return null

  // Portal to document.body: this fullscreen viewer is opened from the
  // immersive Explore feed, whose transformed/scrolled ancestor would trap
  // `position:fixed` in iOS WKWebView and clip / misposition the story.
  const story = (
    <div
      className="fixed inset-0 z-50 bg-black"
      style={{ touchAction: 'none' }}
    >
      {/* Media — key forces remount on item change */}
      {isVideo ? (
        <video
          key={`${hlIdx}-${itemIdx}`}
          ref={videoRef}
          src={currentItem.publicUrl ?? undefined}
          className="h-full w-full object-cover"
          autoPlay
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const dur = e.currentTarget.duration
            if (dur && Number.isFinite(dur)) {
              dispatch({ type: 'SET_DURATION', ms: Math.min(dur * 1000, MAX_VIDEO_DURATION_MS) })
            }
          }}
          onEnded={goNext}
          onError={goNext}
        />
      ) : (
        <img
          key={`${hlIdx}-${itemIdx}`}
          src={currentItem.publicUrl ?? ''}
          alt=""
          className="h-full w-full object-cover"
        />
      )}

      {/* Top fade — darkens behind progress bars + header */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/60 to-transparent" />

      {/* Bottom fade — darkens behind metadata pill */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Progress bars */}
      <div className="absolute inset-x-2 top-[max(44px,env(safe-area-inset-top))] flex gap-[3px] pt-2">
        {items.map((_, i) => (
          <div
            key={i}
            className="h-[2px] flex-1 overflow-hidden rounded-full bg-white/30"
          >
            {i < itemIdx ? (
              <div className="h-full w-full bg-white" />
            ) : i === itemIdx ? (
              <div
                key={animKey}
                className="h-full bg-white"
                style={{
                  animation: `storyProgress ${itemDuration}ms linear forwards`,
                }}
              />
            ) : null}
          </div>
        ))}
      </div>

      {/* Header — provider info + close */}
      <div className="absolute inset-x-0 top-[max(52px,calc(env(safe-area-inset-top)+8px))] flex items-center gap-2.5 px-3 pt-7">
        {providerAvatarUrl ? (
          <img
            src={providerAvatarUrl}
            alt=""
            className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-white/40"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/20 text-[12px] font-semibold text-white ring-1 ring-white/40">
            {providerName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight text-white drop-shadow">
            {providerName}
          </p>
          <p className="truncate text-[11px] leading-tight text-white/65">
            {currentHighlight.title}
            {items.length > 1 ? ` · ${itemIdx + 1} / ${items.length}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-sm"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {/* Tap zones — below header/metadata in paint order, but full-screen */}
      <div className="absolute inset-0 flex">
        <button
          type="button"
          aria-label="Vorheriges"
          onClick={goPrev}
          className="flex-1 focus:outline-none"
        />
        <button
          type="button"
          aria-label="Nächstes"
          onClick={goNext}
          className="flex-1 focus:outline-none"
        />
      </div>

      {/* Bottom metadata — liquid glass, pointer-events-none so tap zones work through */}
      <div className="pointer-events-none absolute inset-x-4 bottom-[max(24px,env(safe-area-inset-bottom))]">
        <div className="liquid-glass-dark rounded-2xl px-4 py-3">
          <p className="text-[13px] font-semibold text-white">{currentHighlight.title}</p>
          {items.length > 1 && (
            <p className="mt-0.5 text-[11px] text-white/60">
              {itemIdx + 1} von {items.length}
            </p>
          )}
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? story : createPortal(story, document.body)
}
