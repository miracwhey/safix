/**
 * Spatial · Edit · MaterialSectionGrid (Mockup 42 §3b)
 *
 * Renders the Material-Picker grid. In browse mode it draws one Typ-Sektion
 * per group (Section-Header + count + 2-col grid). In search mode the picker
 * passes a single unlabelled section → a flat result grid (Mockup 42 §3b:
 * "Suche überschreibt Gruppierung").
 */

import { memo } from 'react'
import type { CatalogMaterial } from '../../../lib/spatial/canonical/catalog/material-types.ts'
import type { MaterialSection } from '../../../lib/spatial/canonical/catalog/material-search.ts'
import { MaterialCard } from './MaterialCard'

export interface MaterialSectionGridProps {
  sections: MaterialSection[]
  currentMaterialSlug: string | null
  /** Slug of the material whose apply-fetch is currently in flight. */
  applyingSlug: string | null
  disabled: boolean
  onTapMaterial: (material: CatalogMaterial) => void
}

function MaterialSectionGridImpl({
  sections,
  currentMaterialSlug,
  applyingSlug,
  disabled,
  onTapMaterial,
}: MaterialSectionGridProps) {
  return (
    <div className="flex flex-col gap-5">
      {sections.map((section, index) => {
        const labelId = `material-section-${index}`
        return (
          <section
            key={section.section || `flat-${index}`}
            role="group"
            aria-labelledby={section.section ? labelId : undefined}
            aria-label={section.section ? undefined : 'Suchtreffer'}
          >
            {section.section && (
              <header
                id={labelId}
                className="mb-2 flex items-baseline justify-between px-0.5"
              >
                <h3 className="text-[13px] font-semibold text-slate-700">{section.section}</h3>
                <span className="text-[12px] tabular-nums text-slate-400">
                  {section.materials.length}
                </span>
              </header>
            )}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {section.materials.map((material) => (
                <MaterialCard
                  key={material.slug}
                  material={material}
                  isCurrent={material.slug === currentMaterialSlug}
                  isApplying={material.slug === applyingSlug}
                  disabled={disabled}
                  onTap={onTapMaterial}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export const MaterialSectionGrid = memo(MaterialSectionGridImpl)
