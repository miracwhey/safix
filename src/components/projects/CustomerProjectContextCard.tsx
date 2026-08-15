type Props = {
  price: string
  photoCount: number
  noteCount: number
  messageCount: number
  /** When true, message count shows a loading indicator instead of a number. */
  messagesLoading?: boolean
}

type ContextRowProps = {
  icon: string
  label: string
  value: string
}

function ContextRow({ icon, label, value }: ContextRowProps) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-[16px] leading-none">{icon}</span>
        <span className="text-[14px] text-slate-500">{label}</span>
      </div>
      <span className="text-[14px] font-semibold text-slate-900">{value}</span>
    </div>
  )
}

/**
 * Unified project context card shown at the bottom of the customer project
 * detail screen. Consolidates price, documentation counts and communication
 * count into a single scannable surface instead of three separate cards.
 */
export default function CustomerProjectContextCard({
  price,
  photoCount,
  noteCount,
  messageCount,
  messagesLoading = false,
}: Props) {
  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        Projektdetails
      </div>

      <div className="mt-3 divide-y divide-slate-100">
        {price ? <ContextRow icon="💶" label="Auftragswert" value={price} /> : null}
        <ContextRow
          icon="📸"
          label="Dokumentation"
          value={`${photoCount} Foto${photoCount !== 1 ? 's' : ''} · ${noteCount} Notiz${noteCount !== 1 ? 'en' : ''}`}
        />
        <ContextRow
          icon="💬"
          label="Nachrichten"
          value={messagesLoading ? '…' : `${messageCount} Nachricht${messageCount !== 1 ? 'en' : ''}`}
        />
      </div>
    </section>
  )
}
