/**
 * Spatial · SegmentedTabs (shared dark-glass WAI-ARIA tablist)
 *
 * Presentational segmented control extracted from the DimensionMeasureBar
 * header: a `role="tablist"` of roving-tabindex tabs (Arrow/Home/End move
 * focus between the otherwise-unreachable tabIndex=-1 tabs). The consumer owns
 * the panels — render them with {@link tabPanelProps} so the wiring
 * (id / aria-labelledby / hidden) stays in sync with the tabs here.
 *
 * Style-neutral dark glass (white-on-dark): the segment background works over
 * both the CustomerObjectEditSheet tint (rgba(20,28,48)) and the
 * DimensionMeasureBar SHEET_GLASS.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react'

export interface SegmentedTab<K extends string = string> {
  key: K
  label: string
}

export interface SegmentedTabsProps<K extends string = string> {
  tabs: readonly SegmentedTab<K>[]
  value: K
  onChange: (key: K) => void
  ariaLabel: string
  idBase: string
}

/**
 * Props for a consumer-rendered panel that pairs with a tab of the same `key`.
 * Pure (no component) so a file exporting it stays react-refresh clean.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function tabPanelProps(idBase: string, key: string, active: string) {
  return {
    role: 'tabpanel' as const,
    id: `${idBase}-panel-${key}`,
    'aria-labelledby': `${idBase}-tab-${key}`,
    hidden: active !== key,
  }
}

export function SegmentedTabs<K extends string = string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idBase,
}: SegmentedTabsProps<K>) {
  const tabRefs = useRef<Partial<Record<K, HTMLButtonElement | null>>>({})

  // WAI-ARIA tabs pattern: roving tabindex needs Arrow/Home/End to move focus
  // between tabs (non-selected tabs are tabIndex=-1, so without this a keyboard /
  // iOS Full-Keyboard / switch user could never reach them).
  const onTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      let next = index
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
      else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = tabs.length - 1
      else return
      e.preventDefault()
      const key = tabs[next].key
      onChange(key)
      tabRefs.current[key]?.focus()
    },
    [tabs, onChange],
  )

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex flex-1 gap-0.5 rounded-[12px] bg-white/[0.06] p-0.5 ring-1 ring-white/10"
    >
      {tabs.map((t, i) => {
        const selected = value === t.key
        return (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            className={[
              'flex-1 rounded-[10px] px-2 py-1.5 text-[12px] font-bold uppercase tracking-[0.3px] transition',
              selected ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80',
            ].join(' ')}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
