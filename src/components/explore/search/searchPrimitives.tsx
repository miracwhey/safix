/**
 * Small inline-styled UI primitives for the search screen.
 *
 * These stand in for the mock's Geist/design-system imports (SegmentedControl,
 * Chip, Switch, Avatar, Button) so the screen has no external design-system
 * dependency. All styling uses the `.fxsearch`-scoped CSS vars from
 * `searchTokens.css`, so these must render inside the screen root.
 */

import type { CSSProperties, ReactNode } from 'react'

type Size = 'sm' | 'md'

// ---------------------------------------------------------------------------
// SegmentedControl — blue active pill
// ---------------------------------------------------------------------------

export function SegmentedControl({
  items,
  value,
  onChange,
  size = 'md',
}: {
  items: string[]
  value: number
  onChange: (index: number) => void
  size?: Size
}) {
  const pad = size === 'sm' ? '6px 11px' : '8px 14px'
  const fontSize = size === 'sm' ? 12.5 : 13.5
  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 3,
        gap: 3,
        borderRadius: 999,
        background: 'var(--slate-100)',
        border: '1px solid var(--edge)',
      }}
    >
      {items.map((item, i) => {
        const active = i === value
        return (
          <button
            key={item}
            type="button"
            onClick={() => onChange(i)}
            style={{
              border: 'none',
              cursor: 'pointer',
              borderRadius: 999,
              padding: pad,
              font: `${active ? 700 : 600} ${fontSize}px/1 var(--font-sans)`,
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--slate-500)',
              boxShadow: active ? 'var(--shadow-xs)' : 'none',
              whiteSpace: 'nowrap',
              transition: 'background .2s var(--ease-out), color .2s var(--ease-out)',
            }}
          >
            {item}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chip — selectable pill
// ---------------------------------------------------------------------------

export function Chip({
  selected = false,
  onClick,
  size = 'md',
  children,
}: {
  selected?: boolean
  onClick: () => void
  size?: Size
  children: ReactNode
}) {
  const pad = size === 'sm' ? '6px 12px' : '8px 14px'
  const fontSize = size === 'sm' ? 12.5 : 13.5
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: pad,
        borderRadius: 999,
        cursor: 'pointer',
        font: `600 ${fontSize}px/1 var(--font-sans)`,
        whiteSpace: 'nowrap',
        background: selected ? 'var(--accent)' : 'var(--white)',
        color: selected ? '#fff' : 'var(--slate-600)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--edge)'}`,
        transition: 'background .2s var(--ease-out), color .2s var(--ease-out)',
      }}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Switch — blue when checked
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  size = 'md',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  size?: Size
}) {
  const w = size === 'sm' ? 40 : 46
  const h = size === 'sm' ? 24 : 28
  const knob = h - 6
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        flex: 'none',
        width: w,
        height: h,
        padding: 0,
        border: 'none',
        borderRadius: 999,
        cursor: 'pointer',
        background: checked ? 'var(--accent)' : 'var(--slate-300)',
        transition: 'background .2s var(--ease-out)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? w - knob - 3 : 3,
          width: knob,
          height: knob,
          borderRadius: 999,
          background: '#fff',
          boxShadow: 'var(--shadow-xs)',
          transition: 'left .2s var(--ease-out)',
        }}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Avatar — initials fallback over a blue gradient
// ---------------------------------------------------------------------------

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

export function Avatar({
  name,
  avatarUrl,
  size = 44,
}: {
  name: string
  avatarUrl?: string | null
  size?: number
}) {
  return (
    <div
      style={{
        flex: 'none',
        width: size,
        height: size,
        borderRadius: 999,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, var(--blue-500) 0%, var(--blue-700) 100%)',
        color: '#fff',
        font: `700 ${Math.round(size * 0.36)}px/1 var(--font-sans)`,
      }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <span>{computeInitials(name)}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SearchButton — primary / secondary
// ---------------------------------------------------------------------------

export function SearchButton({
  variant = 'primary',
  onClick,
  leadingIcon,
  children,
}: {
  variant?: 'primary' | 'secondary'
  onClick: () => void
  leadingIcon?: ReactNode
  children: ReactNode
}) {
  const primary = variant === 'primary'
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 20px',
    borderRadius: 14,
    cursor: 'pointer',
    font: '600 14.5px/1 var(--font-sans)',
    background: primary ? 'var(--accent)' : 'var(--white)',
    color: primary ? '#fff' : 'var(--slate-700)',
    border: primary ? 'none' : '1px solid var(--edge)',
    boxShadow: primary ? 'var(--shadow-sm)' : 'var(--shadow-xs)',
  }
  return (
    <button type="button" onClick={onClick} style={style}>
      {leadingIcon}
      {children}
    </button>
  )
}
