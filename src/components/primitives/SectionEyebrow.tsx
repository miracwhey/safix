/**
 * SectionEyebrow — small uppercase section label with a fading divider line,
 * used above home sections ("Schnellzugriff", "Meine Räume"). Pure presentation.
 */
export default function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-ink-muted">
        {children}
      </span>
      <span
        className="h-px flex-1 bg-[linear-gradient(90deg,rgba(15,23,42,0.10),rgba(15,23,42,0))]"
        aria-hidden
      />
    </div>
  )
}
