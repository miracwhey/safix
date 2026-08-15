import { Link } from 'react-router-dom'
import type { OnboardingStep, OnboardingStepStatus } from '../../lib/onboarding/selectors'

type Props = {
  step: OnboardingStep
}

const ICON: Record<OnboardingStepStatus, string> = {
  complete: '✓',
  next: '→',
  incomplete: '○',
}

const ICON_CLASS: Record<OnboardingStepStatus, string> = {
  complete: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  next: 'bg-blue-100 text-blue-700 ring-1 ring-blue-200',
  incomplete: 'bg-slate-100 text-slate-400 ring-1 ring-slate-200',
}

const TITLE_CLASS: Record<OnboardingStepStatus, string> = {
  complete: 'text-slate-400 line-through',
  next: 'text-slate-900 font-semibold',
  incomplete: 'text-slate-600',
}

/**
 * A single row in the onboarding progress list.
 *
 * - 'complete' steps are rendered as static (greyed out with strikethrough).
 * - 'next' steps are wrapped in a Link and styled as the primary CTA.
 * - 'incomplete' steps are rendered as static (muted).
 */
export default function OnboardingStepRow({ step }: Props) {
  const { status, title, description, navigationPath } = step

  const inner = (
    <div
      className={['flex items-center gap-3 py-2', status === 'complete' ? 'opacity-70' : ''].filter(Boolean).join(' ')}
    >
      {/* Status icon */}
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${ICON_CLASS[status]}`}
        aria-label={status}
      >
        {ICON[status]}
      </div>

      {/* Text content */}
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] leading-snug ${TITLE_CLASS[status]}`}>{title}</div>
        <div className="text-[12px] text-slate-500 leading-snug">{description}</div>
      </div>

      {/* Chevron only on the active next step */}
      {status === 'next' && <span className="shrink-0 text-[16px] text-blue-400">›</span>}
    </div>
  )

  if (status === 'next') {
    return (
      <Link
        to={navigationPath}
        className="block rounded-xl transition hover:bg-blue-50 active:scale-[0.98]"
      >
        {inner}
      </Link>
    )
  }

  return <div>{inner}</div>
}
