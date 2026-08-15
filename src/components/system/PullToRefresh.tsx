import { useEffect, useRef, useState, type ReactNode } from 'react'
import Spinner from './Spinner'

/**
 * Pull-to-Refresh (Loading-Patterns handoff · Baustein 05).
 *
 * FixUp had no pull-to-refresh anywhere. This is the canonical one: a
 * rubber-band drag (resistance 0.55) that reveals the arc spinner, snaps back
 * with the liquid curve, and triggers `onRefresh`. translateY only → GPU.
 *
 * AppShell-aware: it does NOT create its own scroller (that would nest inside
 * AppShell's `[data-app-scroll]` container). Instead it attaches to the nearest
 * `[data-app-scroll]` ancestor and only engages when that container is scrolled
 * to the very top. If no such container exists it renders children statically
 * (safe no-op) — so it never breaks a surface it is dropped into.
 *
 * The gesture wants a real-device tuning pass (WKWebView overscroll) before it
 * is considered final; thresholds/resistance are the design defaults.
 */

const RESISTANCE = 0.55
const THRESHOLD_PX = 58
const MAX_PULL_PX = 150

type Phase = 'idle' | 'pull' | 'ready' | 'refresh' | 'done'

type Props = {
  onRefresh: () => Promise<void> | void
  children: ReactNode
  /** Disable the gesture (e.g. while a modal is open). */
  disabled?: boolean
  className?: string
}

const LABEL: Record<Phase, string> = {
  idle: 'Zum Aktualisieren ziehen',
  pull: 'Zum Aktualisieren ziehen',
  ready: 'Loslassen zum Aktualisieren',
  refresh: 'Aktualisiere …',
  done: 'Aktualisiert',
}

export default function PullToRefresh({ onRefresh, children, disabled = false, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const spinnerRef = useRef<HTMLDivElement>(null)

  const [phase, setPhase] = useState<Phase>('idle')

  // Mutable gesture state kept in refs — the touchmove listener is attached
  // once and must read live values, not stale closure snapshots.
  const startY = useRef(0)
  const pull = useRef(0)
  const dragging = useRef(false)
  const busy = useRef(false)

  useEffect(() => {
    const wrap = wrapRef.current
    const content = contentRef.current
    const spinner = spinnerRef.current
    const scroller = wrap?.closest('[data-app-scroll]') as HTMLElement | null
    // No AppShell scroll container → render statically, never hijack anything.
    if (!wrap || !content || !scroller) return

    const setContentTransition = (t: string) => {
      content.style.transition = t
    }
    const translate = (y: number) => {
      content.style.transform = `translateY(${y}px)`
      if (spinner) {
        const p = Math.min(1, y / THRESHOLD_PX)
        spinner.style.opacity = String(p)
        spinner.style.transform = `translateX(-50%) scale(${0.55 + p * 0.45})`
      }
    }
    const snapBack = () => {
      setContentTransition('transform .45s cubic-bezier(0.16,1,0.3,1)')
      content.style.transform = 'translateY(0px)'
      if (spinner) {
        spinner.style.transition = 'opacity .3s ease, transform .3s ease'
        spinner.style.opacity = '0'
        spinner.style.transform = 'translateX(-50%) scale(.55)'
      }
    }

    const finishRefresh = async () => {
      try {
        await onRefresh()
      } finally {
        setContentTransition('transform .35s cubic-bezier(0.16,1,0.3,1)')
        content.style.transform = 'translateY(0px)'
        if (spinner) {
          spinner.style.transition = 'opacity .3s ease, transform .3s ease'
          spinner.style.opacity = '0'
        }
        setPhase('done')
        window.setTimeout(() => {
          busy.current = false
          setPhase('idle')
        }, 600)
      }
    }

    const onTouchStart = (e: TouchEvent) => {
      if (disabled || busy.current) return
      if (scroller.scrollTop > 0) return
      startY.current = e.touches[0].clientY
      pull.current = 0
      dragging.current = true
      setContentTransition('none')
      if (spinner) spinner.style.transition = 'none'
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging.current) return
      // A downward drag that isn't at the top, or an upward swipe, is a normal
      // scroll — release the gesture and let the container scroll.
      const delta = e.touches[0].clientY - startY.current
      if (delta <= 0 || scroller.scrollTop > 0) {
        dragging.current = false
        translate(0)
        return
      }
      // Own the gesture: stop the scroll container from also moving.
      if (e.cancelable) e.preventDefault()
      const y = Math.min(MAX_PULL_PX, delta * RESISTANCE)
      pull.current = y
      translate(y)
      setPhase(y > THRESHOLD_PX ? 'ready' : 'pull')
    }

    const onTouchEnd = () => {
      if (!dragging.current) return
      dragging.current = false
      if (pull.current > THRESHOLD_PX) {
        busy.current = true
        setPhase('refresh')
        setContentTransition('transform .35s cubic-bezier(0.16,1,0.3,1)')
        content.style.transform = 'translateY(50px)'
        if (spinner) {
          spinner.style.transition = 'opacity .2s ease, transform .2s ease'
          spinner.style.opacity = '1'
          spinner.style.transform = 'translateX(-50%) scale(1)'
        }
        void finishRefresh()
      } else {
        snapBack()
        setPhase('idle')
      }
    }

    // touchmove must be non-passive so preventDefault() can claim the pull.
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('touchend', onTouchEnd, { passive: true })
    scroller.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
      scroller.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [onRefresh, disabled])

  return (
    <div ref={wrapRef} className={`relative ${className ?? ''}`}>
      {/* Reveal spinner — pinned near the top of the pulled area, driven
          imperatively by the drag. Sits behind the content wrapper. */}
      <div
        ref={spinnerRef}
        className="pointer-events-none absolute left-1/2 top-2 z-0 flex flex-col items-center gap-1.5"
        style={{ transform: 'translateX(-50%) scale(.55)', opacity: 0 }}
        aria-hidden={phase === 'idle'}
      >
        <Spinner size="md" tone="brand" />
        <span className="whitespace-nowrap text-[11px] font-semibold text-slate-400">{LABEL[phase]}</span>
      </div>

      <div ref={contentRef} className="relative z-10 will-change-transform">
        {children}
      </div>
    </div>
  )
}
