import { Link } from 'react-router-dom'
import { CreditCard, Settings } from 'lucide-react'
import type { SetupReminder } from '../../lib/dashboard/workEntrySelectors'

type Props = {
  reminder: SetupReminder
}

function pickIcon(reminder: SetupReminder) {
  const isPayout =
    reminder.linkTo.includes('payout') ||
    reminder.linkTo.includes('onboarding') ||
    reminder.icon === '💳'
  return isPayout
    ? <CreditCard size={16} aria-hidden />
    : <Settings size={16} aria-hidden />
}

export default function SetupReminderCard({ reminder }: Props) {
  if (reminder.loading) {
    return (
      <div
        className="flex items-center gap-3 rounded-[18px] bg-white p-3.5 ring-1 ring-slate-200/70 shadow-subtle"
        aria-busy="true"
        aria-label="Einrichtungsstatus wird geladen"
      >
        <div className="h-8 w-8 shrink-0 rounded-xl bg-slate-100">
          <div className="h-full w-full rounded-xl bg-slate-200 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-2.5 w-20 rounded bg-slate-200 animate-pulse" />
          <div className="h-3 w-36 rounded bg-slate-200 animate-pulse" />
        </div>
        <div className="h-7 w-16 shrink-0 rounded-lg bg-slate-200 animate-pulse" />
      </div>
    )
  }

  if (!reminder.visible) return null

  return (
    <Link
      to={reminder.linkTo}
      className="flex items-center gap-3 rounded-[18px] bg-white px-4 py-3.5 ring-1 ring-slate-200/70 shadow-[0_4px_14px_-10px_rgba(2,6,23,0.12)] transition active:scale-[0.98]"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
        {pickIcon(reminder)}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold leading-snug text-ink">
          {reminder.headline}
        </h3>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">
          {reminder.subtitle}
        </p>
      </div>
      <span className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-[12px] font-semibold text-white">
        Einrichten
      </span>
    </Link>
  )
}
