import { ShieldCheck, CreditCard, Lock, MapPin } from 'lucide-react'

const BADGES = [
  { Icon: ShieldCheck, label: '§14 UStG',  sub: 'rechtssicher',  iconColor: '#1F46C8' },
  { Icon: CreditCard,  label: 'Apple Pay',  sub: null,            iconColor: '#0D1526' },
  { Icon: Lock,        label: 'Zahlung',   sub: null,            iconColor: '#1A6B40' },
  { Icon: MapPin,      label: 'Made in',    sub: 'Deutschland',   iconColor: '#7C5533' },
] as const

export default function TrustBadges() {
  return (
    <div className="mx-4 grid grid-cols-4 gap-2">
      {BADGES.map(({ Icon, label, sub, iconColor }) => (
        <div
          key={label}
          className="flex flex-col items-center gap-1.5 rounded-[13px] bg-surface px-1 py-3 ring-1 ring-edge"
        >
          <Icon size={15} style={{ color: iconColor }} aria-hidden />
          <div className="min-w-0 text-center leading-tight">
            <p className="text-[10.5px] font-semibold text-ink break-words">{label}</p>
            {sub && <p className="text-[9.5px] text-ink-sub mt-[1px] break-words">{sub}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}
