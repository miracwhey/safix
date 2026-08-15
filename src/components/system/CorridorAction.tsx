import { type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Spinner from './Spinner'

/**
 * Action role hierarchy for the trust-defining core corridor.
 *
 * ─── ROLE DEFINITIONS ──────────────────────────────────────────────
 *
 * primary     The single most important forward-progress action on this
 *             screen or card right now.  Visually dominant.
 *             Only ONE primary per visible action group.
 *
 * secondary   Supporting actions that are useful but should not compete
 *             with the primary.  Visible but calmer.
 *
 * destructive Cancel, close, remove, reject — irreversible or risky
 *             actions that must be clearly distinct from forward progress.
 *             Never styled like a recommended next step.
 *
 * ghost       Utility / navigation / tertiary actions (back, dismiss,
 *             "show more"). Minimal visual weight.
 *
 * ─── USAGE RULES ───────────────────────────────────────────────────
 *
 * - Do not use `primary` for destructive actions.
 * - Do not use `destructive` for neutral cancellation of modals;
 *   use `ghost` for dismiss/close.
 * - When a screen is in a terminal or blocked state, prefer `ghost`
 *   or `secondary` — avoid a field of equally loud primaries.
 * - Button loading state replaces label text, not structure.
 *
 * ─── SIZES ─────────────────────────────────────────────────────────
 *
 * md (default)  Standard corridor action — card footers, screen CTAs.
 * sm            Compact actions inside dense cards, form rows, or
 *               inline action zones. Same visual hierarchy, less height.
 */

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost'
type Size = 'sm' | 'md'

type BaseProps = {
  variant?: Variant
  size?: Size
  /** Full-width block layout (default true). */
  block?: boolean
  disabled?: boolean
  loading?: boolean
  /**
   * Success morph (D2): the button turns green and a check pops in (spring).
   * For confirming moments only — never on destructive/critical actions or
   * money. The caller owns the timing (flip back to idle after ~1.8 s).
   */
  success?: boolean
  /** Label shown while `success` is active (default: keep children). */
  successLabel?: ReactNode
  /** Accessible label when icon-only. */
  'aria-label'?: string
  'data-testid'?: string
  className?: string
  children: ReactNode
}

type ButtonProps = BaseProps & {
  /** Click handler. Optional for type="submit" buttons inside forms. */
  onClick?: () => void
  to?: never
  type?: 'button' | 'submit'
}

type LinkProps = BaseProps & {
  to: string
  onClick?: never
  type?: never
}

type Props = ButtonProps | LinkProps

// ── Variant styles ─────────────────────────────────────────────────

const VARIANT_STYLES: Record<Variant, { base: string; disabled: string }> = {
  primary: {
    base: [
      'bg-[#0b1220] text-white ring-1 ring-white/10',
      'shadow-[0_14px_28px_-18px_rgba(2,6,23,0.75),0_2px_10px_-8px_rgba(2,6,23,0.25)]',
      'active:scale-[0.98]',
    ].join(' '),
    disabled: 'bg-slate-200 text-slate-400 ring-1 ring-slate-200 shadow-none cursor-not-allowed',
  },
  secondary: {
    base: [
      'bg-white text-slate-700 ring-1 ring-slate-200/70',
      'shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)]',
      'active:scale-[0.98] active:bg-slate-50',
    ].join(' '),
    disabled: 'bg-slate-50 text-slate-300 ring-1 ring-slate-200/50 shadow-none cursor-not-allowed',
  },
  destructive: {
    base: [
      'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
      'active:scale-[0.98] active:bg-rose-100',
    ].join(' '),
    disabled: 'bg-rose-50/50 text-rose-300 ring-1 ring-rose-100 cursor-not-allowed',
  },
  ghost: {
    base: [
      'bg-transparent text-slate-500',
      'active:bg-slate-50',
    ].join(' '),
    disabled: 'bg-transparent text-slate-300 cursor-not-allowed',
  },
}

const SIZE_CLASSES: Record<Size, string> = {
  md: 'rounded-[16px] py-3 text-[14px] font-semibold',
  sm: 'rounded-[12px] py-2 text-[13px] font-semibold',
}

// Success morph target — green field, calmer-than-primary lift. Overrides the
// variant styling entirely while `success` is active.
const SUCCESS_CLASS =
  'bg-green-600 text-white ring-1 ring-green-600 shadow-[0_12px_30px_-8px_rgba(22,163,74,0.5)] cursor-default'

const BASE_CLASSES = 'transition-transform duration-200'

/**
 * Shared action button for the corridor.
 *
 * Enforces consistent visual hierarchy across primary, secondary,
 * destructive, and ghost action roles.
 *
 * Does not encode business logic — only presentation semantics.
 */
export default function CorridorAction({
  variant = 'primary',
  size = 'md',
  block = true,
  disabled = false,
  loading = false,
  success = false,
  successLabel,
  className,
  children,
  ...rest
}: Props) {
  // Success looks active (green), not greyed out — so it is not part of the
  // disabled styling, but it does make the control non-interactive.
  const isDisabled = disabled || loading
  const isInert = isDisabled || success
  const styles = VARIANT_STYLES[variant]
  const variantClass = success ? SUCCESS_CLASS : isDisabled ? styles.disabled : styles.base

  const classes = [
    BASE_CLASSES,
    SIZE_CLASSES[size],
    block ? 'w-full' : '',
    variantClass,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  // Priority: success morph → loading → idle. Loading keeps the label visible
  // and prepends the one arc spinner so the button never collapses mid-write;
  // success swaps to a spring-popped check (confirming moments only).
  const content = success ? (
    <span className="inline-flex items-center justify-center gap-2">
      <span className="inline-flex animate-fx-success-pop" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      {successLabel ?? children}
    </span>
  ) : loading ? (
    <span className="inline-flex items-center justify-center gap-2">
      <Spinner size="sm" tone="current" inButton />
      {children}
    </span>
  ) : (
    children
  )

  if ('to' in rest && rest.to) {
    return (
      <Link
        to={rest.to}
        className={classes}
        aria-disabled={isInert || undefined}
        aria-label={rest['aria-label']}
        data-testid={rest['data-testid']}
      >
        {content}
      </Link>
    )
  }

  return (
    <button
      type={(rest as ButtonProps).type ?? 'button'}
      disabled={isInert}
      onClick={isInert ? undefined : (rest as ButtonProps).onClick}
      className={classes}
      aria-label={rest['aria-label']}
      data-testid={rest['data-testid']}
    >
      {content}
    </button>
  )
}
