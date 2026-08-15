/**
 * CraftsmanPresalesProjectsScreen — Provider · Pre-Sales · Aufmaße (V1.5 · Phase B-P3)
 *
 * Route: `/craftsman/spatial/presales` — reachable from the Spatial Hub's
 * "Meine Aufmaße" section + the FirstLoginEmpty "Alle ansehen" link.
 *
 * Lists all non-archived `provider_presales_projects` rows for the signed-in
 * owner. Each card surfaces the conversion-CTA (status ∈ {scanned, quoted}),
 * the archive-CTA (non-terminal), and the jump-to-job link (status=converted).
 *
 * The conversion modal is mounted once and toggled by `convertTarget`.
 */

import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Box,
  Calendar,
  CheckCircle2,
  Plus,
  ArrowUpRight,
  Archive,
  AlertTriangle,
  Camera,
} from 'lucide-react'

import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { PresalesJobConversionModal } from '../components/spatial/PresalesJobConversionModal'
import { PresalesProjectThumbnail } from '../components/spatial/PresalesProjectThumbnail'
import { useHaptics } from '../hooks/useHaptics'
import { useSession } from '../hooks/useSession'
import { useToast } from '../hooks/useToast'
import { useStartPresalesRoomScan } from '../hooks/useStartPresalesRoomScan'
import { useSmartBack } from '../hooks/useSmartBack'
import { useProviderPresalesProjects } from '../lib/presales/workflow/useProviderPresalesProjects'
import { getPresalesProjectRepository } from '../lib/presales/repository/registry'
import { logError } from '../lib/observability'
import type { PresalesProject, PresalesProjectStatus } from '../domain/presales/presalesProjectTypes'

export default function CraftsmanPresalesProjectsScreen() {
  const { user } = useSession()
  return <CraftsmanPresalesProjectsScreenInner key={user?.id ?? 'anon'} />
}

function CraftsmanPresalesProjectsScreenInner() {
  const navigate = useNavigate()
  const haptics = useHaptics()
  const toast = useToast()
  const { loading, error, projects, refresh } = useProviderPresalesProjects()
  const { startPresalesScan, busy: scanBusy, lidarAvailable } = useStartPresalesRoomScan()
  const goBack = useSmartBack('/craftsman/spatial')

  const [convertTarget, setConvertTarget] = useState<PresalesProject | null>(null)
  const [archivingId, setArchivingId] = useState<string | null>(null)

  const sorted = useMemo(
    () =>
      [...projects].sort((a, b) => {
        // Active first (draft → scanned → quoted), converted last among visible.
        const rank = (s: PresalesProjectStatus): number =>
          s === 'converted' ? 2 : s === 'archived' ? 3 : 0
        const ra = rank(a.status)
        const rb = rank(b.status)
        if (ra !== rb) return ra - rb
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      }),
    [projects],
  )

  const triggerScan = useCallback(() => {
    haptics.selection()
    void startPresalesScan({
      onSuccess: () => {
        void refresh()
      },
    })
  }, [haptics, startPresalesScan, refresh])

  const retryScanForDraft = useCallback(
    (project: PresalesProject) => {
      haptics.selection()
      void startPresalesScan({
        existingProjectId: project.id,
        onSuccess: () => {
          void refresh()
        },
      })
    },
    [haptics, startPresalesScan, refresh],
  )

  const openConvert = useCallback(
    (project: PresalesProject) => {
      haptics.selection()
      setConvertTarget(project)
    },
    [haptics],
  )

  const closeConvert = useCallback(() => setConvertTarget(null), [])

  const onConvertSuccess = useCallback(
    (jobId: string, alreadyExisted: boolean) => {
      setConvertTarget(null)
      void refresh()
      if (alreadyExisted) {
        toast.info('Auftrag existierte bereits — öffne ihn.')
      } else {
        toast.success('Projekt angelegt.')
      }
      navigate(`/craftsman/jobs/${jobId}/spatial?tab=3d`)
    },
    [navigate, refresh, toast],
  )

  const archive = useCallback(
    async (project: PresalesProject) => {
      if (archivingId) return
      const confirmed = window.confirm(
        `Aufmaß „${project.title}" archivieren? Es bleibt sichtbar im Archiv, aber wird hier ausgeblendet.`,
      )
      if (!confirmed) return
      setArchivingId(project.id)
      try {
        await getPresalesProjectRepository().update(project.id, { status: 'archived' })
        haptics.success()
        toast.success('Projekt archiviert.')
        await refresh()
      } catch (err) {
        logError('presales.archive_failed', err, { projectId: project.id })
        haptics.error()
        toast.error('Archivieren fehlgeschlagen.')
      } finally {
        setArchivingId(null)
      }
    },
    [archivingId, haptics, toast, refresh],
  )

  const header = (
    <div className="border-b border-edge bg-canvas px-5 pb-3.5 pt-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label="Zurück zum Hub"
            onClick={goBack}
            className="-ml-1 flex h-9 w-9 items-center justify-center rounded-[11px] text-ink-sub hover:bg-slate-100"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-ink">Aufmaße</h1>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              {loading
                ? 'Lade Aufmaße …'
                : `${projects.length} ${projects.length === 1 ? 'Projekt' : 'Projekte'}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={triggerScan}
          disabled={scanBusy || lidarAvailable === false}
          aria-label="Neues Aufmaß aufnehmen"
          className="flex h-10 items-center gap-1.5 rounded-[12px] bg-brand px-3 text-[12.5px] font-bold text-white shadow-brand-glow disabled:opacity-50"
        >
          <Plus size={15} />
          {scanBusy ? 'Starte …' : 'Aufmaß'}
        </button>
      </div>
      {lidarAvailable === false && (
        <p className="mt-2 text-[11.5px] text-amber-700">
          Dein Gerät hat kein LiDAR — Aufmaß benötigt iPad Pro / iPhone Pro.
        </p>
      )}
    </div>
  )

  if (loading) {
    return (
      <AppShell active="verwaltung">
        {header}
        <ScreenSkeleton variant="list" />
      </AppShell>
    )
  }

  return (
    <AppShell active="verwaltung">
      {header}

      {error && (
        <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-card border border-[#FECACA] bg-[#FEE2E2] px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-[12px] leading-snug text-danger">{error}</p>
        </div>
      )}

      {!error && sorted.length === 0 ? (
        <EmptyState onStart={triggerScan} disabled={scanBusy || lidarAvailable === false} />
      ) : (
        <div className="flex flex-col gap-2.5 px-5 pb-6 pt-4">
          {sorted.map((project) => (
            <PresalesCard
              key={project.id}
              project={project}
              scanBusy={scanBusy}
              onOpenDetail={() => {
                haptics.selection()
                navigate(`/craftsman/spatial/presales/${project.id}`)
              }}
              onConvert={() => openConvert(project)}
              onRetryScan={() => retryScanForDraft(project)}
              onOpenJob={() =>
                project.convertedToJobId &&
                navigate(`/craftsman/jobs/${project.convertedToJobId}/spatial?tab=3d`)
              }
              onArchive={() => archive(project)}
              archiving={archivingId === project.id}
            />
          ))}
        </div>
      )}

      {convertTarget && (
        <PresalesJobConversionModal
          project={convertTarget}
          onClose={closeConvert}
          onSuccess={onConvertSuccess}
        />
      )}
    </AppShell>
  )
}

// ── sub-components ───────────────────────────────────────────────────────────

function EmptyState({ onStart, disabled }: { onStart: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center px-5 pt-12 text-center">
      <div className="mb-5 flex h-[124px] w-[124px] items-center justify-center rounded-[32px] border border-[#D4E0F7] bg-gradient-to-br from-[#EEF2FB] to-[#E0E9FB]">
        <Box size={56} className="text-brand" strokeWidth={1.6} />
      </div>
      <h2 className="text-[20px] font-bold tracking-tight text-ink">Noch keine Aufmaße</h2>
      <p className="mt-2 max-w-[280px] text-[13px] text-ink-sub">
        Nimm einen Raum direkt vor Ort auf — ohne Kundenkonto. Wenn der Kunde zusagt, legst du
        das Aufmaß als Projekt an.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        className="mt-6 inline-flex h-12 items-center gap-2 rounded-[13px] bg-brand px-5 text-[14px] font-bold text-white shadow-brand-glow disabled:opacity-50"
      >
        <Plus size={16} />
        Erstes Aufmaß aufnehmen
      </button>
    </div>
  )
}

function PresalesCard({
  project,
  scanBusy,
  onOpenDetail,
  onConvert,
  onRetryScan,
  onOpenJob,
  onArchive,
  archiving,
}: {
  project: PresalesProject
  scanBusy: boolean
  /** L2-E F-07: Tap auf den Card-Body navigiert zum Detail-Screen. Inline-
   *  Buttons (Convert/Archive/Retry/OpenJob) müssen `stopPropagation`. */
  onOpenDetail: () => void
  onConvert: () => void
  onRetryScan: () => void
  onOpenJob: () => void
  onArchive: () => void
  archiving: boolean
}) {
  const converted = project.status === 'converted'
  const canConvert = project.status === 'scanned' || project.status === 'quoted'
  const isDraft = project.status === 'draft'

  // L2-E F-07: ein einzelner Click-Handler an der äußeren Card.
  // `stopPropagation` auf inneren Buttons verhindert Doppel-Trigger.
  const handleCardClick = useCallback(() => {
    onOpenDetail()
  }, [onOpenDetail])

  const handleCardKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onOpenDetail()
      }
    },
    [onOpenDetail],
  )

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Aufmaß ${project.title} öffnen`}
      onClick={handleCardClick}
      onKeyDown={handleCardKey}
      className="cursor-pointer rounded-card border border-edge bg-surface p-3 shadow-subtle outline-none transition focus-visible:ring-2 focus-visible:ring-brand"
      style={converted ? { borderLeft: '3px solid #047857' } : undefined}
    >
      <div className="flex items-start gap-3">
        <PresalesProjectThumbnail
          presalesProjectId={project.id}
          alt={project.title}
          className="h-12 w-12 shrink-0 overflow-hidden rounded-[10px] bg-[#EEF2FB]"
          fallback={
            <span className="flex h-full w-full items-center justify-center text-brand">
              <Box size={22} />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[14.5px] font-bold text-ink">{project.title}</h3>
            <StatusBadge status={project.status} />
          </div>
          {project.customerNameDraft && (
            <p className="mt-0.5 truncate text-[12px] text-ink-sub">{project.customerNameDraft}</p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
            <Calendar size={12} />
            <span>{formatDate(project.createdAt)}</span>
            {project.locationHint && (
              <>
                <span className="h-[2px] w-[2px] rounded-full bg-ink-muted" />
                <span className="truncate">{project.locationHint}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* B-P5: 'draft' = scan never completed. Surface a recovery hint so the
          user doesn't have to guess what to do next. */}
      {isDraft && (
        <p className="mt-2.5 rounded-[8px] bg-[#FEF3C7] px-2.5 py-1.5 text-[11px] font-medium text-[#92400E]">
          Aufmaß noch nicht aufgenommen — der vorherige Scan-Versuch wurde abgebrochen.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isDraft && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRetryScan()
            }}
            disabled={scanBusy}
            className="flex items-center gap-1.5 rounded-[10px] bg-brand px-3 py-2 text-[12.5px] font-bold text-white shadow-brand-glow active:scale-[0.98] disabled:opacity-50"
          >
            <Camera size={14} />
            {scanBusy ? 'Starte …' : 'Scan jetzt starten'}
          </button>
        )}
        {canConvert && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onConvert()
            }}
            className="flex items-center gap-1.5 rounded-[10px] bg-brand px-3 py-2 text-[12.5px] font-bold text-white shadow-brand-glow active:scale-[0.98]"
          >
            <CheckCircle2 size={14} />
            Als Projekt anlegen
          </button>
        )}
        {converted && project.convertedToJobId && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenJob()
            }}
            className="flex items-center gap-1.5 rounded-[10px] bg-[#D1FAE5] px-3 py-2 text-[12.5px] font-bold text-[#047857] active:scale-[0.98]"
          >
            <ArrowUpRight size={14} />
            Zum Auftrag
          </button>
        )}
        {!converted && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onArchive()
            }}
            disabled={archiving}
            className="ml-auto flex items-center gap-1.5 rounded-[10px] border border-edge bg-canvas px-3 py-2 text-[12px] font-semibold text-ink-sub active:scale-[0.98] disabled:opacity-50"
          >
            <Archive size={13} />
            {archiving ? 'Archiviere …' : 'Archivieren'}
          </button>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: PresalesProjectStatus }) {
  const meta: Record<PresalesProjectStatus, { label: string; bg: string; fg: string }> = {
    draft: { label: 'Entwurf', bg: '#ECEFF4', fg: '#475569' },
    scanned: { label: 'Gescannt', bg: '#E5EDFB', fg: '#2563EB' },
    quoted: { label: 'Angebot', bg: '#FEF3C7', fg: '#B45309' },
    converted: { label: 'Als Projekt angelegt', bg: '#D1FAE5', fg: '#047857' },
    archived: { label: 'Archiv', bg: '#ECEFF4', fg: '#94A3B8' },
  }
  const m = meta[status]
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: m.bg, color: m.fg }}
    >
      {m.label}
    </span>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}
