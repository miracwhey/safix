/**
 * Spatial · Hub · HubSearchSheet (V1.5 · Phase B-P3)
 *
 * Bottom-sheet opened from the Spatial-Hub header Search-Icon. Lets the
 * provider filter across both job-anchored scenes (Hub-pipeline jobs +
 * jobs-without-scan) and the V1.5 pre-sales-projects via a single query.
 *
 * 200 ms debounce mirrors {@link useMaterialSearch}. Host owns the data
 * arrays and the navigation callbacks; the sheet is purely presentational.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Box, Layers, User } from 'lucide-react'

import type { PresalesProject } from '../../../domain/presales/presalesProjectTypes'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'

export interface HubSearchJob {
  jobId: string
  title: string
  customerName: string
  locationLabel: string
  /** Whether the job already has a scene — drives the icon + badge. */
  hasScene: boolean
}

/**
 * Host contract: render conditionally — `{open && <HubSearchSheet … />}`. The
 * sheet expects to be fresh on every open (query/debounce reset, autofocus),
 * which a parent-mount-gate guarantees without a state-resetting effect.
 */
export interface HubSearchSheetProps {
  jobs: readonly HubSearchJob[]
  presales: readonly PresalesProject[]
  onSelectJob: (jobId: string) => void
  onSelectPresales: (presalesId: string) => void
  onClose: () => void
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.84)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

const DEBOUNCE_MS = 200

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

interface JobMatch {
  kind: 'job'
  job: HubSearchJob
}
interface PresalesMatch {
  kind: 'presales'
  project: PresalesProject
}
type Match = JobMatch | PresalesMatch

function filterJobs(jobs: readonly HubSearchJob[], q: string): JobMatch[] {
  if (!q) return []
  return jobs
    .filter(
      (j) =>
        normalize(j.title).includes(q) ||
        normalize(j.customerName).includes(q) ||
        normalize(j.locationLabel).includes(q),
    )
    .map((job) => ({ kind: 'job' as const, job }))
}

function filterPresales(presales: readonly PresalesProject[], q: string): PresalesMatch[] {
  if (!q) return []
  return presales
    .filter((p) => {
      const hay = [p.title, p.locationHint ?? '', p.customerNameDraft ?? '']
      return hay.some((s) => normalize(s).includes(q))
    })
    .map((project) => ({ kind: 'presales' as const, project }))
}

export function HubSearchSheet({
  jobs,
  presales,
  onSelectJob,
  onSelectPresales,
  onClose,
}: HubSearchSheetProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)
  // Ref-callback autofocuses on mount (no state-resetting effect needed because
  // the host re-mounts the component on every open).
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.focus()
  }, [])
  const inputElRef = useRef<HTMLInputElement | null>(null)

  // Debounce.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query])

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = normalize(debounced)
  const jobMatches = useMemo(() => filterJobs(jobs, q), [jobs, q])
  const presalesMatches = useMemo(() => filterPresales(presales, q), [presales, q])
  const isActive = q.length > 0
  const allMatches: Match[] = [...jobMatches, ...presalesMatches]
  const totalCount = allMatches.length
  const isDebouncing = query !== debounced

  const clear = useCallback(() => {
    setQuery('')
    setDebounced('')
    inputElRef.current?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-search-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={SHEET_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

        <div className="flex items-start justify-between">
          <h2 id="hub-search-title" className="text-[19px] font-bold text-slate-900">
            Suchen
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={(node) => {
              inputElRef.current = node
              inputRef(node)
            }}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jobs, Aufmaße, Kunde, Ort"
            className="h-11 w-full rounded-xl border border-slate-200 bg-white/80 pl-9 pr-9 text-[14px] text-slate-900 outline-none transition focus:border-slate-900/40 focus:bg-white"
            aria-label="Suchfeld"
          />
          {query && (
            <button
              type="button"
              onClick={clear}
              aria-label="Eingabe leeren"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {isActive && !isDebouncing && (
          <p className="mt-3 px-0.5 text-[12px] text-slate-500" aria-live="polite">
            {totalCount === 0
              ? `Keine Treffer für „${debounced}“`
              : `${totalCount} Treffer für „${debounced}“`}
          </p>
        )}

        <div className="mt-3 flex-1 overflow-y-auto overscroll-contain pb-2">
          {!isActive ? (
            <IdleState />
          ) : isDebouncing ? (
            <LoadingState />
          ) : totalCount === 0 ? (
            <EmptyState query={debounced} onClear={clear} />
          ) : (
            <div className="flex flex-col gap-3">
              {jobMatches.length > 0 && (
                <ResultSection title="Jobs" count={jobMatches.length}>
                  {jobMatches.map((m) => (
                    <JobRow
                      key={m.job.jobId}
                      job={m.job}
                      onSelect={() => {
                        onSelectJob(m.job.jobId)
                      }}
                    />
                  ))}
                </ResultSection>
              )}
              {presalesMatches.length > 0 && (
                <ResultSection title="Aufmaße" count={presalesMatches.length}>
                  {presalesMatches.map((m) => (
                    <PresalesRow
                      key={m.project.id}
                      project={m.project}
                      onSelect={() => {
                        onSelectPresales(m.project.id)
                      }}
                    />
                  ))}
                </ResultSection>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ResultSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.6px] text-slate-500">{title}</h3>
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-slate-100 px-1.5 text-[11px] font-bold text-slate-600">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

function JobRow({ job, onSelect }: { job: HubSearchJob; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-left transition active:scale-[0.99] hover:bg-white"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${
          job.hasScene ? 'bg-[#E5EDFB] text-brand' : 'bg-slate-100 text-slate-500'
        }`}
      >
        <Layers className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-slate-900">{job.title}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
          <User className="mr-1 inline size-3 -translate-y-px text-slate-400" />
          {job.customerName} · {job.locationLabel}
        </div>
      </div>
      {!job.hasScene && (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          Ohne Scan
        </span>
      )}
    </button>
  )
}

function PresalesRow({
  project,
  onSelect,
}: {
  project: PresalesProject
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-left transition active:scale-[0.99] hover:bg-white"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#FEF3C7] text-[#B45309]">
        <Box className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold text-slate-900">{project.title}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
          {project.customerNameDraft ?? 'Ohne Kunden-Daten'}
          {project.locationHint ? ` · ${project.locationHint}` : ''}
        </div>
      </div>
      <span className="shrink-0 rounded-full bg-[#FEF3C7] px-2 py-0.5 text-[10px] font-semibold text-[#B45309]">
        {labelFor(project.status)}
      </span>
    </button>
  )
}

function labelFor(status: PresalesProject['status']): string {
  switch (status) {
    case 'draft':
      return 'Entwurf'
    case 'scanned':
      return 'Gescannt'
    case 'quoted':
      return 'Angebot'
    case 'converted':
      return 'Konvertiert'
    case 'archived':
      return 'Archiv'
  }
}

function IdleState() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-center">
      <Search className="mx-auto size-7 text-slate-300" />
      <p className="mt-3 text-[13px] text-slate-500">
        Suche nach Job-Titel, Kunden-Namen oder Ort.
      </p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl bg-white/60 px-3 py-2.5 ring-1 ring-slate-100">
          <div className="size-9 animate-pulse rounded-[10px] bg-slate-200" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-center">
      <Search className="size-7 text-slate-300" />
      <p className="text-[13px] text-slate-600">Keine Treffer für „{query}“</p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-full bg-slate-900 px-4 py-1.5 text-[12.5px] font-semibold text-white active:scale-95"
      >
        Suche löschen
      </button>
    </div>
  )
}
