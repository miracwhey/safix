/**
 * Spatial · CraftsmanSpatialToolBar
 *
 * Curated placement palette for the craftsman manual-room editor in the 3D /
 * Begehen views (Part C). Unlike the customer tool-bar this is NOT the full
 * furniture catalog — only the trade-relevant "Elektro + Sanitär-Kern": openings
 * (Tür/Fenster), wall-mounted electrics (Steckdose/Schalter/Sicherungskasten/
 * Heizkörper), sanitary fixtures (Badewanne/Waschbecken/WC) and the wall finish.
 * Decorative furniture (sofa/bed/…) is intentionally excluded.
 *
 * V1.6.1 morph (Decision B1): single-container width-morph identical to
 * {@link CustomerSpatialToolBar} — collapsed to a 132px "Auswahl"-anchor pill
 * (reclaims the 3D canvas) that morphs into the full tool-strip when tapped.
 * "Auswahl" (no tool) is the edit/select mode: tap an existing object to move/
 * resize/delete it. The 10 tools live in a horizontally-scrollable row (more
 * than the customer's 5 → the expanded strip scrolls).
 *
 * iOS double-fire guard: a chip fires on `onPointerUp` (touch) AND the synthetic
 * `click` iOS replays after it. Without a guard a single tap toggled a tool on
 * then instantly back off (`activeTool=null` → nothing places). The
 * `lastTouchHandledAt` stamp drops the synthetic click within 600ms of a touch
 * pointer-up (mouse clicks pass straight through). With the guard, the tool
 * chips keep their toggle-to-deselect behaviour (tap an armed tool again →
 * Auswahl) safely — the anchor stays the pure expand/collapse control.
 *
 * Controlled via `activeTool` / `onSelectTool`. Optional `counts` renders a
 * per-tool placement badge (host derives it from the live scene).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'

export type CraftsmanSpatialTool =
  | 'door'
  | 'window'
  | 'outlet'
  | 'switch'
  | 'fusebox'
  | 'radiator'
  | 'bathtub'
  | 'sink'
  | 'toilet'
  | 'material'

interface ToolMeta {
  key: CraftsmanSpatialTool
  label: string
  /** Single inline SVG path (no icon-lib dependency, mirrors CustomerSpatialToolBar). */
  iconPath: string
  accent: string
  /** Glow colour for the count-badge pulse. */
  accentGlow: string
}

const SELECT_ICON =
  'M9 11V5a2 2 0 0 1 4 0v6 M13 11V3a2 2 0 0 1 4 0v8 M17 11V6a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-3l-5-5 1.5-1.5L13 19'

const TOOLS: ReadonlyArray<ToolMeta> = [
  { key: 'door', label: 'Tür', iconPath: 'M6 3h12v18H6z M14 12h.5 M6 21h12', accent: '#7c3aed', accentGlow: 'rgba(124,58,237,0.55)' },
  { key: 'window', label: 'Fenster', iconPath: 'M4 4h16v16H4z M4 12h16 M12 4v16', accent: '#0891b2', accentGlow: 'rgba(8,145,178,0.55)' },
  { key: 'outlet', label: 'Steckdose', iconPath: 'M4 4h16v16H4z M9 9v3 M15 9v3 M9 16h6', accent: '#f59e0b', accentGlow: 'rgba(245,158,11,0.55)' },
  { key: 'switch', label: 'Schalter', iconPath: 'M5 8h14a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8z M9.5 12h.01', accent: '#f59e0b', accentGlow: 'rgba(245,158,11,0.55)' },
  { key: 'fusebox', label: 'Sicherung', iconPath: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h8', accent: '#eab308', accentGlow: 'rgba(234,179,8,0.55)' },
  { key: 'radiator', label: 'Heizung', iconPath: 'M4 6h16v12H4z M8 6v12 M12 6v12 M16 6v12 M3 8h1 M3 16h1 M20 8h1 M20 16h1', accent: '#dc2626', accentGlow: 'rgba(220,38,38,0.55)' },
  { key: 'bathtub', label: 'Wanne', iconPath: 'M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z M6 12V7a2 2 0 0 1 3.5-1.3', accent: '#0ea5e9', accentGlow: 'rgba(14,165,233,0.55)' },
  { key: 'sink', label: 'Waschb.', iconPath: 'M4 11h16 M6 11v3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-3 M12 6v5', accent: '#0ea5e9', accentGlow: 'rgba(14,165,233,0.55)' },
  { key: 'toilet', label: 'WC', iconPath: 'M7 4h7v6a4 4 0 0 1-4 4H7z M7 14l-1 6 M14 14l1.5 6 M9 4V3', accent: '#0ea5e9', accentGlow: 'rgba(14,165,233,0.55)' },
  { key: 'material', label: 'Material', iconPath: 'M3 3h18v18H3z M3 9h18 M9 9v12 M15 9v12', accent: '#10b981', accentGlow: 'rgba(16,185,129,0.55)' },
]

export interface CraftsmanSpatialToolBarProps {
  /** Active placement tool, or `null` for select/edit mode. */
  activeTool: CraftsmanSpatialTool | null
  /** Tap a tool (or the same active tool again to deselect → select mode). */
  onSelectTool: (tool: CraftsmanSpatialTool | null) => void
  /**
   * Per-tool placement counts — rendered as a badge on the tool chip. Pass
   * `{ outlet: { count: 3, glow: true } }` to pulse the badge when a new
   * object of that kind was just placed.
   */
  counts?: Partial<Record<CraftsmanSpatialTool, { count: number; glow?: boolean }>>
  disabled?: boolean
  className?: string
}

function ToolChip({
  meta,
  active,
  count,
  glow,
  disabled,
  onActivate,
  onTouchUp,
}: {
  meta: ToolMeta
  active: boolean
  count: number
  glow: boolean
  disabled?: boolean
  onActivate: () => void
  onTouchUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onActivate}
      onPointerUp={onTouchUp}
      disabled={disabled}
      aria-pressed={active}
      aria-label={count > 0 ? `${meta.label}, ${count} platziert` : meta.label}
      className="relative flex min-w-[58px] shrink-0 flex-col items-center justify-center gap-1 overflow-visible rounded-[15px] px-2 py-1.5 text-[10px] font-bold tracking-tight transition active:scale-[0.96]"
      style={{
        background: active ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.05)',
        color: active ? '#0f1525' : 'rgba(255,255,255,0.82)',
        boxShadow: active
          ? '0 4px 10px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.6)'
          : undefined,
        border: active ? `1px solid ${meta.accent}` : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width={18}
        height={18}
        fill="none"
        stroke={active ? meta.accent : 'currentColor'}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={meta.iconPath} />
      </svg>
      <span className="leading-none">{meta.label}</span>
      {count > 0 && (
        <span
          // Sits inside the chip top-right; the scroll container clips vertical
          // overflow (overflow-x:auto forces overflow-y:auto) so the badge + its
          // glow halo are kept clear of the bar's top edge.
          className="absolute right-[3px] top-[3px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-extrabold leading-none text-white"
          style={{
            background: meta.accent,
            ['--glow' as string]: meta.accentGlow,
            boxShadow: glow ? `0 0 0 0 ${meta.accentGlow}` : '0 1px 2px rgba(0,0,0,0.35)',
            animation: glow
              ? 'craftsman-tool-badge-glow 1.6s cubic-bezier(0.32, 0.72, 0, 1) infinite'
              : undefined,
          }}
          aria-hidden
        >
          {count}
        </span>
      )}
    </button>
  )
}

export default function CraftsmanSpatialToolBar({
  activeTool,
  onSelectTool,
  counts,
  disabled = false,
  className,
}: CraftsmanSpatialToolBarProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside (bubble-phase `click`, NOT capture-phase pointerdown) +
  // Escape collapse the bar. Bubble-phase so a sibling button's own onClick
  // fires FIRST and the collapse is the second visible change — never two UI
  // changes for one tap (device-test 2026-05-27 lesson, ported from customer).
  useEffect(() => {
    if (!expanded) return
    const onClick = (event: MouseEvent) => {
      const root = rootRef.current
      if (!root) return
      const target = event.target as Node | null
      if (target && root.contains(target)) return
      setExpanded(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded])

  // iOS double-fire guard (see file header). Touch pointer-up stamps now +
  // acts; a synthetic click within 600ms is dropped. Mouse passes via onClick.
  const lastTouchHandledAt = useRef<number>(0)

  const toggleExpanded = useCallback(() => {
    if (disabled) return
    setExpanded((prev) => !prev)
  }, [disabled])

  const handleAnchorPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'mouse' || disabled) return
      lastTouchHandledAt.current = performance.now()
      toggleExpanded()
    },
    [disabled, toggleExpanded],
  )

  const handleAnchorClick = useCallback(() => {
    if (performance.now() - lastTouchHandledAt.current < 600) return
    toggleExpanded()
  }, [toggleExpanded])

  const selectTool = useCallback(
    (tool: CraftsmanSpatialTool | null) => {
      if (disabled) return
      onSelectTool(tool)
    },
    [disabled, onSelectTool],
  )

  const makeToolActivate = useCallback(
    (key: CraftsmanSpatialTool) => () => {
      // Drop the synthetic click iOS replays right after a touch pointer-up.
      if (performance.now() - lastTouchHandledAt.current < 600) return
      selectTool(activeTool === key ? null : key)
    },
    [activeTool, selectTool],
  )

  const makeToolTouchUp = useCallback(
    (key: CraftsmanSpatialTool) =>
      (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse' || disabled) return
        lastTouchHandledAt.current = performance.now()
        selectTool(activeTool === key ? null : key)
      },
    [activeTool, disabled, selectTool],
  )

  const COLLAPSED_W = 132
  // When collapsed with a tool armed, the anchor reflects THAT tool (icon +
  // label + accent) instead of the static "Auswahl" — otherwise a failed
  // placement (wrong surface → tool stays armed) plus the click-outside
  // collapse would leave the pill reading "Auswahl" while a tool is still
  // armed, and the next canvas tap would place unexpectedly.
  const activeMeta = activeTool ? (TOOLS.find((t) => t.key === activeTool) ?? null) : null

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Werkzeuge"
      className={
        'pointer-events-auto flex h-14 items-center justify-start rounded-[24px] ' +
        (disabled ? 'opacity-55 ' : '') +
        (className ?? '')
      }
      style={{
        width: expanded ? '100%' : `${COLLAPSED_W}px`,
        maxWidth: 480,
        padding: '6px',
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32)',
        transition: 'width 370ms cubic-bezier(0.4, 0.0, 0.2, 1)',
        willChange: 'width',
      }}
    >
      {/* Anchor — "Auswahl" pill. Pure expand/collapse toggle; morphs as it opens. */}
      <button
        type="button"
        onClick={handleAnchorClick}
        onPointerUp={handleAnchorPointerUp}
        disabled={disabled}
        aria-label={expanded ? 'Werkzeuge schließen' : 'Werkzeuge öffnen'}
        aria-controls="craftsman-spatial-tools"
        aria-expanded={expanded}
        className="relative z-[2] flex h-11 flex-shrink-0 items-center gap-[7px] rounded-[20px] pl-[5px] pr-[10px] text-white"
        style={{
          background: expanded ? 'rgba(255,255,255,0.10)' : 'transparent',
          boxShadow: expanded ? 'inset 0 1px 0 rgba(255,255,255,0.18)' : undefined,
          transition: 'background 180ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white"
          style={{
            background: activeMeta
              ? `linear-gradient(135deg, ${activeMeta.accent} 0%, ${activeMeta.accent} 100%)`
              : 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
            boxShadow: activeMeta
              ? '0 4px 10px rgba(0,0,0,0.35), inset 0 1px 1px rgba(255,255,255,0.28)'
              : '0 4px 10px rgba(37,99,235,0.50), inset 0 1px 1px rgba(255,255,255,0.28)',
          }}
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            width={14}
            height={14}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={activeMeta ? activeMeta.iconPath : SELECT_ICON} />
          </svg>
        </span>
        <span
          className="overflow-hidden whitespace-nowrap text-[12.5px] font-bold leading-tight"
          style={{
            opacity: expanded ? 0 : 1,
            maxWidth: expanded ? 0 : 88,
            transition:
              'opacity 180ms cubic-bezier(0.32, 0.72, 0, 1), max-width 290ms cubic-bezier(0.4, 0.0, 0.2, 1)',
          }}
        >
          {activeMeta ? activeMeta.label : 'Auswahl'}
        </span>
        <svg
          viewBox="0 0 24 24"
          width={11}
          height={11}
          fill="none"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 290ms cubic-bezier(0.4, 0.0, 0.2, 1)',
          }}
          aria-hidden
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {/* Divider — appears when expanded so the anchor reads as part of the bar. */}
      <span
        aria-hidden
        className="self-stretch"
        style={{
          width: expanded ? 1 : 0,
          margin: expanded ? '8px 6px' : '8px 0',
          background: 'rgba(255,255,255,0.14)',
          transition: 'width 260ms cubic-bezier(0.4, 0.0, 0.2, 1) 140ms',
        }}
      />

      {/* Tools — fade + slide-in; collapsed → pointer-events:none so the anchor
          is the only tap-target. 10 tools → horizontally scrollable. */}
      <div
        id="craftsman-spatial-tools"
        // `inert` when collapsed: opacity/pointer-events alone leave the chips
        // keyboard- + VoiceOver-focusable, so a user could arm a tool from the
        // invisible bar. inert removes them from focus order + the a11y tree.
        inert={!expanded || undefined}
        className="flex h-11 flex-1 items-stretch gap-1.5 overflow-x-auto"
        style={{
          opacity: expanded ? 1 : 0,
          transform: expanded ? 'translateX(0)' : 'translateX(-12px)',
          pointerEvents: expanded && !disabled ? 'auto' : 'none',
          scrollbarWidth: 'none',
          // Right-edge fade signals the 10-tool row scrolls (no native scrollbar).
          maskImage: 'linear-gradient(to right, #000 calc(100% - 22px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 22px), transparent)',
          transition:
            'opacity 160ms cubic-bezier(0.32, 0.72, 0, 1) 140ms, transform 320ms cubic-bezier(0.4, 0.0, 0.2, 1) 140ms',
        }}
      >
        {TOOLS.map((t) => {
          const meta = counts?.[t.key]
          return (
            <ToolChip
              key={t.key}
              meta={t}
              active={activeTool === t.key}
              count={meta?.count ?? 0}
              glow={!!meta?.glow}
              disabled={disabled}
              onActivate={makeToolActivate(t.key)}
              onTouchUp={makeToolTouchUp(t.key)}
            />
          )
        })}
      </div>

      {/* Inline keyframes — local to this bar (no global stylesheet touch). */}
      <style>{`
        @keyframes craftsman-tool-badge-glow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.0); transform: scale(1); }
          50% { box-shadow: 0 0 6px 1px var(--glow, rgba(255,255,255,0.45)); transform: scale(1.06); }
        }
      `}</style>
    </div>
  )
}
