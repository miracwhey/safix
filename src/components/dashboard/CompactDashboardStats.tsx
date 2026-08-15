import { Link } from 'react-router-dom'
import { Briefcase, CreditCard, MessageSquare } from 'lucide-react'

type Props = {
  activeJobs: number
  waitingPayment: number
  openChats: number
  todayCount?: number
}

type StatCardProps = {
  icon: React.ReactNode
  value: number
  label: string
  to: string
  accent?: boolean
}

function StatCard({ icon, value, label, to, accent }: StatCardProps) {
  const isZero = value === 0
  return (
    <Link
      to={to}
      className="flex flex-col gap-2 rounded-[18px] bg-white p-3.5 ring-1 ring-slate-200/70 shadow-[0_4px_12px_-8px_rgba(14,30,80,0.08)] transition active:scale-[0.97]"
    >
      <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${
        isZero ? 'bg-slate-100 text-slate-300' : accent ? 'bg-brand-50 text-brand' : 'bg-slate-100 text-ink-sub'
      }`}>
        {icon}
      </div>
      <div>
        <div
          className={`text-[22px] font-extrabold tabular-nums leading-none ${
            isZero ? 'text-slate-300' : accent ? 'text-brand' : 'text-ink'
          }`}
        >
          {value}
        </div>
        <div className="mt-0.5 text-[11px] font-medium text-ink-muted">
          {label}
        </div>
      </div>
    </Link>
  )
}

export default function CompactDashboardStats({ activeJobs, waitingPayment, openChats }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      <StatCard
        icon={<Briefcase size={16} aria-hidden />}
        value={activeJobs}
        label="Aufträge"
        to="/craftsman/jobs?focus=handlungsbedarf"
        accent
      />
      <StatCard
        icon={<CreditCard size={16} aria-hidden />}
        value={waitingPayment}
        label="Zahlungen"
        to="/craftsman/finance"
        accent
      />
      <StatCard
        icon={<MessageSquare size={16} aria-hidden />}
        value={openChats}
        label="Nachrichten"
        to="/craftsman/messages"
      />
    </div>
  )
}
