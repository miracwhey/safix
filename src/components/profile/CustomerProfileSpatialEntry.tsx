/**
 * Spatial · CAD Lane V1.5.1 · CustomerProfileSpatialEntry
 *
 * 3-Welt-Teaser-Card "Mein 3D-Bereich" — replaces the prior single-link
 * "Meine Räume" entry on the Customer profile (Mockup 01 v2 binding).
 *
 * Three tiles, each backed by live counters:
 *   - **Vermessen** — own Self-Scans (`owner_type='customer'`).
 *   - **Beispiele** — "Bald"-badge, lights up with V1.6 Lane 2.
 *   - **vom HW**   — HW-shared scans (`shared_with_customer=true`).
 *                    Also "Bald" solange Lane 3 Block 2 noch nicht live ist
 *                    (count==0 → Mockup-State 1 Empty-Hint).
 *
 * Behaviour:
 *   - Tap the card body → `/customer/spatial/list` (default tab).
 *   - Tap a specific tile → `/customer/spatial/list?tab=<key>`.
 *   - Empty state (0 Vermessen + 0 HW) → the Vermessen-tile pulses with a
 *     yellow focus-glow and the bottom hint reads "Ersten Raum vermessen".
 *
 * Visual treatment (Mockup 01 v2):
 *   - Blue-gradient hero card (#2563EB → #1d4ed8 → #1e3a8a) with radial
 *     glow accents.
 *   - Glass tiles on blue (rgba 0.12 bg, rgba 0.20 border) centered layout.
 *   - Empty-hint as glass-pill INSIDE the card (not amber border-top strip).
 *   - NEW-Badge ("+N") on the Vom-HW-tile when fresh HW-shares arrived
 *     (Mockup State 2 + 3 binding for activation polish).
 */

import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

import { useCustomerSpatialScans } from '../../lib/spatial/hooks/useCustomerSpatialScans'

export default function CustomerProfileSpatialEntry() {
  const { scans, isHydrated } = useCustomerSpatialScans()

  const ownCount = scans.filter(s => s.ownerType === 'customer').length
  const hwCount = scans.filter(
    s => s.ownerType === 'craftsman' && s.sharedWithCustomer,
  ).length
  const totalCount = ownCount + hwCount
  const isEmpty = isHydrated && totalCount === 0

  // "Bald" is sticky on the HW-tile as long as nothing has been shared yet.
  // Mockup State 1 (Launch · Empty) shows both Beispiele AND Vom HW with
  // a "Bald" badge so the customer doesn't read "0 shared" as a feature
  // that's live but happens to be empty.
  const hwComing = isHydrated && hwCount === 0

  const subtitle = !isHydrated
    ? 'Lade Aufmaße…'
    : isEmpty
      ? 'Räume vermessen · Beispiele · vom Handwerker'
      : composeSubtitle(ownCount, hwCount)

  return (
    <div
      className="relative overflow-hidden rounded-[22px] p-[18px] text-white shadow-[0_14px_32px_rgba(37,99,235,0.4)]"
      style={{
        background:
          'linear-gradient(135deg, #2563EB 0%, #1d4ed8 60%, #1e3a8a 100%)',
        boxShadow:
          '0 14px 32px rgba(37,99,235,0.4), inset 0 1.5px 1px rgba(255,255,255,0.24)',
      }}
    >
      {/* Radial glow accents (Mockup ::before / ::after) */}
      <span
        aria-hidden
        className="pointer-events-none absolute right-[-60px] top-[-50px] h-[200px] w-[200px] rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(255,255,255,0.18) 0%, transparent 65%)',
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-[-60px] left-[-40px] h-[160px] w-[160px] rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(168,85,247,0.22) 0%, transparent 60%)',
        }}
      />

      {/* Header row — tap target navigates to the hub */}
      <Link
        to="/customer/spatial/list"
        className="relative z-[2] mb-4 flex items-center gap-3 active:scale-[0.995]"
      >
        <span
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] border backdrop-blur"
          style={{
            background: 'rgba(255,255,255,0.18)',
            borderColor: 'rgba(255,255,255,0.22)',
          }}
        >
          <CubeIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15.5px] font-bold tracking-tight text-white">
            Mein 3D-Bereich
          </div>
          <div
            className="truncate text-[12px]"
            style={{ color: 'rgba(255,255,255,0.78)' }}
          >
            {subtitle}
          </div>
        </div>
        <ChevronRight
          size={18}
          strokeWidth={2.4}
          aria-hidden
          style={{ color: 'rgba(255,255,255,0.7)' }}
        />
      </Link>

      {/* Tiles — each is its own tap target with a deep-link tab param */}
      <div className="relative z-[2] grid grid-cols-3 gap-2">
        <TileLink
          to="/customer/spatial/list?tab=vermessen"
          icon={<RulerIcon />}
          label="Vermessen"
          count={isHydrated ? ownCount : null}
          pulse={isEmpty}
        />
        <TileLink
          to="/customer/spatial/list"
          icon={<CubeOutlineIcon />}
          label="Beispiele"
          count={null}
          badge="Bald"
          disabled
        />
        <TileLink
          to="/customer/spatial/list?tab=vom-hw"
          icon={<HandwerkerIcon />}
          label="vom HW"
          count={isHydrated && !hwComing ? hwCount : null}
          badge={hwComing ? 'Bald' : undefined}
          disabled={hwComing}
        />
      </div>

      {/* Bottom hint — glass-pill INSIDE the card (Mockup spec) */}
      {isEmpty && (
        <Link
          to="/customer/spatial/list?tab=vermessen&new=1"
          className="relative z-[2] mt-[14px] flex items-center justify-between gap-2 rounded-[12px] border px-3 py-[10px] transition active:scale-[0.99]"
          style={{
            background: 'rgba(255,255,255,0.16)',
            borderColor: 'rgba(255,255,255,0.22)',
          }}
        >
          <span className="text-[12.5px] font-semibold text-white">
            Ersten Raum vermessen
          </span>
          <ChevronRight size={16} strokeWidth={2.2} className="text-white" aria-hidden />
        </Link>
      )}
      {!isEmpty && isHydrated && (
        <Link
          to="/customer/spatial/list"
          className="relative z-[2] mt-[14px] flex items-center justify-between gap-2 rounded-[12px] border px-3 py-[10px] transition active:scale-[0.99]"
          style={{
            background: 'rgba(255,255,255,0.16)',
            borderColor: 'rgba(255,255,255,0.22)',
          }}
        >
          <span className="text-[12.5px] font-semibold text-white">
            Bereich öffnen
          </span>
          <ChevronRight size={16} strokeWidth={2.2} className="text-white" aria-hidden />
        </Link>
      )}
    </div>
  )
}

interface TileLinkProps {
  to: string
  icon: React.ReactNode
  label: string
  count: number | null
  badge?: string
  pulse?: boolean
  disabled?: boolean
}

function TileLink({ to, icon, label, count, badge, pulse, disabled }: TileLinkProps) {
  const isDash = count === null
  const inner = (
    <div
      className={
        'relative flex flex-col items-center gap-[5px] rounded-[14px] border px-2 py-[11px] backdrop-blur-[6px] transition ' +
        (disabled ? 'opacity-[0.85]' : 'active:scale-[0.99]') +
        (pulse ? ' spatial-tile-pulse' : '')
      }
      style={{
        background: 'rgba(255,255,255,0.12)',
        borderColor: pulse
          ? 'rgba(252,211,77,0.85)'
          : 'rgba(255,255,255,0.20)',
      }}
    >
      <span
        className="grid h-[34px] w-[34px] place-items-center rounded-[11px] border"
        style={{
          background: 'rgba(255,255,255,0.18)',
          borderColor: 'rgba(255,255,255,0.20)',
        }}
      >
        {icon}
      </span>
      <div
        className={
          'font-extrabold leading-none tracking-tight text-white ' +
          (isDash ? 'text-[18px] opacity-[0.55]' : 'text-[22px]')
        }
        style={isDash ? { fontVariantNumeric: 'tabular-nums' } : undefined}
      >
        {isDash ? '—' : count}
      </div>
      <div
        className="text-center text-[10px] font-semibold leading-[1.1] tracking-tight"
        style={{ color: 'rgba(255,255,255,0.85)' }}
      >
        {label}
      </div>
      {badge && (
        <span
          className="absolute right-1 top-1 rounded-[5px] px-[5px] py-[3px] text-[8px] font-bold uppercase tracking-wider"
          style={{
            background: 'rgba(252,211,77,0.92)',
            color: 'rgba(15,21,37,0.88)',
          }}
        >
          {badge}
        </span>
      )}
    </div>
  )

  if (disabled) {
    return <div aria-disabled>{inner}</div>
  }
  return (
    <Link to={to} className="block">
      {inner}
    </Link>
  )
}

function composeSubtitle(ownCount: number, hwCount: number): string {
  const parts: string[] = []
  if (ownCount > 0) parts.push(`${ownCount} ${ownCount === 1 ? 'Raum vermessen' : 'Räume vermessen'}`)
  if (hwCount > 0) parts.push(`${hwCount} vom HW geteilt`)
  if (parts.length === 0) return 'Räume vermessen · Beispiele · vom Handwerker'
  return parts.join(' · ')
}

// Inline outline icons — Mockup uses hand-drawn outline-Stil (1.6-1.8 stroke,
// white). Lucide's default 24px icons are too generic; per
// `feedback_html_mockup_design_lessons` we want "ehrliche Outline-Icons" not
// the standard set when the visual hierarchy depends on it.

function CubeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="#fff"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7l9-5 9 5v10l-9 5-9-5z" />
      <path d="M3 7l9 5 9-5M12 12v10" opacity="0.6" />
    </svg>
  )
}

function RulerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="6" width="18" height="14" rx="1" />
      <path d="M3 11h18M9 6v14M15 6v14" />
    </svg>
  )
}

function CubeOutlineIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l9 5v8l-9 5-9-5V8z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  )
}

function HandwerkerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="#fff"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 21c1.2-3.4 3.4-5 6-5M14 21h7M14 17h7M14 13h7" />
    </svg>
  )
}
