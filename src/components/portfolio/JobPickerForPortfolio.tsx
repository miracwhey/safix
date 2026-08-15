import { useState } from 'react'
import { ArrowLeft, Image, MapPin, X } from 'lucide-react'
import { getCompletedJobs } from '../../lib/jobs/service'
import { fetchMediaForEntity } from '../../lib/media/mediaUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import type { JobPhotoSelection } from '../../lib/providerMedia/portfolioItemService'
import type { Job } from '../../lib/jobs/types'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'

type Phase = 'jobs' | 'photos'

type Props = {
  onClose: () => void
  onPhotoSelected: (selection: JobPhotoSelection) => void
}

export default function JobPickerForPortfolio({ onClose, onPhotoSelected }: Props) {
  const [phase, setPhase] = useState<Phase>('jobs')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [photos, setPhotos] = useState<PersistedMediaRecord[] | null>(null)
  const [photosLoading, setPhotosLoading] = useState(false)
  const [photosError, setPhotosError] = useState<string | null>(null)

  // Jobs with photos (completed or cancelled status, photoCount > 0)
  const completedJobs = getCompletedJobs()
  const jobsWithPhotos = completedJobs.filter((j) => j.photoCount > 0)

  function handleJobTap(job: Job) {
    setSelectedJob(job)
    setPhotos(null)
    setPhotosError(null)
    setPhase('photos')
    setPhotosLoading(true)

    fetchMediaForEntity('job', job.id)
      .then((records) => {
        setPhotos(records)
      })
      .catch(() => {
        setPhotosError('Fotos konnten nicht geladen werden.')
        setPhotos([])
      })
      .finally(() => setPhotosLoading(false))
  }

  function handlePhotoTap(record: PersistedMediaRecord) {
    if (!selectedJob) return
    onPhotoSelected({
      jobId: selectedJob.id,
      jobTitle: selectedJob.title,
      jobLocation: selectedJob.location,
      jobAmount: resolveCanonicalAmount(selectedJob.id).formatted || selectedJob.amount,
      mediaRecordId: record.id,
      publicUrl: record.publicUrl,
      storagePath: record.filePath,
      mediaType: record.mediaType,
    })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[24px] bg-white"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-slate-300" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-2 pb-3 shrink-0">
          {phase === 'photos' && (
            <button
              type="button"
              onClick={() => { setPhase('jobs'); setSelectedJob(null); setPhotos(null) }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-edge transition active:scale-90"
            >
              <ArrowLeft size={16} className="text-ink" aria-hidden />
            </button>
          )}
          <h2 className="flex-1 text-[16px] font-bold text-ink truncate">
            {phase === 'jobs' ? 'Projekt auswählen' : (selectedJob?.title ?? 'Foto auswählen')}
          </h2>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-ink-muted transition active:scale-90"
          >
            <X size={15} aria-hidden />
          </button>
        </div>

        {/* Content — scrollable */}
        <div className="flex-1 overflow-y-auto pb-[max(20px,env(safe-area-inset-bottom))]">

          {/* ── Phase: Job list ── */}
          {phase === 'jobs' && (
            <div className="px-4 space-y-2">
              {completedJobs.length === 0 ? (
                <EmptyState
                  icon={<Image size={20} className="text-ink-muted" aria-hidden />}
                  title="Noch keine abgeschlossenen Jobs"
                  sub="Abgeschlossene Jobs erscheinen hier, wenn du Fotos dokumentiert hast."
                />
              ) : jobsWithPhotos.length === 0 ? (
                <EmptyState
                  icon={<Image size={20} className="text-ink-muted" aria-hidden />}
                  title="Keine Jobs mit Fotos"
                  sub="Lade Fotos bei einem Job hoch, um sie hier als Arbeitsprobe zu verwenden."
                />
              ) : (
                jobsWithPhotos.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => handleJobTap(job)}
                    className="flex w-full items-start gap-3 rounded-xl bg-surface px-4 py-3 text-left ring-1 ring-edge transition active:scale-[0.98] active:bg-canvas"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-canvas ring-1 ring-edge/60">
                      <Image size={16} className="text-ink-muted" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-ink truncate">{job.title}</p>
                      {job.location ? (
                        <p className="flex items-center gap-1 text-[11px] text-ink-muted mt-0.5">
                          <MapPin size={10} aria-hidden />
                          {job.location}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-ink-muted mt-0.5">
                        {job.photoCount} {job.photoCount === 1 ? 'Foto' : 'Fotos'}
                        {(() => { const amt = resolveCanonicalAmount(job.id).formatted || job.amount; return amt ? ` · ${amt}` : '' })()}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* ── Phase: Photo grid ── */}
          {phase === 'photos' && (
            <div className="px-4">
              {photosLoading ? (
                <div className="grid grid-cols-3 gap-[2px]">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="bg-slate-100 animate-pulse"
                      style={{ aspectRatio: '1 / 1' }}
                    />
                  ))}
                </div>
              ) : photosError ? (
                <p className="py-8 text-center text-[13px] text-red-500">{photosError}</p>
              ) : !photos || photos.length === 0 ? (
                <EmptyState
                  icon={<Image size={20} className="text-ink-muted" aria-hidden />}
                  title="Keine Fotos gefunden"
                  sub="Dieser Job hat keine gespeicherten Fotos in der Dokumentation."
                />
              ) : (
                <>
                  <p className="mb-2 text-[12px] text-ink-muted">
                    Foto antippen, das du als Arbeitsprobe verwenden möchtest.
                  </p>
                  <div className="grid grid-cols-3 gap-[2px]">
                    {photos.map((record) => (
                      <PhotoTile
                        key={record.id}
                        record={record}
                        onTap={handlePhotoTap}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PhotoTile({
  record,
  onTap,
}: {
  record: PersistedMediaRecord
  onTap: (r: PersistedMediaRecord) => void
}) {
  const [errored, setErrored] = useState(false)

  return (
    <button
      type="button"
      onClick={() => onTap(record)}
      className="relative bg-slate-100 transition active:opacity-70"
      style={{ aspectRatio: '1 / 1' }}
    >
      {record.mediaType === 'video' ? (
        <div className="flex h-full w-full items-center justify-center bg-slate-800">
          <span className="text-[10px] font-bold text-white">▶</span>
        </div>
      ) : errored ? (
        <div className="flex h-full w-full items-center justify-center">
          <Image size={14} className="text-slate-400" aria-hidden />
        </div>
      ) : (
        <img
          src={record.publicUrl}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      )}
    </button>
  )
}

function EmptyState({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface ring-1 ring-edge">
        {icon}
      </div>
      <div>
        <p className="text-[13px] font-semibold text-ink-sub">{title}</p>
        <p className="mt-0.5 text-[12px] text-ink-muted">{sub}</p>
      </div>
    </div>
  )
}
