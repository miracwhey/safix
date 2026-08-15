type Props = {
  label: string
}

/**
 * Lightweight section label divider used inside the craftsman job detail
 * screen to separate lifecycle and operational sections.
 * Provides visual hierarchy without adding heavy card chrome.
 */
export default function CraftsmanJobSectionDivider({ label }: Props) {
  return (
    <div className="px-1 pt-2 pb-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        {label}
      </div>
    </div>
  )
}
