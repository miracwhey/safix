import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { MediaArtifactViewModel } from '../../lib/media'

type Props = {
  artifacts: MediaArtifactViewModel[]
  onAttachProgressPhoto: () => void
  onAttachCompletionPhoto: () => void
}

export default function JobArtifactsCard({
  artifacts,
  onAttachProgressPhoto,
  onAttachCompletionPhoto,
}: Props) {
  const photos = artifacts.filter((a) => a.isPhoto)
  const documents = artifacts.filter((a) => a.isDocument)
  const hasCompletionPhoto = artifacts.some((a) => a.kind === 'completion_photo')

  const buttonClass =
    'rounded-[20px] bg-white px-4 py-4 text-left ring-1 ring-slate-200/70 shadow-[0_16px_36px_-28px_rgba(2,6,23,0.22)] transition active:scale-[0.99]'

  return (
    <CraftsmanSectionCard
      eyebrow="Medien"
      title="Arbeitsnachweise"
      subtitle="Fotos und Dokumente als Nachweis für Fortschritt und Abschluss des Auftrags."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onAttachProgressPhoto}
            className={buttonClass}
          >
            <div className="text-[15px] font-semibold text-slate-900">
              Fortschrittsfoto
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              Arbeit dokumentieren
            </div>
          </button>

          <button
            type="button"
            onClick={onAttachCompletionPhoto}
            className={buttonClass}
          >
            <div className="text-[15px] font-semibold text-slate-900">
              Abschlussfoto
            </div>
            <div className="mt-1 text-[13px] text-slate-500">
              {hasCompletionPhoto ? 'Weiteres Foto hinzufügen' : 'Fertigstellung belegen'}
            </div>
            {!hasCompletionPhoto && photos.length > 0 && (
              <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                ⚠ Noch ausstehend
              </div>
            )}
          </button>
        </div>

        {artifacts.length === 0 ? (
          <div className="rounded-[20px] bg-slate-50 px-4 py-4 text-[14px] text-slate-500 ring-1 ring-slate-200/70">
            Noch keine Anhänge vorhanden
          </div>
        ) : (
          <div className="space-y-3">
            {photos.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Fotos ({photos.length})
                </div>
                <div className="space-y-2">
                  {photos.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-[20px] bg-white px-4 py-3 ring-1 ring-slate-200/70"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-semibold text-slate-900">
                            {a.label}
                          </div>
                          <div className="mt-0.5 text-[13px] text-slate-500">
                            {a.filename}
                          </div>
                        </div>
                        <div className="shrink-0 rounded-full bg-violet-50 px-3 py-1 text-[12px] font-semibold text-violet-700">
                          {a.kindLabel}
                        </div>
                      </div>
                      <div className="mt-2 text-[12px] text-slate-400">
                        {a.uploadedAtLabel}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {documents.length > 0 && (
              <div>
                <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  Dokumente ({documents.length})
                </div>
                <div className="space-y-2">
                  {documents.map((a) => (
                    <div
                      key={a.id}
                      className="rounded-[20px] bg-white px-4 py-3 ring-1 ring-slate-200/70"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-semibold text-slate-900">
                            {a.label}
                          </div>
                          <div className="mt-0.5 text-[13px] text-slate-500">
                            {a.filename}
                          </div>
                        </div>
                        <div className="shrink-0 rounded-full bg-violet-50 px-3 py-1 text-[12px] font-semibold text-violet-700">
                          {a.kindLabel}
                        </div>
                      </div>
                      <div className="mt-2 text-[12px] text-slate-400">
                        {a.uploadedAtLabel}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
