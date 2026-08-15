/**
 * Spatial · Edit · VariantSwitcher (Phase 2 · Block 2.9)
 *
 * Floating Liquid-Glass control that lists the variant layers on a canonical
 * scene and lets the user switch the ACTIVE variant (the layer the renderer
 * resolves + displays).
 *
 * Active ≠ writable: switching the active variant only changes what is
 * RENDERED. Whether a layer can be EDITED is a separate, role-derived fact
 * (`useSpatialEditPermissions`). Each row therefore carries one of two
 * affordances:
 *   - ✏️ pencil — the user's own writable layer,
 *   - 👁 eye    — read-only for this user (`base_roomplan`, a sealed
 *     `job_*_final`, or another provider's annotation layer).
 *
 * The switcher does NOT itself gate editing — it is a pure view-state control
 * over `sceneStore.setActiveVariantId`. The edit-mode host (Block 2.11)
 * decides what an edit does when the active layer is read-only.
 *
 * Controlled-collapsed: a Quick-Pill (collapsed) expands to a sheet, mirroring
 * `LightingSwitcher`'s dual-mode pattern + Apple Inset-Grouped list styling so
 * the edit-mode floating controls stay visually consistent.
 */

import { useRef, useState, type ReactElement } from 'react'

import type { Variant, VariantId } from '../../../lib/spatial/canonical/types/variants'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import { useSpatialEditPermissions } from '../../../lib/spatial/hooks/useSpatialEditPermissions'
import type { VariantAccess } from '../../../lib/spatial/workflow/spatialEditPermissions'

export interface VariantSwitcherProps {
  /** Every variant available on the scene (usually the scene store's list). */
  variants: ReadonlyArray<Variant>
  /** The currently active (rendered) variant id. */
  activeVariantId: VariantId | null
  /** Switch the active variant — wired to `sceneStore.setActiveVariantId`. */
  onSelect: (id: VariantId) => void
  /** Positioning classes for the Quick-Pill (e.g. "absolute left-4 top-4"). */
  className?: string
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.82)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

const PILL_GLASS: React.CSSProperties = {
  background: 'rgba(15,18,28,0.54)',
  backdropFilter: 'blur(42px) saturate(165%)',
  WebkitBackdropFilter: 'blur(42px) saturate(165%)',
}

export function VariantSwitcher({
  variants,
  activeVariantId,
  onSelect,
  className,
}: VariantSwitcherProps): ReactElement {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [announce, setAnnounce] = useState('')
  const { accessOf } = useSpatialEditPermissions()

  const activeVariant = variants.find((v) => v.id === activeVariantId) ?? null

  const handleSelect = (id: VariantId) => {
    if (id !== activeVariantId) {
      onSelect(id)
      const v = variants.find((x) => x.id === id)
      setAnnounce(`Ebene gewechselt zu ${v?.display_name ?? id}`)
    }
    setSheetOpen(false)
  }

  return (
    <>
      <QuickPill
        label={activeVariant?.display_name ?? 'Ebene'}
        access={activeVariant ? accessOf(activeVariant.id) : 'read_only'}
        expanded={sheetOpen}
        onClick={() => setSheetOpen(true)}
        className={className}
      />
      {sheetOpen && (
        <SwitcherSheet
          variants={variants}
          activeVariantId={activeVariantId}
          accessOf={accessOf}
          onSelect={handleSelect}
          onClose={() => setSheetOpen(false)}
        />
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick-Pill (collapsed)
// ─────────────────────────────────────────────────────────────────────────────

function QuickPill({
  label,
  access,
  expanded,
  onClick,
  className,
}: {
  label: string
  access: VariantAccess
  expanded: boolean
  onClick: () => void
  className?: string
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Ebene wechseln · aktuell ${label}`}
      aria-expanded={expanded}
      className={[
        'flex items-center gap-2 rounded-[15px] py-2 pl-2.5 pr-3 text-left text-white',
        'transition active:scale-[0.97]',
        className ?? '',
      ].join(' ')}
      style={PILL_GLASS}
    >
      <AccessIcon access={access} tone="light" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-[11px] font-medium text-white/60">Ebene</span>
        <span className="truncate text-[13px] font-bold">{label}</span>
      </span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Switcher-Sheet (expanded)
// ─────────────────────────────────────────────────────────────────────────────

function SwitcherSheet({
  variants,
  activeVariantId,
  accessOf,
  onSelect,
  onClose,
}: {
  variants: ReadonlyArray<Variant>
  activeVariantId: VariantId | null
  accessOf: (id: VariantId) => VariantAccess
  onSelect: (id: VariantId) => void
  onClose: () => void
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={(node) => {
          panelRef.current = node
          node?.focus()
        }}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="variant-switcher-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        className="flex max-h-[72dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={SHEET_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

        <div className="flex items-start justify-between">
          <div>
            <h2 id="variant-switcher-title" className="text-[19px] font-bold text-slate-900">
              Ebene
            </h2>
            <p className="text-[13px] font-medium text-slate-500">
              Welche Bearbeitungs-Ebene angezeigt wird
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 rounded-full p-1.5 text-slate-400 transition active:scale-90 hover:bg-slate-900/5 hover:text-slate-600"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
              <path d="M10 8.586 6.707 5.293 5.293 6.707 8.586 10l-3.293 3.293 1.414 1.414L10 11.414l3.293 3.293 1.414-1.414L11.414 10l3.293-3.293-1.414-1.414L10 8.586Z" />
            </svg>
          </button>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto overscroll-contain">
          {variants.length === 0 ? (
            <p className="rounded-2xl bg-white/70 px-4 py-8 text-center text-[13px] text-slate-500 ring-1 ring-slate-900/10">
              Keine Ebenen verfügbar.
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label="Verfügbare Ebenen"
              className="overflow-hidden rounded-2xl bg-white/70 ring-1 ring-inset ring-slate-900/10"
            >
              {variants.map((variant, index) => (
                <VariantRow
                  key={variant.id}
                  variant={variant}
                  active={variant.id === activeVariantId}
                  access={accessOf(variant.id)}
                  firstInGroup={index === 0}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </div>

        <p className="mt-3 px-1 text-[11.5px] leading-snug text-slate-500">
          <span aria-hidden="true">✏️</span> bearbeitbar ·{' '}
          <span aria-hidden="true">👁</span> nur ansehen. Schreibgeschützte Ebenen
          kannst du anzeigen, aber nicht ändern.
        </p>
      </div>
    </div>
  )
}

function VariantRow({
  variant,
  active,
  access,
  firstInGroup,
  onSelect,
}: {
  variant: Variant
  active: boolean
  access: VariantAccess
  firstInGroup: boolean
  onSelect: (id: VariantId) => void
}): ReactElement {
  const accessLabel = access === 'writable' ? 'bearbeitbar' : 'nur ansehen'
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${variant.display_name} · ${accessLabel}${active ? ' · aktiv' : ''}`}
      onClick={() => onSelect(variant.id)}
      className={[
        'flex w-full items-center gap-3 px-3 py-2.5 text-left transition active:bg-blue-600/[0.07]',
        !firstInGroup ? 'border-t border-slate-900/[0.07]' : '',
        active ? 'bg-blue-600/5' : '',
      ].join(' ')}
    >
      <AccessIcon access={access} tone="dark" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[14.5px] font-semibold text-slate-900">
          {variant.display_name}
        </span>
        <span
          className={[
            'truncate text-[11.5px] font-medium',
            access === 'writable' ? 'text-blue-600' : 'text-slate-500',
          ].join(' ')}
        >
          {access === 'writable' ? 'Deine Bearbeitungs-Ebene' : 'Schreibgeschützt'}
        </span>
      </span>
      {active ? (
        <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-blue-600">
          <svg viewBox="0 0 20 20" className="size-3" fill="#fff">
            <path d="M8.143 14.6 3.5 9.957l1.414-1.414 3.229 3.228 6.943-6.942 1.414 1.414z" />
          </svg>
        </span>
      ) : (
        <span aria-hidden="true" className="size-[21px] shrink-0" />
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Access icon — pencil (writable) / eye (read-only)
// ─────────────────────────────────────────────────────────────────────────────

function AccessIcon({
  access,
  tone,
}: {
  access: VariantAccess
  tone: 'light' | 'dark'
}): ReactElement {
  const writable = access === 'writable'
  const ring = tone === 'light'
    ? 'ring-white/25 bg-white/10'
    : writable
      ? 'ring-blue-600/20 bg-blue-600/10'
      : 'ring-slate-900/10 bg-slate-900/[0.04]'
  const fg = tone === 'light'
    ? 'text-white'
    : writable
      ? 'text-blue-600'
      : 'text-slate-500'
  return (
    <span
      aria-hidden="true"
      className={`flex size-[30px] shrink-0 items-center justify-center rounded-[10px] ring-1 ring-inset ${ring} ${fg}`}
    >
      {writable ? (
        // Pencil
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor">
          <path d="m13.586 3.586 2.828 2.828a1 1 0 0 1 0 1.415l-8.04 8.04a1 1 0 0 1-.464.263l-3.6.9a.6.6 0 0 1-.728-.727l.9-3.6a1 1 0 0 1 .263-.465l8.04-8.04a1 1 0 0 1 1.415 0Zm-1.122 2.536-6.97 6.97-.49 1.96 1.96-.49 6.97-6.97-1.47-1.47Z" />
        </svg>
      ) : (
        // Eye
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor">
          <path d="M10 4c-3.6 0-6.7 2.1-8 5 1.3 2.9 4.4 5 8 5s6.7-2.1 8-5c-1.3-2.9-4.4-5-8-5Zm0 8.5A3.5 3.5 0 1 1 10 5.5a3.5 3.5 0 0 1 0 7Zm0-1.8a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z" />
        </svg>
      )}
    </span>
  )
}
