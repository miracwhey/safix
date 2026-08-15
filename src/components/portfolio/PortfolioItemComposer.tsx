import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Video, Check, Plus, Star } from 'lucide-react'
import {
  createPortfolioItemFromUpload,
  createPortfolioItemFromJob,
  updatePortfolioItem,
} from '../../lib/providerMedia/portfolioItemService'
import type { JobPhotoSelection } from '../../lib/providerMedia/portfolioItemService'
import type { PortfolioItem } from '../../lib/providerMedia/providerMediaTypes'
import {
  IMAGE_VIDEO_ACCEPT,
  resolveMediaType,
  validateMediaFile,
} from '../../lib/media/mediaUploadService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DraftAsset = {
  /** Stable React key — client-side UUID. */
  id: string
  file: File
  previewUrl: string
  mediaType: 'image' | 'video'
}

export type ComposerMediaSource =
  | { kind: 'files'; drafts: DraftAsset[] }
  | { kind: 'job'; selection: JobPhotoSelection }

type CreateProps = {
  mode: 'create'
  providerId: string
  ownerUserId: string
  mediaSource: ComposerMediaSource
  providerTradeTags: string[]
  onClose: () => void
  onSaved: (item: PortfolioItem) => void
}

type EditProps = {
  mode: 'edit'
  item: PortfolioItem
  providerTradeTags: string[]
  onClose: () => void
  onSaved: (item: PortfolioItem) => void
}

type Props = CreateProps | EditProps

type SaveState = 'idle' | 'uploading' | 'saving' | 'error'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PortfolioItemComposer(props: Props) {
  const { mode, providerTradeTags, onClose, onSaved } = props

  const existingItem = mode === 'edit' ? props.item : null
  const jobSelection =
    mode === 'create' && props.mediaSource.kind === 'job'
      ? props.mediaSource.selection
      : null

  const [title, setTitle] = useState(
    existingItem?.title ?? jobSelection?.jobTitle ?? '',
  )
  const [description, setDescription] = useState(existingItem?.description ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(
    existingItem?.tradeTags ?? [],
  )
  const [published, setPublished] = useState(existingItem?.published ?? true)
  const [showPrice, setShowPrice] = useState(existingItem?.showPrice ?? false)
  const [showDuration, setShowDuration] = useState(existingItem?.showDuration ?? false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Multi-asset state (create + files mode only)
  const initialDrafts =
    mode === 'create' && props.mediaSource.kind === 'files'
      ? props.mediaSource.drafts
      : []
  const [drafts, setDrafts] = useState<DraftAsset[]>(initialDrafts)
  const [coverIndex, setCoverIndex] = useState<number>(0)

  // Ref for the "add more" file picker inside the Composer
  const addMoreRef = useRef<HTMLInputElement>(null)
  // Tracks URLs created inside the Composer so they can be revoked on unmount
  const extraUrlsRef = useRef<string[]>([])

  // Revoke initial draft previewUrls on unmount
  useEffect(() => {
    if (mode !== 'create') return
    const src = props.mediaSource
    if (src.kind !== 'files') return
    const urls = src.drafts.map((d) => d.previewUrl)
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Revoke URLs added inside the Composer (via the "+" button)
  useEffect(() => {
    const urls = extraUrlsRef
    return () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])

  // Cleanup object URL for job-selection preview (create + job mode only)
  useEffect(() => {
    if (mode !== 'create') return
    const src = props.mediaSource
    if (src.kind !== 'job') return
    // job photos use existing public URLs — no object URL to revoke
    return undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Derived values for single-preview modes (job + edit)
  const previewUrl = getPreviewUrl(props)
  const isVideo = getIsVideo(props)
  const amountSnapshot =
    existingItem?.amountSnapshot ?? jobSelection?.jobAmount ?? null
  const durationSnapshot = existingItem?.durationSnapshot ?? null

  // Keep coverIndex in bounds when drafts shrink
  const safeCoverIndex = Math.min(coverIndex, Math.max(0, drafts.length - 1))

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  const handleRemoveDraft = useCallback((index: number) => {
    setDrafts((prev) => prev.filter((_, j) => j !== index))
    setCoverIndex((ci) => {
      if (index < ci) return ci - 1
      if (index === ci) return 0
      return ci
    })
  }, [])

  const handleAddMoreFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''
      if (files.length === 0) return
      const newDrafts: DraftAsset[] = []
      for (const file of files) {
        const validation = validateMediaFile(file)
        if (!validation.valid) {
          setErrorMsg(validation.reason)
          continue
        }
        const mediaType = resolveMediaType(file.type)
        const previewUrl = URL.createObjectURL(file)
        extraUrlsRef.current.push(previewUrl)
        newDrafts.push({ id: crypto.randomUUID(), file, previewUrl, mediaType })
      }
      if (newDrafts.length > 0) {
        setDrafts((prev) => [...prev, ...newDrafts])
      }
    },
    [],
  )

  const handleSave = useCallback(async () => {
    setErrorMsg(null)
    try {
      if (mode === 'create') {
        const src = props.mediaSource
        if (src.kind === 'files') {
          if (drafts.length === 0) {
            setErrorMsg('Bitte wähle mindestens ein Bild oder Video aus.')
            return
          }
          setSaveState('uploading')
          const coverDraft = drafts[safeCoverIndex] ?? drafts[0]!
          const restDrafts = drafts.filter((_, i) => i !== safeCoverIndex)
          const item = await createPortfolioItemFromUpload({
            file: coverDraft.file,
            providerId: props.providerId,
            ownerUserId: props.ownerUserId,
            additionalFiles: restDrafts.map((d) => d.file),
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            tradeTags: selectedTags,
            published,
            showPrice,
            showDuration,
          })
          setSaveState('idle')
          onSaved(item)
        } else {
          setSaveState('saving')
          const item = await createPortfolioItemFromJob({
            providerId: props.providerId,
            ownerUserId: props.ownerUserId,
            selection: src.selection,
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            tradeTags: selectedTags,
            published,
            showPrice,
            showDuration,
          })
          setSaveState('idle')
          onSaved(item)
        }
      } else {
        setSaveState('saving')
        const updated = await updatePortfolioItem({
          id: props.item.id,
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          tradeTags: selectedTags,
          published,
          showPrice,
          showDuration,
        })
        setSaveState('idle')
        onSaved(updated)
      }
    } catch (err) {
      setSaveState('error')
      setErrorMsg(err instanceof Error ? err.message : 'Fehler beim Speichern.')
    }
  }, [
    mode,
    props,
    drafts,
    safeCoverIndex,
    title,
    description,
    selectedTags,
    published,
    showPrice,
    showDuration,
    onSaved,
  ])

  const busy = saveState === 'uploading' || saveState === 'saving'
  const saveLabel =
    saveState === 'uploading'
      ? 'Lädt hoch...'
      : saveState === 'saving'
        ? 'Speichert...'
        : mode === 'create'
          ? 'Veröffentlichen'
          : 'Speichern'

  const isMultiFileMode =
    mode === 'create' && props.mediaSource.kind === 'files'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[430px] rounded-t-[24px] bg-white"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-slate-300" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-2 pb-3 shrink-0">
          <h2 className="text-[16px] font-bold text-ink">
            {mode === 'create' ? 'Neue Arbeitsprobe' : 'Arbeitsprobe bearbeiten'}
          </h2>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-ink-muted transition active:scale-90"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 space-y-4 pb-2">

            {/* Multi-asset strip (create + files mode) */}
            {isMultiFileMode && (
              <div>
                <div
                  className="flex gap-2 overflow-x-auto pb-1"
                  style={{ scrollbarWidth: 'none' }}
                >
                  {drafts.map((draft, i) => {
                    const isCover = i === safeCoverIndex
                    return (
                      <div key={draft.id} className="relative shrink-0">
                        <button
                          type="button"
                          onClick={() => setCoverIndex(i)}
                          className={[
                            'relative overflow-hidden rounded-xl transition',
                            isCover
                              ? 'ring-2 ring-brand'
                              : 'ring-1 ring-edge/60',
                          ].join(' ')}
                          style={{ width: 76, height: 76 }}
                          aria-label={isCover ? 'Cover (ausgewählt)' : 'Als Cover setzen'}
                        >
                          {draft.mediaType === 'image' ? (
                            <img
                              src={draft.previewUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-slate-800">
                              <Video size={20} className="text-white/70" aria-hidden />
                            </div>
                          )}
                          {isCover && (
                            <span className="absolute bottom-0 inset-x-0 flex items-center justify-center gap-0.5 bg-brand/85 py-0.5 text-white">
                              <Star size={8} className="fill-white stroke-none" aria-hidden />
                              <span className="text-[9px] font-semibold">Cover</span>
                            </span>
                          )}
                        </button>
                        {drafts.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveDraft(i)}
                            className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-white shadow"
                            aria-label="Entfernen"
                          >
                            <X size={10} aria-hidden />
                          </button>
                        )}
                      </div>
                    )
                  })}

                  {/* Add more button */}
                  <button
                    type="button"
                    onClick={() => addMoreRef.current?.click()}
                    className="shrink-0 flex items-center justify-center rounded-xl ring-1 ring-dashed ring-edge/60 bg-surface transition active:bg-canvas"
                    style={{ width: 76, height: 76 }}
                    aria-label="Weiteres Bild oder Video hinzufügen"
                  >
                    <Plus size={22} className="text-ink-muted" aria-hidden />
                  </button>
                </div>
                {drafts.length > 1 && (
                  <p className="mt-1.5 text-[11px] text-ink-muted">
                    Tippe ein Bild an, um es als Cover zu setzen.
                  </p>
                )}
                {/* Hidden input for adding more files */}
                <input
                  ref={addMoreRef}
                  type="file"
                  accept={IMAGE_VIDEO_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={handleAddMoreFiles}
                />
              </div>
            )}

            {/* Single preview — job selection or edit mode */}
            {!isMultiFileMode && (
              <div
                className="overflow-hidden rounded-xl bg-slate-100"
                style={{
                  aspectRatio: '1 / 1',
                  maxHeight: 200,
                  maxWidth: 200,
                  margin: '0 auto',
                }}
              >
                {isVideo ? (
                  <div className="flex h-full w-full items-center justify-center bg-slate-800">
                    <Video size={28} className="text-white/70" aria-hidden />
                  </div>
                ) : previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Vorschau"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-slate-200" />
                )}
              </div>
            )}

            {/* Edit mode: asset count badge */}
            {mode === 'edit' && (existingItem?.assets.length ?? 0) > 1 && (
              <p className="text-center text-[11px] text-ink-muted">
                {existingItem!.assets.length} Medien in diesem Post
              </p>
            )}

            {/* Snapshot context (from project) */}
            {(jobSelection || existingItem?.projectTitleSnapshot) && (
              <div className="rounded-xl bg-brand/5 px-3 py-2.5 ring-1 ring-brand/20">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand mb-1">
                  Aus Projekt
                </p>
                <p className="text-[12px] text-ink-sub">
                  {jobSelection?.jobTitle ?? existingItem?.projectTitleSnapshot}
                  {(jobSelection?.jobLocation ?? existingItem?.locationSnapshot)
                    ? ` · ${jobSelection?.jobLocation ?? existingItem?.locationSnapshot}`
                    : ''}
                </p>
              </div>
            )}

            {/* Title */}
            <div>
              <label className="block text-[12px] font-semibold text-ink-sub mb-1">
                Titel{' '}
                <span className="font-normal text-ink-muted">(optional)</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="z. B. Badezimmer-Renovierung Hannover"
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-[12px] font-semibold text-ink-sub mb-1">
                Beschreibung{' '}
                <span className="font-normal text-ink-muted">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Kurze öffentliche Beschreibung dieser Arbeit..."
                rows={3}
                className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none resize-none"
              />
            </div>

            {/* Trade tag chips */}
            {providerTradeTags.length > 0 && (
              <div>
                <label className="block text-[12px] font-semibold text-ink-sub mb-1.5">
                  Gewerke{' '}
                  <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {providerTradeTags.map((tag) => {
                    const active = selectedTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className={[
                          'flex items-center gap-1 rounded-chip px-2.5 py-1 text-[11px] font-medium transition active:scale-95',
                          active
                            ? 'bg-brand text-white'
                            : 'bg-surface text-ink-sub ring-1 ring-edge/60',
                        ].join(' ')}
                      >
                        {active && <Check size={10} aria-hidden />}
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Toggles */}
            <div className="space-y-2.5">
              <ToggleRow
                label="Veröffentlichen"
                sub="Auf deinem öffentlichen Profil sichtbar"
                checked={published}
                onChange={setPublished}
              />
              {amountSnapshot ? (
                <ToggleRow
                  label="Preis anzeigen"
                  sub={`Auftragswert: ${amountSnapshot}`}
                  checked={showPrice}
                  onChange={setShowPrice}
                />
              ) : null}
              {durationSnapshot ? (
                <ToggleRow
                  label="Dauer anzeigen"
                  sub={`Projektdauer: ${durationSnapshot}`}
                  checked={showDuration}
                  onChange={setShowDuration}
                />
              ) : null}
            </div>

            {/* Error */}
            {saveState === 'error' && errorMsg && (
              <div className="rounded-xl bg-rose-50 px-3 py-2.5 text-[12px] text-rose-700 ring-1 ring-rose-200">
                {errorMsg}
                <button
                  type="button"
                  onClick={() => {
                    setSaveState('idle')
                    setErrorMsg(null)
                  }}
                  className="ml-2 font-semibold underline"
                >
                  OK
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] shrink-0 border-t border-edge/40">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy}
            className="w-full rounded-card bg-brand py-3 text-[14px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPreviewUrl(props: Props): string | null {
  if (props.mode === 'edit') return props.item.publicUrl
  const src = props.mediaSource
  if (src.kind === 'files') return src.drafts[0]?.previewUrl ?? null
  return src.selection.publicUrl
}

function getIsVideo(props: Props): boolean {
  if (props.mode === 'edit') return props.item.mediaType === 'video'
  const src = props.mediaSource
  if (src.kind === 'files') return (src.drafts[0]?.mediaType ?? 'image') === 'video'
  return src.selection.mediaType === 'video'
}

function ToggleRow({
  label,
  sub,
  checked,
  onChange,
}: {
  label: string
  sub: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="text-[11px] text-ink-muted truncate">{sub}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          'relative flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors',
          checked ? 'bg-brand' : 'bg-slate-300',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          ].join(' ')}
        />
      </button>
    </div>
  )
}
