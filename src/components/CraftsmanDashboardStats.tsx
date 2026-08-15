type Props = {
  activeJobs: number
  jobsInProgress: number
  waitingPayment: number
  openChats: number
}

function StatCard({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div
      className={[
        'rounded-[26px] p-4 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.35)]',
        highlight
          ? 'bg-[#2563EB] text-white ring-[#2563EB]/40'
          : 'bg-white text-slate-900 ring-slate-200/70',
      ].join(' ')}
    >
      <div
        className={[
          'text-[12px] font-semibold uppercase tracking-[0.14em]',
          highlight ? 'text-white/75' : 'text-slate-400',
        ].join(' ')}
      >
        {label}
      </div>

      <div className="mt-2 text-[24px] font-semibold leading-none">
        {value}
      </div>
    </div>
  )
}

export default function CraftsmanDashboardStats({
  activeJobs,
  jobsInProgress,
  waitingPayment,
  openChats,
}: Props) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <StatCard label="Aktive Jobs" value={activeJobs} highlight />
      <StatCard label="In Arbeit" value={jobsInProgress} />
      <StatCard label="Zahlung offen" value={waitingPayment} />
      <StatCard label="Chats" value={openChats} />
    </div>
  )
}
