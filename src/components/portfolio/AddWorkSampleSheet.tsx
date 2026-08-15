import { Images, FolderOpen, X } from 'lucide-react'

type Props = {
  onClose: () => void
  onSelectFromGallery: () => void
  onSelectFromJob: () => void
}

export default function AddWorkSampleSheet({
  onClose,
  onSelectFromGallery,
  onSelectFromJob,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[24px] bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="h-1 w-10 rounded-full bg-slate-300" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-2 pb-4">
          <h2 className="text-[16px] font-bold text-ink">Arbeitsprobe hinzufügen</h2>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-ink-muted transition active:scale-90"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* Options */}
        <div className="px-4 pb-[max(24px,env(safe-area-inset-bottom))] space-y-2">
          <OptionButton
            icon={<FolderOpen size={20} className="text-brand" aria-hidden />}
            label="Aus Projekt übernehmen"
            sub="Foto aus einem abgeschlossenen Job"
            onClick={() => { onSelectFromJob(); onClose() }}
          />
          <OptionButton
            icon={<Images size={20} className="text-ink-sub" aria-hidden />}
            label="Fotos & Videos hochladen"
            sub="Bilder oder Videos aus der Galerie — mehrere möglich"
            onClick={() => { onSelectFromGallery(); onClose() }}
          />
          <p className="px-4 pt-2 text-[11px] leading-snug text-ink-muted">
            Tipp: Für Top-Qualität zuerst in der Foto-App aufnehmen und dann
            aus der Galerie wählen — Live-Aufnahme im App-Browser liefert
            iOS-bedingt nur reduzierte Auflösung.
          </p>
        </div>
      </div>
    </div>
  )
}

function OptionButton({
  icon,
  label,
  sub,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  sub: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-xl bg-surface px-4 py-3.5 text-left ring-1 ring-edge transition active:scale-[0.98] active:bg-canvas"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-canvas ring-1 ring-edge/60">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-ink">{label}</p>
        <p className="text-[12px] text-ink-muted">{sub}</p>
      </div>
    </button>
  )
}
