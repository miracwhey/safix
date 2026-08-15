/**
 * Spatial · V1.6.1 Phase 3b · CustomerViewModeSwitcher
 *
 * Top-Right 3-button glass-pill that switches between 2D Grundriss, 3D
 * Dollhouse, and Begehen (Walk) view modes on the customer Full-Bleed-3D
 * hub (`CustomerSpatialHubScreen`).
 *
 * Mockup binding: `spatial-v151/02-spatial-hub.html` Mockup 02 v8 ·
 * `float-view-mode` tooltips:
 *   - "2D Grundriss"  → `floorplan` controller
 *   - "3D Dollhouse"  → `dollhouse` controller (default)
 *   - "Begehen"       → `walk` controller
 *
 * Decision B.2-D7: Customer = Provider feature parity — same canonical
 * camera-modes as `CameraModeSwitcher.tsx` (dollhouse/floorplan/walk).
 * Customer hat kein AR-Mode (Provider exklusiv).
 *
 * Wiring: Mode-Switch ruft `useCanonicalSceneStore.setCameraMode` direkt,
 * weil `CustomerViewMode` ein Subset von `CameraMode` ist (kein
 * `ar_compare`). Der Hub mounted `<CanonicalSceneRoot>` mit aktiver Scene,
 * jeder Controller-Mount läuft conditional aus dem store-State.
 *
 * Locked-Mode: Customer-LiDAR-Scans die vor Phase 3b angelegt wurden haben
 * kein `parametric_storage_path` — der Hub übergibt dann `lockedModes` auf
 * alle 3 Modes und der Switcher zeigt ein Lock-Icon + onLockedTap-Toast.
 */

import type { CSSProperties } from 'react'

import type { CameraMode } from '../../../lib/spatial/canonical/types/camera'

/** Customer-Modi: Subset des canonical `CameraMode` (kein AR). */
export type CustomerViewMode = Extract<
  CameraMode,
  'dollhouse' | 'floorplan' | 'walk'
>

export interface CustomerViewModeSwitcherProps {
  value: CustomerViewMode
  onChange: (mode: CustomerViewMode) => void
  /** When `true`, all buttons render in a dimmed non-interactive state. */
  disabled?: boolean
  /**
   * Modi die UI-sichtbar sind aber nicht funktional — z.B. wenn die Scene
   * keine parametric.json hat (Legacy-Scans vor Phase 3b). Locked-Modes
   * zeigen ein Lock-Icon und triggern `onLockedTap` statt `onChange'.
   */
  lockedModes?: ReadonlyArray<CustomerViewMode>
  /** Tap auf gesperrtes Mode — Host zeigt typischerweise einen Toast. */
  onLockedTap?: (mode: CustomerViewMode) => void
  /**
   * Stacking direction. Mockup 02 v8 vertical (`float-view-mode`, 38px column,
   * top:220px right:14px). Defaults to `vertical` to match the customer-hub
   * spec; tests + non-hub hosts can pass `horizontal`.
   */
  orientation?: 'vertical' | 'horizontal'
  className?: string
  style?: CSSProperties
}

interface ModeDef {
  key: CustomerViewMode
  /** Tooltip / aria-label (Mockup 02 v8 vm-tip). */
  ariaLabel: string
  iconPath: string
}

const MODES: ReadonlyArray<ModeDef> = [
  {
    key: 'floorplan',
    ariaLabel: '2D Grundriss',
    // top-down floor-plan icon
    iconPath: 'M3 3h18v18H3z M3 12h18 M12 3v18',
  },
  {
    key: 'dollhouse',
    ariaLabel: '3D Dollhouse',
    // iso cube icon
    iconPath: 'M12 3 3 8v8l9 5 9-5V8z M3 8l9 5 9-5 M12 13v10',
  },
  {
    key: 'walk',
    ariaLabel: 'Begehen',
    // human walking icon
    iconPath: 'M13 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M9 22l2-7-2-3 1-5 5 3 2 3 M14 14l2 8',
  },
]

export default function CustomerViewModeSwitcher({
  value,
  onChange,
  disabled = false,
  lockedModes,
  onLockedTap,
  orientation = 'vertical',
  className,
  style,
}: CustomerViewModeSwitcherProps) {
  const lockedSet = new Set(lockedModes ?? [])
  const isVertical = orientation === 'vertical'
  return (
    <div
      role="radiogroup"
      aria-label="Ansicht wechseln"
      aria-disabled={disabled || undefined}
      className={
        'pointer-events-auto inline-flex items-center gap-0.5 p-1 ' +
        (isVertical ? 'flex-col rounded-[20px]' : 'rounded-full') +
        ' ' +
        (disabled ? 'opacity-55' : '') +
        (className ? ` ${className}` : '')
      }
      style={{
        background:
          'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        backdropFilter: 'blur(28px) saturate(220%)',
        WebkitBackdropFilter: 'blur(28px) saturate(220%)',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow:
          '0 8px 22px rgba(0,0,0,0.28), inset 0 1px 1px rgba(255,255,255,0.22)',
        ...style,
      }}
    >
      {MODES.map(mode => {
        const isActive = mode.key === value
        const isLocked = lockedSet.has(mode.key)
        return (
          <button
            key={mode.key}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={
              isLocked
                ? `${mode.ariaLabel} (kommt demnächst)`
                : mode.ariaLabel
            }
            aria-disabled={isLocked || undefined}
            title={
              isLocked
                ? `${mode.ariaLabel} · kommt demnächst`
                : mode.ariaLabel
            }
            disabled={disabled}
            onClick={() => {
              if (disabled) return
              if (isLocked) {
                onLockedTap?.(mode.key)
                return
              }
              if (isActive) return
              onChange(mode.key)
            }}
            className={
              'relative flex h-[34px] w-[38px] items-center justify-center rounded-full text-[10.5px] font-bold tracking-tight transition ' +
              (isActive
                ? 'text-white shadow-[0_4px_10px_rgba(37,99,235,0.4),inset_0_1px_1px_rgba(255,255,255,0.32)]'
                : isLocked
                  ? 'text-white/55'
                  : 'text-white/80 hover:text-white') +
              (disabled ? ' cursor-not-allowed' : '')
            }
            style={
              isActive
                ? {
                    background:
                      'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
                  }
                : isLocked
                  ? {
                      background: 'rgba(15,21,37,0.18)',
                      border: '1px solid rgba(255,255,255,0.10)',
                    }
                  : undefined
            }
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
              aria-hidden
            >
              <path d={mode.iconPath} />
            </svg>
            {isLocked && (
              <span
                aria-hidden
                className="absolute -right-[3px] -top-[3px] flex h-[13px] w-[13px] items-center justify-center rounded-full"
                style={{
                  background: 'rgba(15,21,37,0.92)',
                  border: '1px solid rgba(255,255,255,0.42)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width={8}
                  height={8}
                  fill="none"
                  stroke="rgba(255,255,255,0.95)"
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="5" y="11" width="14" height="10" rx="1.5" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
