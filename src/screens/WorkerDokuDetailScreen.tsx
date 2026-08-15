import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileText,
  MessageCircle,
  Package,
  PenLine,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import { getCalendarEntries, subscribeCalendar } from '../lib/calendar'
import {
  getEntriesForMember,
  getEntriesForUser,
} from '../lib/calendar/calendarSelectors'
import { getJobs, getTeamMembers, subscribeJobs } from '../lib/jobs'
import { subscribeTeamMembers } from '../lib/team'
import { useSession } from '../hooks/useSession'
import {
  deriveDokuDetailViewModel,
  type DokuCompletenessViewModel,
  type DokuModuleViewModel,
  type DokuModuleKey,
} from '../lib/worker/workerDokuProjection'
import type { CalendarEntry } from '../lib/calendar/calendarTypes'
import type { Job } from '../lib/jobs/types'
import type { JobPhoto, JobReport } from '../lib/worker/dokuTypes'
import { subscribeJobPhotosForJob } from '../lib/worker/jobPhotosLive'
import { subscribeJobReportsForJob } from '../lib/worker/jobReportsLive'
import PhotoCaptureCTA from '../components/worker/PhotoCaptureCTA'
import ReportSheet from '../components/worker/ReportSheet'
import { useSmartBack } from '../hooks/useSmartBack'

const IS_IN_MEMORY = import.meta.env.VITE_DATA_SOURCE !== 'supabase'

// ── Module icon ───────────────────────────────────────────────────────────────

function ModuleIcon({ mod, size = 18 }: { mod: DokuModuleKey; size?: number }) {
  const props = { size, strokeWidth: 1.5 }
  if (mod === 'fotos') return <Camera {...props} />
  if (mod === 'bericht') return <FileText {...props} />
  if (mod === 'material') return <Package {...props} />
  if (mod === 'maengel') return <AlertTriangle {...props} />
  return <PenLine {...props} />
}

// ── Module card ───────────────────────────────────────────────────────────────

function ModuleCard({
  mod,
  onTap,
}: {
  mod: DokuModuleViewModel
  /** Tap-Handler — nur gerendert wenn `mod.isActionable && onTap`. Bei Unavailable
   *  oder non-actionable Modulen ist die Card nicht klickbar. */
  onTap?: () => void
}) {
  const isComplete = mod.status === 'complete'
  const isUnavailable = mod.status === 'unavailable'
  const isClickable = mod.isActionable && !!onTap

  const containerCls = isUnavailable
    ? 'bg-slate-50/60 ring-1 ring-slate-100'
    : 'bg-white ring-1 ring-slate-200/60 shadow-[0_6px_16px_-10px_rgba(2,6,23,0.12)]'

  const iconBgCls = isComplete
    ? 'bg-emerald-50 text-emerald-600'
    : isUnavailable
    ? 'bg-slate-50 text-slate-300'
    : 'bg-slate-100 text-slate-400'

  const labelCls = isUnavailable
    ? 'text-[14px] font-semibold text-slate-400'
    : isComplete
    ? 'text-[14px] font-semibold text-slate-700'
    : 'text-[14px] font-semibold text-slate-900'

  const summaryCls = isUnavailable
    ? 'text-[12px] text-slate-300'
    : isComplete
    ? 'text-[12px] text-emerald-600'
    : 'text-[12px] text-slate-400'

  const innerContent = (
    <>
      <div
        className={`h-10 w-10 shrink-0 rounded-[14px] flex items-center justify-center ${iconBgCls}`}
      >
        <ModuleIcon mod={mod.key} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={labelCls}>{mod.label}</div>
        <div className={`mt-0.5 ${summaryCls}`}>{mod.summary}</div>
      </div>
      {/* Block C.3 — ChevronRight nur wenn actionable + Handler existiert.
          Vermeidet das Phantom-Drilldown-Anti-Pattern aus dem Mockup-Befund. */}
      {isClickable && (
        <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-slate-300" />
      )}
      {isComplete && !isClickable && (
        <CheckCircle2 size={16} strokeWidth={2} className="shrink-0 text-emerald-500" />
      )}
    </>
  )

  if (isClickable) {
    return (
      <button
        type="button"
        onClick={onTap}
        data-testid={`worker-doku-module-${mod.key}`}
        className={`rounded-[22px] px-4 py-4 flex items-center gap-4 w-full text-left active:scale-[0.99] transition-transform ${containerCls}`}
      >
        {innerContent}
      </button>
    )
  }

  return (
    <div className={`rounded-[22px] px-4 py-4 flex items-center gap-4 ${containerCls}`}>
      {innerContent}
    </div>
  )
}

// ── Completeness block ────────────────────────────────────────────────────────

function CompletenessBlock({ c }: { c: DokuCompletenessViewModel }) {
  if (!c.hasJobData) {
    return (
      <div className="rounded-[28px] bg-slate-50 p-5 ring-1 ring-slate-100">
        <div className="mb-3 text-[14px] font-semibold text-slate-700">Vollständigkeit</div>
        <div className="h-2 w-full rounded-full bg-slate-200" />
        <p className="mt-3 text-[12px] text-slate-400">
          Auftragsdaten konnten nicht zugeordnet werden. Nachweise nicht prüfbar.
        </p>
      </div>
    )
  }

  if (c.isComplete) {
    return (
      <div className="rounded-[28px] bg-emerald-50 p-5 ring-1 ring-emerald-200/60">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 size={20} strokeWidth={2} className="text-emerald-600 shrink-0" />
            <span className="text-[15px] font-bold text-emerald-800">Vollständig</span>
          </div>
          <span className="text-[12px] font-semibold text-emerald-600">
            {c.doneCount} / {c.totalCount}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-emerald-200">
          <div className="h-full w-full rounded-full bg-emerald-500" />
        </div>
        <p className="mt-3 text-[12px] text-emerald-700">
          Alle prüfbaren Nachweise vorhanden.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/60 shadow-[0_14px_32px_-20px_rgba(2,6,23,0.16)]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="text-[14px] font-semibold text-slate-800">Vollständigkeit</span>
        <span className="text-[12px] font-medium text-slate-500">
          {c.doneCount} von {c.totalCount}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-blue-400 transition-all"
          style={{ width: `${c.progressPct}%` }}
        />
      </div>
      {c.missingLabels.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {c.missingLabels.map((label) => (
            <div key={label} className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
              <span className="text-[12px] text-slate-500">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Connection module ─────────────────────────────────────────────────────────

function ConnectionModule({
  label,
  sublabel,
  icon,
  onClick,
}: {
  label: string
  sublabel: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-[22px] bg-white p-4 ring-1 ring-slate-200/60 shadow-[0_10px_24px_-16px_rgba(2,6,23,0.14)] text-left active:scale-[0.99] transition-transform"
    >
      <div className="mb-3 text-slate-400">{icon}</div>
      <div className="text-[14px] font-semibold text-slate-800">{label}</div>
      <div className="mt-0.5 text-[12px] text-slate-400">{sublabel}</div>
    </button>
  )
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export default function WorkerDokuDetailScreen() {
  const { caseId } = useParams<{ caseId: string }>()
  const navigate = useNavigate()
  const session = useSession()
  const { user } = session

  const [allEntries, setAllEntries] = useState<CalendarEntry[]>(getCalendarEntries)
  const [teamMembers, setTeamMembers] = useState(getTeamMembers)
  const [jobs, setJobs] = useState<Job[]>(getJobs)

  useEffect(() => {
    const unsubCalendar = subscribeCalendar(() => setAllEntries(getCalendarEntries()))
    const unsubTeam = subscribeTeamMembers(() => setTeamMembers(getTeamMembers()))
    const unsubJobs = subscribeJobs(() => setJobs(getJobs()))
    return () => {
      unsubCalendar()
      unsubTeam()
      unsubJobs()
    }
  }, [])

  const userEntries = useMemo(() => {
    if (!user) return []
    const linked = getEntriesForUser(allEntries, teamMembers, user.id)
    if (linked.length === 0 && IS_IN_MEMORY) {
      return getEntriesForMember(allEntries, 'tm-1')
    }
    return linked
  }, [allEntries, teamMembers, user])

  const entry = useMemo(
    () => userEntries.find((e) => e.id === caseId) ?? null,
    [userEntries, caseId]
  )

  const job = useMemo(
    () => (entry?.jobId ? jobs.find((j) => j.id === entry.jobId) ?? null : null),
    [entry, jobs],
  )

  // Block C.3/FU-B · canonical photos + reports per Realtime-Subscribe.
  // jobPhotosLive / jobReportsLive: subscribe-first, fetch-second pattern
  // (Race-Loss-Schutz). Bei Job-Wechsel wird der vorherige Channel
  // geschlossen via Cleanup-Return.
  const [photos, setPhotos] = useState<JobPhoto[]>([])
  const [reports, setReports] = useState<JobReport[]>([])
  const jobId = job?.id ?? null
  useEffect(() => {
    if (!jobId) {
      // Reset asynchron, damit eslint react-hooks/set-state-in-effect
      // nicht meckert. Microtask reicht — Render-Frame ist eh schon
      // committed bevor das Reset durchläuft.
      void Promise.resolve().then(() => {
        setPhotos([])
        setReports([])
      })
      return
    }
    const unsubPhotos = subscribeJobPhotosForJob(jobId, setPhotos)
    const unsubReports = subscribeJobReportsForJob(jobId, setReports)
    return () => {
      unsubPhotos()
      unsubReports()
    }
  }, [jobId])

  const vm = useMemo(
    () => (entry ? deriveDokuDetailViewModel(entry, jobs, photos, reports) : null),
    [entry, jobs, photos, reports]
  )

  // Block FU-A · Edit-Window-Detection. Erst-User-Bericht innerhalb 24 h
  // freigeben für Tippfehler / Ergänzungen. RLS deckt das server-seitig
  // ab (job_reports_worker_update_own); hier nur die UI-Sichtbarkeit.
  // `Date.now()` darf nicht im Render-Body laufen (eslint react-hooks/purity)
  // — wir capturen den Mount-Zeitpunkt einmalig per useEffect; ein Tick alle
  // 60 s aktualisiert den Cutoff, sodass die 24 h-Boundary auch dann sauber
  // flippt, wenn der User den Screen länger offen hat.
  const [nowTick, setNowTick] = useState<number>(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(handle)
  }, [])
  const editableReport = useMemo<JobReport | null>(() => {
    if (!user) return null
    const cutoff = nowTick - 24 * 60 * 60 * 1000
    return (
      reports.find(
        (r) => r.authoredBy === user.id && r.createdAt > cutoff,
      ) ?? null
    )
  }, [reports, user, nowTick])

  const [reportSheetOpen, setReportSheetOpen] = useState(false)

  const goBack = useSmartBack('/worker/doku')
  const goToEinsatz = useCallback(
    () => navigate(`/worker/einsaetze/${caseId}`),
    [navigate, caseId]
  )
  const goToNachrichten = useCallback(() => navigate('/worker/nachrichten'), [navigate])

  // ── Not found ─────────────────────────────────────────────────────────────
  if (!entry || !vm) {
    return (
      <AppShell active="worker-doku" noSafeTop>
        <div className="px-4 pt-[max(56px,env(safe-area-inset-top))]">
          <div className="mx-auto w-full max-w-[420px]">
            <button
              onClick={goBack}
              className="mb-6 flex items-center gap-1.5 text-[13px] font-medium text-slate-500 active:opacity-70"
            >
              <ArrowLeft size={15} strokeWidth={2} />
              Doku
            </button>
            <div className="rounded-[22px] bg-slate-50 px-5 py-8 ring-1 ring-slate-100 text-center">
              <p className="text-[14px] text-slate-500">Dokumentationsfall nicht gefunden.</p>
            </div>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell active="worker-doku" noSafeTop>
      <div className="px-4 pt-[max(56px,env(safe-area-inset-top))] pb-10">
        <div className="mx-auto w-full max-w-[420px] space-y-4">

          {/* Back */}
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 text-[13px] font-medium text-slate-500 active:opacity-70"
          >
            <ArrowLeft size={15} strokeWidth={2} />
            Doku
          </button>

          {/* 1. Identity header */}
          <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_20px_44px_-28px_rgba(2,6,23,0.28)]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-1">
              {vm.dateLabel} · {vm.location}
            </div>
            <h1 className="text-[20px] font-bold tracking-tight text-slate-900 leading-snug">
              {vm.assignmentTitle}
            </h1>
            <div className="mt-0.5 text-[14px] text-slate-600">{vm.customerName}</div>

            <div className="mt-3 pt-3 border-t border-slate-100">
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${
                  vm.caseStatus === 'abgeschlossen'
                    ? 'bg-emerald-50 text-emerald-700'
                    : vm.entryStatus === 'in_progress'
                    ? 'bg-blue-50 text-blue-600'
                    : 'bg-amber-50 text-amber-700'
                }`}
              >
                {vm.caseStatus === 'abgeschlossen'
                  ? 'Abgeschlossen'
                  : vm.entryStatus === 'in_progress'
                  ? 'Läuft gerade'
                  : 'Dokumentation offen'}
              </span>
            </div>
          </div>

          {/* 2. Completeness block */}
          <CompletenessBlock c={vm.completeness} />

          {/* 3. Module cards + capture CTAs */}
          <div>
            <div className="mb-3 px-1 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-slate-600">Module</h2>
              <span className="text-[11px] text-slate-400">
                {vm.completeness.doneCount}/{vm.completeness.totalCount} vollständig
              </span>
            </div>
            <div className="space-y-2.5">
              {vm.modules
                .filter((mod) => mod.status !== 'unavailable')
                .map((mod) => {
                  // Bericht: actionable wenn create-mode (count=0) ODER
                  // editable-eigener-Bericht <24h. Override hier statt
                  // in der Projection, weil 24h-Window screen-state-
                  // abhängig ist (user.id × created_at).
                  if (mod.key === 'bericht') {
                    const isClickable = mod.isActionable || !!editableReport
                    return (
                      <ModuleCard
                        key={mod.key}
                        mod={isClickable ? { ...mod, isActionable: true } : mod}
                        onTap={isClickable ? () => setReportSheetOpen(true) : undefined}
                      />
                    )
                  }
                  return <ModuleCard key={mod.key} mod={mod} />
                })}
            </div>

            {/* Block C.3 — Capture-CTAs unter den Modulen.
                PhotoCaptureCTA: jederzeit aktiv (Worker kann mehr Fotos
                  adden, auch wenn Modul `complete`).
                ReportSheet: getriggert durch ModuleCard-Tap auf 'bericht'. */}
            {job && vm.hasJobLink && (
              <div className="mt-4 space-y-3">
                <PhotoCaptureCTA
                  job={job}
                  session={session}
                  onUploaded={(photo) => setPhotos((prev) => [photo, ...prev])}
                />
              </div>
            )}
          </div>

          {/* 4. Completion status */}
          <div className="rounded-[22px] bg-slate-50 px-5 py-4 ring-1 ring-slate-100">
            {vm.completeness.isComplete ? (
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span className="text-[14px] font-semibold text-emerald-700">
                  Dokumentation vollständig
                </span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[13px] font-semibold text-slate-700">Noch offen</p>
                {vm.completeness.missingLabels.map((label) => (
                  <p key={label} className="text-[12px] text-slate-500">· {label}</p>
                ))}
              </div>
            )}
          </div>

          {/* 5. Connection links */}
          <div className="flex gap-3">
            <ConnectionModule
              label="Zum Einsatz"
              sublabel="Auftragsdetails"
              icon={<ClipboardList size={20} strokeWidth={1.5} />}
              onClick={goToEinsatz}
            />
            <ConnectionModule
              label="Nachrichten"
              sublabel="Betrieb & Team"
              icon={<MessageCircle size={20} strokeWidth={1.5} />}
              onClick={goToNachrichten}
            />
          </div>

        </div>
      </div>

      {/* Block C.3/FU-A — Bericht-Sheet. Edit-Mode wenn editableReport
          existiert; sonst Create-Mode. */}
      {job && (
        <ReportSheet
          open={reportSheetOpen}
          onClose={() => setReportSheetOpen(false)}
          job={job}
          session={session}
          onSubmitted={(report) => setReports((prev) => [report, ...prev])}
          {...(editableReport ? { existingReport: editableReport } : {})}
          onUpdated={(updated) =>
            setReports((prev) =>
              prev.map((r) => (r.id === updated.id ? updated : r)),
            )
          }
        />
      )}
    </AppShell>
  )
}
