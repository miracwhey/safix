/**
 * Spatial · CAD Lane V1.5.1 · SpatialShareSheet
 *
 * 4-target share-action sheet for a Customer Self-Scan (Mockup 06 v9).
 * V1.5.1 ships only the first target as a functional flow; the other three
 * are visible but disabled with a "Bald"-marker so the Customer understands
 * what's coming without being able to trigger half-finished plumbing.
 *
 * Targets:
 *   1. **An Anfrage hängen** (active) — picker over the Customer's own
 *      jobs; selection fires {@link linkScanToJob} and pops a toast.
 *   2. **Als Projekt anlegen** (V1.6 follow-up).
 *   3. **Direkt an Handwerker schicken** (V1.5.1 Phase B — needs the
 *      `shared_with_provider` migration that Plan §6 keeps in Phase 0).
 *   4. **Privat behalten** — closes the sheet with no write.
 *
 * The sheet is composed inside a dark-glass `BottomSheet` (same wrapper +
 * style override the {@link CustomerNewRoomSheet} uses) so the two
 * customer-flow sheets feel like one design family.
 */

import { useEffect, useMemo, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { useToast } from '../../../hooks/useToast'
import { getJobs, subscribeJobs, isJobRepositoryHydrated } from '../../../lib/jobs/service'
import { linkScanToJob } from '../../../lib/spatial/workflow/linkScanToJob'
import { shareScanWithProvider } from '../../../lib/spatial/workflow/shareScanWithProvider'
import {
  listSavedProvidersWithDetails,
  type SavedProviderDetail,
} from '../../../lib/savedProviders/savedProviderService'
import type { Job } from '../../../lib/jobs/types'
import type { Scan } from '../../../lib/spatial/types'

const SHAREABLE_JOB_STATUSES: readonly Job['status'][] = [
  'new',
  'booked',
  'scheduled',
  'in_progress',
] as const

export interface SpatialShareSheetProps {
  open: boolean
  onClose: () => void
  scan: Scan
  customerUserId: string
  /** Fired after a successful link so the caller can refetch. */
  onLinked?: (jobId: string) => void
}

type ViewState = 'targets' | 'picker' | 'hw-picker'

export default function SpatialShareSheet({
  open,
  onClose,
  scan,
  customerUserId,
  onLinked,
}: SpatialShareSheetProps) {
  const toast = useToast()
  const [view, setView] = useState<ViewState>('targets')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setView('targets')
      setSubmitting(false)
    })
    return () => {
      alive = false
    }
  }, [open])

  // Subscribe to the jobs store while the sheet is open so the picker reflects
  // any concurrent changes (e.g. a new request the Customer just filed).
  const [jobsTick, setJobsTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const unsub = subscribeJobs(() => setJobsTick(n => n + 1))
    return () => unsub()
  }, [open])

  const candidateJobs = useMemo<Job[]>(() => {
    // jobsTick re-runs the memo when the store fires; kept as a dependency
    // even though we don't read it, so the linter sees the wiring.
    void jobsTick
    if (!isJobRepositoryHydrated()) return []
    return getJobs().filter(
      j =>
        j.customerUserId === customerUserId &&
        SHAREABLE_JOB_STATUSES.includes(j.status),
    )
  }, [customerUserId, jobsTick])

  const handleLink = async (jobId: string) => {
    if (submitting) return
    setSubmitting(true)
    const result = await linkScanToJob(scan.id, jobId)
    setSubmitting(false)
    if (result.ok) {
      toast.success(
        result.alreadyLinked ? 'Schon mit dieser Anfrage verknüpft.' : 'An Anfrage gehängt ✓',
      )
      onLinked?.(jobId)
      onClose()
      return
    }
    toast.error(result.message || 'Anhängen fehlgeschlagen.')
  }

  // HW-picker data: saved providers (with name + avatar). Loaded lazily when
  // the user opens the hw-picker view so the targets view stays fast.
  const [savedProviders, setSavedProviders] = useState<SavedProviderDetail[]>([])
  const [savedHydrated, setSavedHydrated] = useState(false)
  useEffect(() => {
    if (view !== 'hw-picker' || savedHydrated) return
    let alive = true
    void listSavedProvidersWithDetails()
      .then(entries => {
        if (!alive) return
        setSavedProviders(entries)
        setSavedHydrated(true)
      })
      .catch(() => {
        if (!alive) return
        setSavedHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [view, savedHydrated])

  const handleShareWithProvider = async (providerBusinessId: string) => {
    if (submitting) return
    setSubmitting(true)
    const result = await shareScanWithProvider(scan.id, providerBusinessId)
    setSubmitting(false)
    if (result.ok) {
      toast.success(
        result.alreadyShared ? 'Schon mit diesem Handwerker geteilt.' : 'Direkt geteilt ✓',
      )
      onLinked?.(providerBusinessId)
      onClose()
      return
    }
    toast.error(result.message || 'Direkt-Teilen fehlgeschlagen.')
  }

  return (
    <BottomSheet
      open={open}
      onClose={submitting ? () => undefined : onClose}
      maxWidth={460}
      className="!bg-slate-900/95 !text-white border border-white/10 backdrop-blur-2xl"
    >
      {view === 'targets' && (
        <TargetsView
          alreadyLinkedJobId={scan.jobId}
          alreadySharedProviderId={scan.sharedWithProviderId}
          onPickAnfrage={() => setView('picker')}
          onPickHW={() => setView('hw-picker')}
          onPickPrivate={() => {
            toast.info('Das Aufmaß bleibt privat.')
            onClose()
          }}
          onClose={onClose}
        />
      )}
      {view === 'picker' && (
        <PickerView
          jobs={candidateJobs}
          alreadyLinkedJobId={scan.jobId}
          submitting={submitting}
          onPick={jobId => void handleLink(jobId)}
          onBack={() => setView('targets')}
        />
      )}
      {view === 'hw-picker' && (
        <HWPickerView
          providers={savedProviders}
          hydrated={savedHydrated}
          submitting={submitting}
          alreadySharedProviderId={scan.sharedWithProviderId}
          onPick={pid => void handleShareWithProvider(pid)}
          onBack={() => setView('targets')}
        />
      )}
    </BottomSheet>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Targets view
// ────────────────────────────────────────────────────────────────────────────

function TargetsView({
  alreadyLinkedJobId,
  alreadySharedProviderId,
  onPickAnfrage,
  onPickHW,
  onPickPrivate,
  onClose,
}: {
  alreadyLinkedJobId: string | null
  alreadySharedProviderId: string | null
  onPickAnfrage: () => void
  onPickHW: () => void
  onPickPrivate: () => void
  onClose: () => void
}) {
  return (
    <>
      <SheetHeader title="Aufmaß teilen" subtitle="4 Optionen — wähle, wer es sehen darf" onClose={onClose} />

      <div className="mt-3 flex flex-col gap-2">
        <TargetRow
          icon={
            <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-sky-300" fill="none" strokeWidth="1.8" strokeLinecap="round">
              <path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.6 8.6 0 01-5-1.6L3 20l1.6-4A8.4 8.4 0 1121 11.5z" />
            </svg>
          }
          title="An Anfrage hängen"
          description={
            alreadyLinkedJobId
              ? 'Schon mit einer Anfrage verknüpft — andere wählen?'
              : 'Bestehende Anfrage auswählen — Handwerker sieht das Aufmaß nach Annahme.'
          }
          onClick={onPickAnfrage}
        />
        <TargetRow
          icon={
            <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-slate-300" fill="none" strokeWidth="1.8" strokeLinecap="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18M9 4v16" />
            </svg>
          }
          title="Als Projekt anlegen"
          description="Eigenes Projekt mit diesem Aufmaß starten."
          badge="Bald"
          disabled
        />
        <TargetRow
          icon={
            <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-amber-300" fill="none" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="9" cy="8" r="3.5" />
              <path d="M3 21c1.2-3.4 3.4-5 6-5M14 21h7M14 17h7M14 13h7" />
            </svg>
          }
          title="Direkt an Handwerker"
          description={
            alreadySharedProviderId
              ? 'Schon mit einem Handwerker direkt geteilt — andere wählen oder zurücknehmen?'
              : 'Konkretem Handwerker freigeben — er sieht es sofort, ohne Anfrage.'
          }
          onClick={onPickHW}
        />
        <TargetRow
          icon={
            <svg viewBox="0 0 24 24" className="h-5 w-5 stroke-emerald-300" fill="none" strokeWidth="1.8" strokeLinecap="round">
              <rect x="4" y="11" width="16" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 018 0v4" />
            </svg>
          }
          title="Privat behalten"
          description="Niemand außer dir sieht es."
          onClick={onPickPrivate}
        />
      </div>
    </>
  )
}

function TargetRow({
  icon,
  title,
  description,
  badge,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  badge?: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={
        'flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition ' +
        (disabled
          ? 'border-white/5 bg-white/[0.03] opacity-70'
          : 'border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 active:scale-[0.99]')
      }
    >
      <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{title}</span>
          {badge && (
            <span className="rounded-full bg-slate-700/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-300">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-white/60">{description}</p>
      </div>
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Anfrage-Picker view
// ────────────────────────────────────────────────────────────────────────────

function PickerView({
  jobs,
  alreadyLinkedJobId,
  submitting,
  onPick,
  onBack,
}: {
  jobs: Job[]
  alreadyLinkedJobId: string | null
  submitting: boolean
  onPick: (jobId: string) => void
  onBack: () => void
}) {
  return (
    <>
      <SheetHeader title="Anfrage wählen" subtitle={`${jobs.length} aktive Anfragen`} onBack={onBack} />

      {jobs.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-white/15 bg-white/5 p-5 text-center text-sm text-white/70">
          Du hast keine aktiven Anfragen. Lege erst eine Anfrage an, dann kannst du das Aufmaß anhängen.
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {jobs.map(job => {
            const isLinked = alreadyLinkedJobId === job.id
            return (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => onPick(job.id)}
                  disabled={submitting}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left transition hover:border-white/20 hover:bg-white/10 disabled:opacity-50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{job.title}</div>
                    <div className="mt-0.5 text-xs text-white/55">
                      {jobStatusLabel(job.status)}
                    </div>
                  </div>
                  {isLinked ? (
                    <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
                      verknüpft
                    </span>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-white/40" fill="none" strokeWidth="2.2" strokeLinecap="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// HW-Picker view (direct share)
// ────────────────────────────────────────────────────────────────────────────

function HWPickerView({
  providers,
  hydrated,
  submitting,
  alreadySharedProviderId,
  onPick,
  onBack,
}: {
  providers: SavedProviderDetail[]
  hydrated: boolean
  submitting: boolean
  alreadySharedProviderId: string | null
  onPick: (providerBusinessId: string) => void
  onBack: () => void
}) {
  if (!hydrated) {
    return (
      <>
        <SheetHeader title="Handwerker wählen" subtitle="Lade gespeicherte Handwerker…" onBack={onBack} />
        <div className="mt-4 grid h-24 place-items-center text-sm text-white/55">…</div>
      </>
    )
  }
  return (
    <>
      <SheetHeader
        title="Handwerker wählen"
        subtitle={`${providers.length} gespeicherte Handwerker`}
        onBack={onBack}
      />

      {providers.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-white/15 bg-white/5 p-5 text-center text-sm text-white/70">
          Du hast noch keine Handwerker gespeichert. Speichere zuerst einen Handwerker (Reels / Profil), dann kannst du das Aufmaß direkt teilen.
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {providers.map(p => {
            // We compare by providerBusinessId here; the workflow resolves
            // it to providers.profile_id before writing. The scan stores
            // the auth.users.id, so we can't direct-match here — the
            // "verknüpft" badge is only shown when the user re-opens the
            // sheet after a successful share completes (alreadySharedProviderId
            // matches the resolved profile_id, not the business id).
            void alreadySharedProviderId
            return (
              <li key={p.providerId}>
                <button
                  type="button"
                  onClick={() => onPick(p.providerId)}
                  disabled={submitting}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left transition hover:border-white/20 hover:bg-white/10 disabled:opacity-50"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 text-xs font-bold text-white">
                    {p.avatarUrl ? (
                      <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      initialsOf(p.name)
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{p.name}</div>
                    <div className="mt-0.5 truncate text-xs text-white/55">
                      {[p.tradeCategories[0], p.city].filter(Boolean).join(' · ') || 'Handwerker'}
                    </div>
                  </div>
                  <svg viewBox="0 0 24 24" className="h-4 w-4 stroke-white/40" fill="none" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '·'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function jobStatusLabel(status: Job['status']): string {
  switch (status) {
    case 'new':
      return 'Anfrage offen'
    case 'booked':
      return 'Beauftragt'
    case 'scheduled':
      return 'Geplant'
    case 'in_progress':
      return 'In Arbeit'
    case 'waiting_payment':
      return 'Wartet auf Zahlung'
    case 'completed':
      return 'Abgeschlossen'
    case 'cancelled':
      return 'Storniert'
    default:
      return status
  }
}

function SheetHeader({
  title,
  subtitle,
  onBack,
  onClose,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  onClose?: () => void
}) {
  return (
    <div className="flex items-start gap-3">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="grid h-9 w-9 place-items-center rounded-xl bg-white/8 text-white/80 transition hover:bg-white/15"
          aria-label="Zurück"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      )}
      <div className="flex-1">
        <h3 className="text-base font-bold text-white">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-white/60">{subtitle}</p>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-lg bg-white/8 text-white/70 transition hover:bg-white/15"
          aria-label="Schließen"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  )
}
