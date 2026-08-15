/**
 * Spatial · V1.6 Phase 1c · CustomerSpatialToolBar
 *
 * Single-Container Morph (Mockup 02 v9, "Auswahl"-Anchor): a 134px glass
 * pill that morphs into a full-width tool-strip when the user taps the
 * anchor. Five tools are exposed:
 *
 *   - `wall`        — wall-edit (length / thickness / height steppers in 1d)
 *   - `door`        — drop a `customer_pin_type='door'` pin (1d)
 *   - `window`      — drop a `customer_pin_type='window'` pin (1d)
 *   - `heating`     — drop a `customer_pin_type='heating'` pin (1d)
 *   - `electrical`  — drop a `customer_pin_type='electrical'` pin (1d)
 *
 * Pin-types align with the `customer_pin_type` column added in
 * `20260526000000_spatial_v16_customer_pin_type.sql` (Phase 1d migration)
 * so this tool-bar is the long-lived UI surface for the Customer pin
 * pipeline. The 'wall' tool is orthogonal — it does not create a pin, it
 * switches the viewer into wall-edit mode (Phase 1d adds the matching
 * `WallEditSheet`).
 *
 * Phase 1c scope (this file): visual morph + state machine + a11y. Edit-mode
 * wiring (selected tool → SpatialViewer behaviour) is parent-controlled
 * via the `activeTool` / `onToolSelect` props, and Phase 1d adds the
 * actual `<SpatialViewer mode='edit'>` consumer. For Phase 1c the hub
 * mounts the bar; tapping a tool stays a UI-only echo until Phase 1d.
 *
 * Animation timings (R10 2026-05-28: ~20% schneller + Delays komprimiert für
 * "flüssigeres" Gefühl. Curve bleibt — nur Dauern + Stages enger geclustert):
 *   - container width:   134px → full   ·  370ms  · cubic-bezier(.4,0,.2,1)
 *   - anchor label:      opacity 1 → 0  ·  180ms  · cubic-bezier(.32,.72,0,1)
 *   - divider:           width 0 → 1px  ·  260ms  · 140ms delay
 *   - tools row:         opacity + translateX(-12px) → 0  ·  320ms  · 140ms delay
 *   - count-badge glow:  1.6s infinite (when `counts[t]?.glow === true`)
 *
 * Decisions binding:
 *   - B.2-D5 Tool-Bar-Morph anchor = "Auswahl"
 *   - B.2-D3 4 pin-types with gewerk colour-code (purple/cyan/red/amber)
 *   - B.2-D7 Customer = HW feature parity (same tool inventory as the
 *     HW canonical tool-bar — same colours, same labels in DE)
 *
 * Click-outside / Escape collapses the bar to the anchor — keeps the
 * full-bleed scene legible behind it. Tabbing through the tools also
 * keeps the bar open until focus leaves.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export type CustomerSpatialTool =
  | 'wall'
  | 'door'
  | 'window'
  | 'heating'
  | 'electrical'
  | 'furniture'

export interface CustomerSpatialToolBarProps {
  /**
   * Controlled active tool. When `undefined`, the tool-bar is in an
   * "anchor-only" state and no tool is highlighted. Phase 1d wires this
   * up to the SpatialViewer edit pipeline.
   */
  activeTool?: CustomerSpatialTool | null
  /**
   * Fired when the user taps a tool button. Phase 1d uses this to switch
   * the viewer into edit-mode + open the matching detail-sheet on the
   * next pin drop.
   */
  onToolSelect?: (tool: CustomerSpatialTool) => void
  /**
   * Counts per tool — rendered as a badge on the tool button. Useful for
   * "how many doors did I already pin" feedback (Mockup 02 v9). Pass
   * `{ door: { count: 3, glow: true } }` to pulse the badge when a new
   * pin was just added.
   */
  counts?: Partial<
    Record<CustomerSpatialTool, { count: number; glow?: boolean }>
  >
  /**
   * Disables all interaction (anchor + tools). Used while the scene is
   * still loading on the hub. Visual: dimmed glass.
   */
  disabled?: boolean
  /**
   * Optional className override on the root container. Default sizing
   * comes from the bar's own layout — pass with care.
   */
  className?: string
}

interface ToolMeta {
  key: CustomerSpatialTool
  label: string
  ariaLabel: string
  iconPath: string
  /** Accent colour for badge background + active-state ring. */
  accent: string
  /** Glow colour for the badge pulse. */
  accentGlow: string
}

// Tools share the same Gewerk colour palette as the canonical HW tool-bar
// (mockup spatial-v151/02). Wall is the only non-Gewerk tool — slate so
// it sits visually behind the Gewerk colours but stays selectable.
const TOOLS: ReadonlyArray<ToolMeta> = [
  {
    key: 'wall',
    label: 'Wand',
    ariaLabel: 'Wand bearbeiten',
    iconPath:
      'M3 21V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v15 M3 11h18 M9 4v17 M15 4v17',
    accent: '#475569',
    accentGlow: 'rgba(71,85,105,0.55)',
  },
  {
    key: 'door',
    label: 'Tür',
    ariaLabel: 'Tür markieren',
    // door rectangle + handle dot
    iconPath: 'M6 3h12v18H6z M14 12h.5 M6 21h12',
    accent: '#7c3aed',
    accentGlow: 'rgba(124,58,237,0.55)',
  },
  {
    key: 'window',
    label: 'Fenster',
    ariaLabel: 'Fenster markieren',
    // double-cross window
    iconPath: 'M4 4h16v16H4z M4 12h16 M12 4v16',
    accent: '#0891b2',
    accentGlow: 'rgba(8,145,178,0.55)',
  },
  {
    key: 'heating',
    label: 'Heizung',
    ariaLabel: 'Heizung markieren',
    // radiator silhouette
    iconPath:
      'M4 6h16v12H4z M8 6v12 M12 6v12 M16 6v12 M3 8h1 M3 16h1 M20 8h1 M20 16h1',
    accent: '#dc2626',
    accentGlow: 'rgba(220,38,38,0.55)',
  },
  {
    key: 'electrical',
    label: 'Elektro',
    ariaLabel: 'Elektro markieren',
    // outlet / socket silhouette
    iconPath:
      'M4 4h16v16H4z M9 9v3 M15 9v3 M9 16h6',
    accent: '#f59e0b',
    accentGlow: 'rgba(245,158,11,0.55)',
  },
  {
    key: 'furniture',
    label: 'Möbel',
    ariaLabel: 'Möbel hinzufügen',
    // sofa silhouette
    iconPath: 'M4 18v-5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5 M4 14h16 M6 18v2 M18 18v2',
    accent: '#10b981',
    accentGlow: 'rgba(16,185,129,0.55)',
  },
]

export default function CustomerSpatialToolBar({
  activeTool = null,
  onToolSelect,
  counts,
  disabled = false,
  className,
}: CustomerSpatialToolBarProps) {
  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Click-outside collapses the bar to the anchor — keeps the full-bleed
  // scene legible behind it. Use `click` (bubble-phase) instead of
  // `pointerdown` (capture-phase) so a tap on a sibling button that ALSO
  // opens a sheet fires its own action FIRST, and the tool-bar collapse
  // is the second visible UI change — never both for the same tap. Device-
  // test 2026-05-27 reported "ein Tap löst zwei UI-Änderungen aus" exactly
  // because the capture-phase pointerdown collapsed the bar before the
  // intended button got its event.
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

  // R12.6 iOS-Capacitor-Click-Fallback: in der WebView droppt iOS gelegentlich
  // den synthetischen `click` auf `<button>` über einem 3D-Canvas (sehen Sie
  // device-report 2026-05-28 "Auswahl/Tür reagiert nicht"). Wir binden parallel
  // `onPointerUp` mit einem Dedupe-Stempel: pointer-up auf Touch löst sofort
  // aus + setzt Timestamp; ein folgender synthetischer click innerhalb 600ms
  // wird gedroppt. Maus-Klicks (pointerType='mouse') laufen unverändert über
  // onClick, weil die WebView dort kein Routing-Problem hat.
  const lastTouchHandledAt = useRef<number>(0)

  const handleAnchorActivate = useCallback(() => {
    if (disabled) return
    setExpanded(prev => !prev)
  }, [disabled])

  const handleAnchorPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === 'mouse') return
      if (disabled) return
      lastTouchHandledAt.current = performance.now()
      handleAnchorActivate()
    },
    [disabled, handleAnchorActivate],
  )

  const handleAnchorClick = useCallback(() => {
    if (performance.now() - lastTouchHandledAt.current < 600) return
    handleAnchorActivate()
  }, [handleAnchorActivate])

  const handleToolActivate = useCallback(
    (tool: CustomerSpatialTool) => {
      if (disabled) return
      onToolSelect?.(tool)
    },
    [disabled, onToolSelect],
  )

  const handleToolPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, tool: CustomerSpatialTool) => {
      if (event.pointerType === 'mouse') return
      if (disabled) return
      lastTouchHandledAt.current = performance.now()
      handleToolActivate(tool)
    },
    [disabled, handleToolActivate],
  )

  const handleToolClick = useCallback(
    (tool: CustomerSpatialTool) => {
      if (performance.now() - lastTouchHandledAt.current < 600) return
      handleToolActivate(tool)
    },
    [handleToolActivate],
  )

  const COLLAPSED_W = 134
  const EXPANDED_PCT = 100 // % of parent slot

  return (
    <div
      ref={rootRef}
      className={
        'pointer-events-auto mr-auto flex h-14 items-center justify-start rounded-[28px] ' +
        (disabled ? 'opacity-55 ' : '') +
        (className ?? '')
      }
      style={{
        width: expanded ? `${EXPANDED_PCT}%` : `${COLLAPSED_W}px`,
        maxWidth: '100%',
        padding: '6px',
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        backdropFilter: 'blur(96px) saturate(240%)',
        WebkitBackdropFilter: 'blur(96px) saturate(240%)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow:
          '0 20px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.32), inset 0 -1px 0 rgba(255,255,255,0.04)',
        transition: 'width 370ms cubic-bezier(0.4, 0.0, 0.2, 1)',
        willChange: 'width',
      }}
      role="toolbar"
      aria-label="Werkzeuge"
      aria-expanded={expanded}
    >
      {/* Anchor — "Auswahl"-pill that is always rendered. Becomes the
          morph anchor when expanded (icon stays, label fades, chevron
          rotates). */}
      <button
        type="button"
        onClick={handleAnchorClick}
        onPointerUp={handleAnchorPointerUp}
        disabled={disabled}
        aria-label={expanded ? 'Werkzeuge schließen' : 'Werkzeuge öffnen'}
        aria-controls="customer-spatial-tools"
        aria-expanded={expanded}
        className="relative z-[2] flex h-11 flex-shrink-0 items-center gap-[7px] rounded-[22px] pl-[5px] pr-[10px] text-white"
        style={{
          background: expanded ? 'rgba(255,255,255,0.10)' : 'transparent',
          boxShadow: expanded
            ? 'inset 0 1px 0 rgba(255,255,255,0.18)'
            : undefined,
          transition: 'background 180ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
      >
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white"
          style={{
            background:
              'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
            boxShadow:
              '0 4px 10px rgba(37,99,235,0.50), inset 0 1px 1px rgba(255,255,255,0.28)',
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
            {/* hand cursor / tap pointer */}
            <path d="M9 11V5a2 2 0 0 1 4 0v6 M13 11V3a2 2 0 0 1 4 0v8 M17 11V6a2 2 0 0 1 4 0v9a6 6 0 0 1-6 6h-3l-5-5 1.5-1.5L13 19" />
          </svg>
        </span>
        <span
          className="overflow-hidden whitespace-nowrap text-[12.5px] font-bold leading-tight"
          style={{
            opacity: expanded ? 0 : 1,
            maxWidth: expanded ? 0 : 80,
            transition:
              'opacity 180ms cubic-bezier(0.32, 0.72, 0, 1), max-width 290ms cubic-bezier(0.4, 0.0, 0.2, 1)',
          }}
        >
          Auswahl
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

      {/* Divider — appears when expanded so the anchor pill reads as
          part of a longer bar. */}
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

      {/* Tools — fade + slide-in from the left when expanded. Collapsed
          state hides them with pointer-events:none so the anchor stays
          the only tap-target. */}
      <div
        id="customer-spatial-tools"
        className="flex h-11 flex-1 items-stretch gap-[3px]"
        style={{
          opacity: expanded ? 1 : 0,
          transform: expanded ? 'translateX(0)' : 'translateX(-12px)',
          pointerEvents: expanded && !disabled ? 'auto' : 'none',
          transition:
            'opacity 160ms cubic-bezier(0.32, 0.72, 0, 1) 140ms, transform 320ms cubic-bezier(0.4, 0.0, 0.2, 1) 140ms',
        }}
      >
        {TOOLS.map(tool => {
          const isActive = activeTool === tool.key
          const meta = counts?.[tool.key]
          const count = meta?.count ?? 0
          const glow = !!meta?.glow
          return (
            <button
              key={tool.key}
              type="button"
              onClick={() => handleToolClick(tool.key)}
              onPointerUp={(e) => handleToolPointerUp(e, tool.key)}
              disabled={disabled}
              aria-label={tool.ariaLabel}
              aria-pressed={isActive}
              title={tool.ariaLabel}
              className="relative flex flex-1 flex-col items-center justify-center gap-[3px] overflow-visible rounded-[17px] text-[9px] font-bold tracking-tight transition active:scale-[0.96]"
              style={{
                background: isActive
                  ? 'rgba(255,255,255,0.95)'
                  : 'transparent',
                color: isActive ? '#0f1525' : 'rgba(255,255,255,0.78)',
                boxShadow: isActive
                  ? '0 4px 10px rgba(0,0,0,0.30), inset 0 1px 1px rgba(255,255,255,0.65)'
                  : undefined,
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width={16}
                height={16}
                fill="none"
                stroke={isActive ? '#0f1525' : 'currentColor'}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={tool.iconPath} />
              </svg>
              <span className="leading-none">{tool.label}</span>
              {count > 0 && (
                <span
                  className="absolute right-[3px] top-[1px] flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-extrabold leading-none text-white"
                  style={{
                    background: tool.accent,
                    boxShadow: glow
                      ? `0 0 0 0 ${tool.accentGlow}`
                      : `0 1px 2px rgba(0,0,0,0.35)`,
                    animation: glow
                      ? 'customer-tool-badge-glow 1.6s cubic-bezier(0.32, 0.72, 0, 1) infinite'
                      : undefined,
                  }}
                  aria-label={`${count}`}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Inline keyframes — Tailwind config doesn't carry this animation
          and it's local to the tool-bar. Single style tag scoped to the
          component keeps the change closed (no global stylesheet touch). */}
      <style>{`
        @keyframes customer-tool-badge-glow {
          0%, 100% {
            box-shadow: 0 0 0 0 rgba(255,255,255,0.0);
            transform: scale(1);
          }
          50% {
            box-shadow: 0 0 8px 2px var(--glow, rgba(255,255,255,0.45));
            transform: scale(1.06);
          }
        }
      `}</style>
    </div>
  )
}
