import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import Spinner from '../system/Spinner'

type ActionVariant = 'primary' | 'secondary' | 'icon'

export type InstaProfileAction = {
  key: string
  label: string
  icon: LucideIcon
  variant: ActionVariant
  onClick: () => void
  disabled?: boolean
  pending?: boolean
  pressed?: boolean
  ariaLabel?: string
}

export type InstaProfileStat = {
  value: string
  label: string
}

export type InstaProfileTrustBadge = {
  kind: string
  label: string
  icon: string
}

type Props = {
  name: string
  /** Accepted for API stability; not rendered in the body — the handle lives
   *  in the screen's sticky topbar (Owner- wie Customer-Sicht). */
  handle?: string
  verified?: boolean
  bio?: string | null
  tradeCategories: string[]
  location?: string
  /** Accepted for API stability; the new layout folds location into a single
   *  Kategorie-Zeile and no longer renders a separate radius line. */
  serviceRadiusKm?: number
  stats: [InstaProfileStat, InstaProfileStat, InstaProfileStat]
  /** Pre-formatted, e.g. "Antwort meist < 4 h". Null hides the pill. */
  responseLatencyLabel?: string | null
  /** Show the green "Aktiv"-Pill. Default true. */
  showStatusPill?: boolean
  trustBadges?: InstaProfileTrustBadge[]
  actions: InstaProfileAction[]
  /** Custom avatar slot — `<img>` for read-only, `<AvatarUpload>` for owner.
   *  Sized by the slot itself; the component wraps it in the Accent-Conic-Ring. */
  avatarSlot: ReactNode
  /** Error-Banner (e.g. inquiry failure) shown below action row. */
  errorMessage?: string | null
}

const MAX_CATEGORY_PARTS = 2

/**
 * Insta×TikTok×Handwerk-Profilkopf — geteilter Primitiv im Reels-Look
 * („Handwerker Reels Profil").
 *
 * Layout: Avatar (Accent-Conic-Ring) links · Name+Verified+Status-Pille / 3
 * Stats rechts → Kategorie-Zeile → Bio → (Antwortzeit/Trust) → Aktionen.
 * Spiegelt `ExploreProfileHeaderCard` (Customer-Sicht, dort inline) für die
 * Owner-Sicht (`CraftsmanProfile`). Unterschiede stecken nur in `actions`,
 * `stats` und `avatarSlot` (editierbar via `AvatarUpload`).
 *
 * Input-Vertrag:
 *   - 3-Stat-Tile (Reihenfolge frei) — erste Kachel akzentuiert
 *   - Status-Pille „Aktiv" (default an) + optionaler Antwortzeit-Pill
 *   - Action-Row: erste Aktion = primary (volle Breite), folgende = secondary
 *     (Label) bzw. icon-Buttons
 */
export default function InstaProfileHeader({
  name,
  verified = false,
  bio,
  tradeCategories,
  location,
  stats,
  responseLatencyLabel,
  showStatusPill = true,
  trustBadges = [],
  actions,
  avatarSlot,
  errorMessage,
}: Props) {
  const categoryParts = [...new Set(tradeCategories.filter(Boolean))].slice(0, MAX_CATEGORY_PARTS)
  if (location) categoryParts.push(location)
  const categoryLine = categoryParts.join(' · ')

  return (
    <div className="px-[18px] pb-3.5 pt-5">
      {/* Identity: Avatar (Accent-Conic-Ring) + Name/Status + Stats */}
      <div className="flex items-center gap-4">
        <div
          className="shrink-0 rounded-full p-[3px]"
          style={{ background: 'conic-gradient(from 140deg, #60A5FA, #2563EB, #60A5FA)' }}
        >
          <div className="rounded-full bg-white p-[2px]">{avatarSlot}</div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Name + Verified + Status-Pille */}
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[20px] font-bold leading-tight tracking-tight text-ink">
                {name}
              </span>
              {verified ? (
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  className="shrink-0 text-brand"
                  role="img"
                  aria-label="Verifizierter Handwerker"
                >
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path
                    d="m8 12 2.6 2.6L16 9"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </div>
            {showStatusPill ? (
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-[3px] text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                Aktiv
              </span>
            ) : null}
          </div>

          {/* Stats — erste Kachel akzentuiert */}
          <div className="flex">
            {stats.map((stat, idx) => (
              <StatTile
                key={`${stat.label}-${idx}`}
                value={stat.value}
                label={stat.label}
                accent={idx === 0}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Kategorie */}
      {categoryLine ? (
        <p className="mt-3 text-[13px] leading-snug text-ink-muted">{categoryLine}</p>
      ) : null}

      {/* Bio */}
      {bio ? (
        <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-ink-sub">{bio}</p>
      ) : null}

      {/* Antwortzeit + Trust-Signale */}
      {responseLatencyLabel || trustBadges.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-ink-muted">
          {responseLatencyLabel ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-[2px] font-medium text-ink-sub ring-1 ring-edge/60">
              {responseLatencyLabel}
            </span>
          ) : null}
          {trustBadges.map((badge) => (
            <span key={badge.kind} className="inline-flex items-center gap-1">
              <span className="text-[13px] leading-none">{badge.icon}</span>
              <span>{badge.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/* Action-Row */}
      {actions.length > 0 ? (
        <div className="mt-4 flex items-center gap-2.5">
          {actions.map((action, idx) => {
            const Icon = action.icon
            const isPrimary = idx === 0 && action.variant === 'primary'
            if (isPrimary) {
              return (
                <button
                  key={action.key}
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled || action.pending}
                  aria-busy={action.pending}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-card bg-brand py-[11px] text-center text-[14px] font-semibold text-white transition active:scale-[0.97] disabled:opacity-60"
                >
                  {action.pending ? (
                    <Spinner size="sm" tone="onDark" inButton />
                  ) : (
                    <Icon size={18} aria-hidden />
                  )}
                  {action.label}
                </button>
              )
            }
            if (action.variant === 'secondary') {
              return (
                <button
                  key={action.key}
                  type="button"
                  onClick={action.onClick}
                  disabled={action.disabled}
                  aria-pressed={action.pressed}
                  className="flex items-center justify-center gap-1.5 rounded-card bg-canvas px-4 py-[11px] text-center text-[14px] font-semibold text-ink ring-1 ring-edge transition active:scale-[0.97] disabled:opacity-60"
                >
                  <Icon
                    size={18}
                    aria-hidden
                    fill={action.pressed ? 'currentColor' : 'none'}
                  />
                  {action.label}
                </button>
              )
            }
            // icon-only square
            return (
              <button
                key={action.key}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                aria-pressed={action.pressed}
                aria-label={action.ariaLabel ?? action.label}
                className={`flex h-[46px] w-[46px] items-center justify-center rounded-card ring-1 transition active:scale-[0.97] disabled:opacity-60 ${
                  action.pressed
                    ? 'bg-ink text-white ring-ink'
                    : 'bg-canvas text-ink-sub ring-edge'
                }`}
              >
                <Icon size={18} aria-hidden fill={action.pressed ? 'currentColor' : 'none'} />
              </button>
            )
          })}
        </div>
      ) : null}

      {errorMessage ? (
        <div
          role="alert"
          className="mt-2 rounded-card bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700 ring-1 ring-rose-200"
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}

function StatTile({ value, label, accent }: InstaProfileStat & { accent?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-[3px]">
      <span
        className={`text-[18px] font-bold leading-none tracking-tight tabular-nums ${
          accent ? 'text-brand' : 'text-ink'
        }`}
      >
        {value}
      </span>
      <span className="max-w-full truncate text-[11px] font-medium text-ink-muted">{label}</span>
    </div>
  )
}
