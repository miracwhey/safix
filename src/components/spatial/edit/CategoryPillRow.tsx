/**
 * Spatial · Edit · CategoryPillRow (Mockup 42 §3)
 *
 * The Category-Pill row of the Material-Picker. A tapped surface accepts
 * exactly ONE material category (a wall only takes wall materials —
 * Mockup 42 §3a), so the pills are non-interactive context, not switchable
 * tabs. Rendered as a `role="group"` of static chips with `aria-current` on
 * the active one — NOT a tablist (a tablist with one non-actionable tab is
 * misleading assistive markup).
 */

import type { MaterialSurfaceCategory } from '../../../lib/spatial/canonical/catalog/material-types.ts'
import { CATEGORY_PILLS } from './materialPickerModel'

export interface CategoryPillRowProps {
  /** The single category accepted by the tapped surface. */
  activeCategory: MaterialSurfaceCategory
}

export function CategoryPillRow({ activeCategory }: CategoryPillRowProps) {
  return (
    <div
      role="group"
      aria-label="Material-Kategorie"
      className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {CATEGORY_PILLS.map((pill) => {
        const isActive = pill.id === activeCategory
        return (
          <span
            key={pill.id}
            aria-current={isActive ? 'true' : undefined}
            className={[
              'shrink-0 select-none rounded-full px-3.5 py-1.5 text-[13px] font-semibold',
              isActive
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-white/40 text-slate-400',
            ].join(' ')}
          >
            {pill.label}
          </span>
        )
      })}
    </div>
  )
}
