import { Image, Star } from 'lucide-react'

export type ProfileTabKey = 'portfolio' | 'stimmen'

type Props = {
  active: ProfileTabKey
  onChange: (key: ProfileTabKey) => void
  portfolioCount: number
  reviewsCount: number
  /** When true the bar pins itself just under the screen-level sticky top bar. */
  sticky?: boolean
}

const TABS: { key: ProfileTabKey; label: string; icon: typeof Image }[] = [
  { key: 'portfolio', label: 'Portfolio', icon: Image },
  { key: 'stimmen', label: 'Stimmen', icon: Star },
]

/**
 * Provider-Profil Tab-Bar (Portfolio · Stimmen) mit Icon + Count.
 * Sitzt in der weißen Profil-Sheet; aktiver Tab = Accent-Farbe + 2,5px-
 * Accent-Underline (Design „Handwerker Reels Profil"). Sticky-Mode dockt
 * unter dem Topbar des Profile-Screens an.
 */
export default function ProfileTabBar({
  active,
  onChange,
  portfolioCount,
  reviewsCount,
  sticky = true,
}: Props) {
  const counts: Record<ProfileTabKey, number> = {
    portfolio: portfolioCount,
    stimmen: reviewsCount,
  }

  return (
    <div
      className={`z-30 flex items-stretch border-b border-edge bg-white ${
        sticky ? 'sticky top-[calc(env(safe-area-inset-top,0px)+48px)]' : ''
      }`}
      role="tablist"
      aria-label="Profil-Bereiche"
    >
      {TABS.map((tab) => {
        const isActive = tab.key === active
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.key)}
            className={`relative flex flex-1 items-center justify-center gap-2 py-3.5 text-[15px] font-semibold transition-colors ${
              isActive ? 'text-brand' : 'text-ink-muted'
            }`}
          >
            <Icon size={19} aria-hidden />
            <span>{tab.label}</span>
            <span className="text-[13px] font-semibold tabular-nums text-ink-muted">
              {formatCount(counts[tab.key])}
            </span>
            {isActive ? (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-[2.5px] rounded-full bg-brand"
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '')}k`
  return String(n)
}
