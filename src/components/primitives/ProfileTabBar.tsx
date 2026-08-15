import type { LucideIcon } from 'lucide-react'

export type ProfileTab = {
  key: string
  label: string
  icon?: LucideIcon
}

type Props = {
  tabs: ProfileTab[]
  active: string
  onChange: (key: string) => void
}

export default function ProfileTabBar({ tabs, active, onChange }: Props) {
  return (
    <div className="flex border-b border-edge">
      {tabs.map((tab) => {
        const isActive = tab.key === active
        const Icon = tab.icon
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-3 text-[13px] font-semibold transition-colors ${
              isActive
                ? 'text-ink border-b-2 border-ink -mb-px'
                : 'text-ink-muted'
            }`}
          >
            {Icon ? <Icon size={16} aria-hidden /> : null}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
