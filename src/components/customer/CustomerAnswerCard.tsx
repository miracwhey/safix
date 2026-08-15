/**
 * CustomerAnswerCard — presentational answer card for the customer home (Block 2).
 *
 * Pure presentation: it renders a `CustomerAnswerCardModel` and owns no
 * lifecycle logic. The icon is a Lucide component mapped from the model's
 * semantic `iconKey` — the raw `NextAction.icon` emoji is never rendered.
 *
 * Anatomy (constant across tones): a status pill chip (icon + short word) with
 * the project title on the right, a headline, a body sentence, an optional
 * escrow badge, then the CTA. Four tones drive colour + CTA weight:
 *   nudge / loud → blue gradient card, solid white CTA button (actionable)
 *   calm         → white card, quiet brand link (in progress)
 *   done         → muted card, quiet link (terminal)
 *
 * The escrow badge appears ONLY when `model.escrowConfirmed` (canonical funded
 * truth), so it never claims security on an offer / funding-required state.
 */

import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  Scale,
  Search,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import type {
  AnswerCardIconKey,
  AnswerCardTone,
  CustomerAnswerCardModel,
} from '../../lib/viewmodel/customerAnswerCard'

const ICONS: Record<AnswerCardIconKey, LucideIcon> = {
  nudge: Search,
  dispute: Scale,
  pay: CreditCard,
  secured: ShieldCheck,
  offer: FileText,
  pending: Clock,
  done: CheckCircle2,
}

type ToneStyle = {
  container: string
  chip: string
  title: string
  headline: string
  body: string
  escrow: string
  cta: 'solid' | 'quiet'
  quietLink: string
}

// Blue gradient + inset highlight + brand glow — shared by nudge & loud.
const BLUE_CARD =
  'text-white bg-[linear-gradient(158deg,#2E6BF0_0%,#1D4ED8_52%,#1A3FB5_100%)] ' +
  'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22),0_18px_38px_-18px_rgba(29,78,216,0.6)]'

const TONE: Record<AnswerCardTone, ToneStyle> = {
  loud: {
    container: BLUE_CARD,
    chip: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    title: 'text-white/75',
    headline: 'text-white',
    body: 'text-white/85',
    escrow: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    cta: 'solid',
    quietLink: 'text-white',
  },
  nudge: {
    container: BLUE_CARD,
    chip: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    title: 'text-white/75',
    headline: 'text-white',
    body: 'text-white/85',
    escrow: 'bg-white/15 text-white ring-1 ring-inset ring-white/25',
    cta: 'solid',
    quietLink: 'text-white',
  },
  calm: {
    container: 'bg-surface text-ink ring-1 ring-edge/80 shadow-elevated',
    chip: 'bg-brand-tint text-brand ring-1 ring-inset ring-brand/15',
    title: 'text-ink-muted',
    headline: 'text-ink',
    body: 'text-ink-sub',
    escrow: 'bg-emerald-50 text-emerald-700',
    cta: 'quiet',
    quietLink: 'text-brand',
  },
  done: {
    container: 'bg-slate-50 text-ink ring-1 ring-edge',
    chip: 'bg-emerald-50 text-emerald-700',
    title: 'text-ink-muted',
    headline: 'text-ink-sub',
    body: 'text-ink-muted',
    escrow: 'bg-emerald-50 text-emerald-700',
    cta: 'quiet',
    quietLink: 'text-ink-muted',
  },
}

function AnswerCardCta({
  model,
  tone,
}: {
  model: CustomerAnswerCardModel
  tone: ToneStyle
}) {
  if (tone.cta === 'quiet') {
    return (
      <Link
        to={model.route.to}
        state={model.route.state}
        className={`mt-3.5 inline-flex items-center gap-1.5 text-[13.5px] font-semibold ${tone.quietLink}`}
      >
        {model.ctaLabel} <span aria-hidden>→</span>
      </Link>
    )
  }
  return (
    <Link
      to={model.route.to}
      state={model.route.state}
      className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-[linear-gradient(180deg,#ffffff,#F4F7FD)] py-3.5 text-[14px] font-bold text-brand-deep shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9),0_8px_18px_-10px_rgba(2,6,23,0.45)] transition active:scale-[0.98]"
    >
      {model.ctaLabel} <span aria-hidden>→</span>
    </Link>
  )
}

export default function CustomerAnswerCard({ model }: { model: CustomerAnswerCardModel }) {
  const tone = TONE[model.tone]
  const Icon = ICONS[model.iconKey]

  return (
    <div className={`rounded-[24px] p-[22px] ${tone.container}`}>
      <div className="flex items-center justify-between gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone.chip}`}
        >
          <Icon size={13} aria-hidden />
          {model.chip}
        </span>
        <span className={`max-w-[44%] truncate text-[11px] font-semibold ${tone.title}`}>
          {model.projectTitle}
        </span>
      </div>

      <h2 className={`mt-3.5 text-[22px] font-bold leading-[1.16] tracking-[-0.02em] ${tone.headline}`}>
        {model.label}
      </h2>
      <p className={`mt-1.5 text-[13px] leading-[1.45] ${tone.body}`}>{model.text}</p>

      {model.escrowConfirmed && (
        <div
          className={`mt-3 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${tone.escrow}`}
        >
          <ShieldCheck size={12} aria-hidden />
          Zahlung gesichert
        </div>
      )}

      <AnswerCardCta model={model} tone={tone} />
    </div>
  )
}

/**
 * Loading placeholder with a fixed minimum height that matches the rendered
 * card, so the home does not shift (CLS) when the answer card hydrates.
 */
export function CustomerAnswerCardSkeleton() {
  return (
    <div
      className="min-h-[156px] rounded-[24px] bg-surface p-[22px] ring-1 ring-edge shadow-elevated"
      aria-hidden
    >
      <div className="flex items-center justify-between">
        <span className="h-6 w-28 animate-pulse rounded-full bg-slate-100" />
        <span className="h-3 w-16 animate-pulse rounded bg-slate-100" />
      </div>
      <div className="mt-4 h-5 w-3/4 animate-pulse rounded bg-slate-100" />
      <div className="mt-2 h-3 w-full animate-pulse rounded bg-slate-100" />
      <div className="mt-4 h-11 w-full animate-pulse rounded-[14px] bg-slate-100" />
    </div>
  )
}
