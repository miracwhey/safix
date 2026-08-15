import type { Role, CraftsmanRole } from '../../lib/profile'

type Props = {
  email: string
  role?: Role | null
  craftsmanRole?: CraftsmanRole | null
}

function roleBadgeText(role: Role | null | undefined, craftsmanRole: CraftsmanRole | null | undefined): string | null {
  if (role === 'customer') return 'Kunde'
  if (role === 'craftsman') {
    if (craftsmanRole === 'owner') return 'Handwerker · Betriebsinhaber'
    if (craftsmanRole === 'worker') return 'Handwerker · Mitarbeiter'
    return 'Handwerker'
  }
  return null
}

export default function ProfileAccountCard({ email, role, craftsmanRole }: Props) {
  const badge = roleBadgeText(role, craftsmanRole)

  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[18px] font-semibold text-slate-900 break-all">
        {email}
      </div>

      {badge && (
        <div className="mt-1.5 inline-block rounded-full bg-slate-100 px-3 py-1 text-[12px] font-medium text-slate-600">
          {badge}
        </div>
      )}
    </div>
  )
}
