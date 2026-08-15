import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { Job } from '../../lib/jobs'

type Props = {
  currentStatus: Job['status']
  onChange: (status: Job['status']) => void
}

const statusOptions: Array<{ value: Job['status']; label: string }> = [
  { value: 'new', label: 'Neu' },
  { value: 'scheduled', label: 'Geplant' },
  { value: 'in_progress', label: 'In Arbeit' },
  { value: 'waiting_payment', label: 'Wartet auf Zahlung' },
  { value: 'completed', label: 'Abgeschlossen' },
]

export default function JobStatusSection({
  currentStatus,
  onChange,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Status"
      title="Auftragsstatus"
      subtitle="Hier steuerst du den operativen Fortschritt des Jobs."
    >
      <div className="grid grid-cols-1 gap-3">
        {statusOptions.map((option) => {
          const active = option.value === currentStatus

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={[
                'w-full rounded-[20px] px-4 py-4 text-left transition',
                active
                  ? 'bg-[#2563EB] text-white shadow-[0_18px_40px_-28px_rgba(37,99,235,0.65)]'
                  : 'bg-white text-slate-900 ring-1 ring-slate-200/70',
              ].join(' ')}
            >
              <div className="text-[15px] font-semibold">{option.label}</div>
            </button>
          )
        })}
      </div>
    </CraftsmanSectionCard>
  )
}
