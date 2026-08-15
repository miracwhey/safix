/**
 * L2-C · Horizontal Tab-Bar for the 3-Tab Spatial-Hub.
 *
 * Default visible for every provider (D-2). WAI-ARIA Tabs Pattern: each tab
 * is a `role="tab"` button inside a `role="tablist"`; arrow keys + Home / End
 * rotate via roving `tabIndex`. The tab panel itself lives in the screen
 * with `role="tabpanel"` / `aria-labelledby={`hub-tab-${tab}`}`.
 *
 * Visual scope (L2-C trim): basic surface-style chips — full Liquid-Glass
 * design (Mockup 01 photo background, blur, saturate) is intentionally
 * deferred. Once L2-D ships the Beispiel-Raum hero we can revisit the hub
 * chrome holistically without ballooning L2-C.
 */

import { useCallback, useRef, type KeyboardEvent } from 'react'
import { HUB_TABS, type HubTab } from '../../../lib/spatial/canonical/workflow/useProviderSpatialHub'

const TAB_LABEL: Record<HubTab, string> = {
  anfragen: 'Anfragen',
  projekte: 'Projekte',
  privat: 'Privat',
}

export interface HubTabBarProps {
  activeTab: HubTab
  onSelect: (tab: HubTab) => void
  /** Optional per-tab badge counts (e.g. open anfragen). 0 collapses the badge. */
  badges?: Partial<Record<HubTab, number>>
}

export function HubTabBar({ activeTab, onSelect, badges }: HubTabBarProps) {
  const refs = useRef<Record<HubTab, HTMLButtonElement | null>>({
    anfragen: null,
    projekte: null,
    privat: null,
  })

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const idx = HUB_TABS.indexOf(activeTab)
      let nextIdx: number | null = null
      switch (event.key) {
        case 'ArrowRight':
          nextIdx = (idx + 1) % HUB_TABS.length
          break
        case 'ArrowLeft':
          nextIdx = (idx - 1 + HUB_TABS.length) % HUB_TABS.length
          break
        case 'Home':
          nextIdx = 0
          break
        case 'End':
          nextIdx = HUB_TABS.length - 1
          break
        default:
          return
      }
      event.preventDefault()
      const nextTab = HUB_TABS[nextIdx]
      if (!nextTab) return
      onSelect(nextTab)
      refs.current[nextTab]?.focus()
    },
    [activeTab, onSelect],
  )

  return (
    <div
      role="tablist"
      aria-label="Hub-Bereiche"
      className="flex items-center gap-1 border-b border-edge bg-canvas px-3 pt-2"
    >
      {HUB_TABS.map((tab) => {
        const selected = tab === activeTab
        const badge = badges?.[tab] ?? 0
        return (
          <button
            key={tab}
            ref={(node) => {
              refs.current[tab] = node
            }}
            role="tab"
            id={`hub-tab-${tab}`}
            aria-selected={selected}
            aria-controls={`hub-tabpanel-${tab}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab)}
            onKeyDown={handleKeyDown}
            className={[
              'relative flex items-center gap-1.5 rounded-t-[10px] px-3 py-2 text-[13px] font-semibold transition',
              selected
                ? 'text-ink before:absolute before:inset-x-2 before:-bottom-[1px] before:h-[2px] before:rounded-full before:bg-brand'
                : 'text-ink-sub hover:text-ink',
            ].join(' ')}
          >
            {TAB_LABEL[tab]}
            {badge > 0 && (
              <span
                aria-label={`${badge} offen`}
                className={[
                  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip px-1 text-[10.5px] font-bold',
                  selected ? 'bg-brand text-white' : 'bg-[#EEF2FB] text-brand',
                ].join(' ')}
              >
                {badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
