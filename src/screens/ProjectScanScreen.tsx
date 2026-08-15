import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowLeft, Scan, ChevronDown, ChevronUp } from 'lucide-react'
import { Browser } from '@capacitor/browser'
import AppShell from '../components/AppShell'
import { getProjectById, subscribeProjects, isProjectRepositoryHydrated } from '../lib/projects'
import type { Project } from '../lib/projects'
import type { RoomScanMetadata, WallInfo, OpeningInfo } from '../lib/roomScan/types'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Gewerk metric priority ────────────────────────────────────────────────────

type MetricKey = 'WALL_NET' | 'FLOOR' | 'CEILING' | 'WALL_LENGTHS' | 'OPENINGS'

const GEWERK_METRICS: Record<string, MetricKey[]> = {
  Malerarbeiten: ['WALL_NET', 'CEILING'],
  Fliesen:       ['FLOOR', 'WALL_NET'],
  Bad:           ['FLOOR', 'WALL_NET', 'OPENINGS'],
  Sanitär:       ['FLOOR', 'OPENINGS'],
  Schreinerei:   ['WALL_LENGTHS', 'OPENINGS'],
  Elektrik:      ['FLOOR', 'CEILING'],
  Heizung:       ['FLOOR', 'CEILING'],
  Renovierung:   ['WALL_NET', 'FLOOR', 'CEILING'],
}

const DEFAULT_METRICS: MetricKey[] = ['FLOOR', 'WALL_NET', 'CEILING']

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(m: number): string {
  return m.toFixed(2).replace('.', ',') + ' m'
}

function fmtArea(m2: number): string {
  return m2.toFixed(1).replace('.', ',') + ' m²'
}

// ── Derived values ────────────────────────────────────────────────────────────

interface DerivedScanValues {
  wallAreaBrutto: number
  doorAreaTotal: number
  windowAreaTotal: number
  wallAreaNetto: number
  floorArea: number
  ceilingHeight: number
}

function deriveValues(m: RoomScanMetadata): DerivedScanValues {
  const wallAreaBrutto = m.walls.reduce((s, w) => s + w.widthM * w.heightM, 0)
  const doorAreaTotal = m.doors.reduce((s, d) => s + d.widthM * d.heightM, 0)
  const windowAreaTotal = m.windows.reduce((s, w) => s + w.widthM * w.heightM, 0)
  return {
    wallAreaBrutto,
    doorAreaTotal,
    windowAreaTotal,
    wallAreaNetto: wallAreaBrutto - doorAreaTotal - windowAreaTotal,
    floorArea: m.floorAreaM2,
    ceilingHeight: m.ceilingHeightM,
  }
}

// ── Gewerk section ────────────────────────────────────────────────────────────

function GewerkSection({
  metrics,
  derived,
  metadata,
  gewerk,
}: {
  metrics: MetricKey[]
  derived: DerivedScanValues
  metadata: RoomScanMetadata
  gewerk: string
}) {
  return (
    <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
      <div className="mb-4 flex items-center gap-2">
        <Scan size={15} className="text-brand" aria-hidden />
        <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Für dein Gewerk · {gewerk}
        </span>
      </div>

      <div className="space-y-4">
        {metrics.includes('WALL_NET') && (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[14px] text-ink-muted">Wandfläche brutto</span>
              <span className="text-[15px] font-semibold text-ink">{fmtArea(derived.wallAreaBrutto)}</span>
            </div>
            {metadata.windows.length > 0 && (
              <AbzugRow
                label={`${metadata.windows.length} Fenster`}
                area={derived.windowAreaTotal}
                items={metadata.windows}
              />
            )}
            {metadata.doors.length > 0 && (
              <AbzugRow
                label={`${metadata.doors.length} Türen`}
                area={derived.doorAreaTotal}
                items={metadata.doors}
              />
            )}
            <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
              <span className="text-[14px] font-semibold text-ink">Wandfläche netto</span>
              <span className="text-[15px] font-bold text-brand">{fmtArea(derived.wallAreaNetto)}</span>
            </div>
          </div>
        )}

        {metrics.includes('FLOOR') && (
          <MetricRow label="Bodenfläche" value={fmtArea(derived.floorArea)} />
        )}

        {metrics.includes('CEILING') && (
          <>
            <MetricRow label="Deckenfläche" value={fmtArea(derived.floorArea)} />
            <MetricRow label="Deckenhöhe" value={fmt(derived.ceilingHeight)} />
          </>
        )}

        {metrics.includes('WALL_LENGTHS') && (
          <div>
            <span className="mb-2 block text-[13px] font-semibold text-ink-muted">
              Wandlängen ({metadata.walls.length})
            </span>
            <div className="space-y-1">
              {metadata.walls.map((w, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-[13px] text-ink-muted">Wand {i + 1}</span>
                  <span className="text-[14px] font-semibold text-ink">
                    {fmt(w.widthM)} × {fmt(w.heightM)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {metrics.includes('OPENINGS') && (metadata.doors.length > 0 || metadata.windows.length > 0) && (
          <div className="space-y-3">
            {metadata.doors.length > 0 && (
              <OpeningsBlock label="Türen" items={metadata.doors} />
            )}
            {metadata.windows.length > 0 && (
              <OpeningsBlock label="Fenster" items={metadata.windows} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── All measurements section (collapsible) ───────────────────────────────────

function AllMeasurementsSection({ metadata, derived }: { metadata: RoomScanMetadata; derived: DerivedScanValues }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-container bg-surface ring-1 ring-edge shadow-elevated overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5"
      >
        <span className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Alle Maße
        </span>
        {open
          ? <ChevronUp size={16} className="text-slate-400" aria-hidden />
          : <ChevronDown size={16} className="text-slate-400" aria-hidden />
        }
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 pb-5 space-y-4">
          <MetricRow label="Bodenfläche" value={fmtArea(derived.floorArea)} />
          <MetricRow label="Deckenhöhe" value={fmt(derived.ceilingHeight)} />

          {metadata.walls.length > 0 && (
            <div>
              <span className="mb-2 block text-[13px] font-semibold text-ink-muted">
                Wände ({metadata.walls.length})
              </span>
              <div className="space-y-1">
                {metadata.walls.map((w, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-[13px] text-ink-muted">Wand {i + 1}</span>
                    <span className="text-[14px] font-semibold text-ink">
                      {fmt(w.widthM)} × {fmt(w.heightM)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {metadata.doors.length > 0 && (
            <OpeningsBlock label="Türen" items={metadata.doors} />
          )}

          {metadata.windows.length > 0 && (
            <OpeningsBlock label="Fenster" items={metadata.windows} />
          )}

          {metadata.furnitureCount > 0 && (
            <div>
              <MetricRow label="Objekte erkannt" value={String(metadata.furnitureCount)} />
              {metadata.furnitureCategories.length > 0 && (
                <p className="mt-1 text-[12px] text-slate-400">
                  {metadata.furnitureCategories.join(', ')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Small reusable pieces ─────────────────────────────────────────────────────

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[14px] text-ink-muted">{label}</span>
      <span className="text-[15px] font-semibold text-ink">{value}</span>
    </div>
  )
}

function AbzugRow({ label, area, items }: { label: string; area: number; items: OpeningInfo[] }) {
  const avg = items.length > 0 ? area / items.length : 0
  return (
    <div className="mt-1 flex items-center justify-between pl-3">
      <span className="text-[13px] text-slate-400">
        {label}
        {items.length > 1 ? ` (à ${fmtArea(avg)})` : ` (${fmt(items[0].widthM)} × ${fmt(items[0].heightM)})`}
      </span>
      <span className="text-[13px] text-slate-400">− {fmtArea(area)}</span>
    </div>
  )
}

function OpeningsBlock({ label, items }: { label: string; items: WallInfo[] | OpeningInfo[] }) {
  return (
    <div>
      <span className="mb-1 block text-[13px] font-semibold text-ink-muted">
        {label} ({items.length})
      </span>
      <div className="space-y-1">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-[13px] text-ink-muted">{label.replace(/n$/, '')} {i + 1}</span>
            <span className="text-[14px] font-semibold text-ink">
              {fmt(item.widthM)} × {fmt(item.heightM)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ProjectScanScreen() {
  const { projectId } = useParams<{ projectId: string }>()
  const goBack = useSmartBack('/projects')

  const [project, setProject] = useState<Project | null>(() =>
    projectId ? (getProjectById(projectId) ?? null) : null
  )
  const [hydrated, setHydrated] = useState(() => isProjectRepositoryHydrated())

  useEffect(() => {
    if (!projectId) return
    return subscribeProjects(() => {
      setProject(getProjectById(projectId) ?? null)
      setHydrated(isProjectRepositoryHydrated())
    })
  }, [projectId])

  // ── Loading ──────────────────────────────────────────────────────────────
  if (!hydrated && !project) {
    return (
      <AppShell active="messages">
        <div className="flex h-48 items-center justify-center">
          <p className="text-[13px] text-slate-400">Wird geladen…</p>
        </div>
      </AppShell>
    )
  }

  // ── No scan ──────────────────────────────────────────────────────────────
  if (!project?.roomScanUrl || !project.roomScanMetadata) {
    return (
      <AppShell active="messages">
        <section className="px-4 py-6">
          <BackButton onBack={goBack} />
          <div className="mt-6 flex flex-col items-center gap-3 py-12 text-center">
            <Scan size={32} className="text-slate-300" aria-hidden />
            <p className="text-[14px] text-slate-500">Kein Raumscan vorhanden</p>
          </div>
        </section>
      </AppShell>
    )
  }

  const metadata = project.roomScanMetadata
  const scanUrl = project.roomScanUrl
  const gewerk = project.category ?? ''
  const metrics = GEWERK_METRICS[gewerk] ?? DEFAULT_METRICS
  const derived = deriveValues(metadata)

  async function openAR() {
    await Browser.open({ url: scanUrl })
  }

  return (
    <AppShell active="messages">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          {/* Header */}
          <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
            <div className="flex items-start justify-between gap-3">
              <div>
                <BackButton onBack={goBack} inline />
                <div className="mt-1 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Raumscan
                </div>
                <div className="mt-0.5 text-[17px] font-semibold text-ink">
                  {project.title || `${gewerk}-Projekt`}
                </div>
              </div>
              <button
                type="button"
                onClick={openAR}
                className="shrink-0 flex items-center gap-1.5 rounded-card bg-brand px-4 py-2.5 text-[13px] font-semibold text-white shadow-elevated transition active:scale-[0.98]"
              >
                <Scan size={14} aria-hidden />
                In AR öffnen
              </button>
            </div>
          </div>

          {/* Gewerk-prioritised metrics */}
          <GewerkSection
            metrics={metrics}
            derived={derived}
            metadata={metadata}
            gewerk={gewerk || 'Allgemein'}
          />

          {/* All raw measurements — collapsible */}
          <AllMeasurementsSection metadata={metadata} derived={derived} />
        </div>
      </section>
    </AppShell>
  )
}

function BackButton({ onBack, inline }: { onBack: () => void; inline?: boolean }) {
  if (inline) {
    return (
      <button
        type="button"
        onClick={onBack}
        className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-slate-400 transition hover:text-slate-600"
      >
        <ArrowLeft size={13} aria-hidden />
        Zurück
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-500 transition hover:text-slate-700"
    >
      <ArrowLeft size={15} aria-hidden />
      Zurück
    </button>
  )
}
