import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Zap, Wrench, Bath, Brush, LayoutGrid, Hammer, Thermometer, Layers, Triangle, Leaf,
  ArrowLeft, Search, FolderOpen, MapPin, PenLine,
  type LucideIcon,
} from 'lucide-react'
import AppShell from '../components/AppShell'
import ContentSection from '../components/primitives/ContentSection'
import { getProjects, subscribeProjects, type Project } from '../lib/projects'
import {
  deriveSearchCriteriaFromProject,
  deriveSearchCriteriaFromManualInput,
  type SearchCriteria,
  type ManualSearchInput,
} from '../lib/explore/searchCriteriaSelectors'
import {
  matchProviderCardsToSearchCriteria,
  type ProviderMatchResult,
} from '../lib/explore/craftsmanMatchingSelectors'
import type { ExploreProviderCard } from '../lib/explore/exploreTypes'
import { getExploreProviderCards } from '../lib/explore/exploreProfileService'
import {
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
  selectInvitedProviderWorkflow,
} from '../lib/workflow'
import { setDiscoveryProviderCache } from '../lib/discovery'
import { useSmartBack } from '../hooks/useSmartBack'

// ── Constants ─────────────────────────────────────────────────────────────────

type ServiceCategory = { label: string; Icon: LucideIcon }

const SERVICE_CATEGORIES: ServiceCategory[] = [
  { label: 'Elektrik',    Icon: Zap },
  { label: 'Bad',         Icon: Bath },
  { label: 'Sanitär',     Icon: Wrench },
  { label: 'Fliesen',     Icon: LayoutGrid },
  { label: 'Schreinerei', Icon: Hammer },
  { label: 'Maler',       Icon: Brush },
  { label: 'Boden',       Icon: Layers },
  { label: 'Heizung',     Icon: Thermometer },
  { label: 'Dach',        Icon: Triangle },
  { label: 'Garten',      Icon: Leaf },
]

const BUDGET_OPTIONS = [
  'unter 500 €',
  '500 – 1.500 €',
  '1.500 – 5.000 €',
  '5.000 – 15.000 €',
  'über 15.000 €',
]

const SERVICES_PREVIEW_COUNT = 3

const TIMING_OPTIONS = [
  'So schnell wie möglich',
  'Innerhalb 2 Wochen',
  'Innerhalb 4 Wochen',
  'Innerhalb 3 Monate',
  'Kein fester Zeitraum',
]

type Mode = 'project' | 'manual' | 'provider'

// ── Sub-components ────────────────────────────────────────────────────────────

function ModeTabs({
  active,
  onChange,
}: {
  active: Mode
  onChange: (mode: Mode) => void
}) {
  return (
    <div className="flex gap-2 rounded-container bg-slate-100 p-1.5">
      {(
        [
          { id: 'project', label: 'Aus Projekt' },
          { id: 'manual',  label: 'Neue Suche' },
        ] as { id: Mode; label: string }[]
      ).map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`flex-1 rounded-card py-2.5 text-[14px] font-semibold transition active:scale-[0.98] ${
            active === id
              ? 'bg-white text-slate-900 shadow-subtle'
              : 'text-slate-500'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center rounded-chip bg-blue-50 px-2.5 py-0.5 text-[12px] font-semibold text-brand ring-1 ring-blue-200/60">
      {category}
    </span>
  )
}

function CriteriaCard({ criteria }: { criteria: SearchCriteria }) {
  return (
    <div className="rounded-card bg-slate-50 p-4 ring-1 ring-edge/60">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
        Suchkriterien
      </div>
      <div className="mt-2.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-sub w-20 shrink-0">Kategorie</span>
          <CategoryBadge category={criteria.category} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-sub w-20 shrink-0">Standort</span>
          <span className="flex items-center gap-1 text-[13px] font-semibold text-ink">
            <MapPin size={12} aria-hidden />
            {criteria.location}
          </span>
        </div>
        {criteria.budget && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-ink-sub w-20 shrink-0">Budget</span>
            <span className="text-[13px] font-semibold text-ink">
              {criteria.budget}
            </span>
          </div>
        )}
        {criteria.timing && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-ink-sub w-20 shrink-0">Zeitraum</span>
            <span className="text-[13px] font-semibold text-ink">
              {criteria.timing}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function MatchReasonBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-chip bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200/50">
      {label}
    </span>
  )
}

function ResultCard({
  result,
  criteria,
  project,
  onSelectProvider,
}: {
  result: ProviderMatchResult
  criteria: SearchCriteria
  project?: Project | null
  onSelectProvider?: (provider: ExploreProviderCard) => Promise<void>
}) {
  const navigate = useNavigate()
  const { provider, matchReasons, matchScore } = result
  const [inquiryPending, setInquiryPending] = useState(false)
  const [inquiryError, setInquiryError] = useState<string | null>(null)

  async function handleInquiry() {
    if (inquiryPending) return
    setInquiryPending(true)
    setInquiryError(null)
    try {
      let threadId: string | null = null
      if (project) {
        threadId = await startProjectInquiryWorkflowFromProvider(project, provider)
      } else {
        // The provider is already known from the search result — use it directly
        // instead of performing a secondary cache lookup.
        threadId = await startCategoryInquiryWorkflowFromProvider(
          criteria.category,
          criteria.description,
          criteria.location,
          provider
        )
      }
      if (threadId) {
        navigate(`/messages/${threadId}`)
      }
    } catch {
      setInquiryError('Anfrage konnte nicht gestartet werden. Bitte versuche es erneut.')
    } finally {
      setInquiryPending(false)
    }
  }

  async function handleSelectProvider() {
    if (inquiryPending || !onSelectProvider) return
    setInquiryPending(true)
    setInquiryError(null)
    try {
      await onSelectProvider(provider)
    } catch {
      setInquiryError('Betrieb konnte nicht ausgewählt werden. Bitte versuche es erneut.')
    } finally {
      setInquiryPending(false)
    }
  }

  return (
    <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
      {/* Project context banner – shown when sending a specific project */}
      {project && (
        <div className="mb-3 flex items-start gap-2 rounded-card bg-blue-50 px-3.5 py-2.5 ring-1 ring-blue-200/60">
          <FolderOpen size={15} className="mt-0.5 shrink-0 text-brand" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand">
              Projekt wird gesendet
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-ink truncate">
              {project.title}
            </div>
            {project.description && (
              <div className="mt-0.5 text-[11px] text-ink-sub line-clamp-1">
                {project.description}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-3">
        {provider.craftsmanAvatarUrl ? (
          <img
            src={provider.craftsmanAvatarUrl}
            alt={provider.craftsmanName}
            className="h-12 w-12 rounded-full object-cover ring-2 ring-white shadow"
          />
        ) : (
          <div className="h-12 w-12 rounded-full bg-slate-100 ring-2 ring-white shadow flex items-center justify-center text-slate-400">
            <Hammer size={20} aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink truncate">
              {provider.craftsmanName}
            </span>
            {provider.verified && (
              <span className="text-[11px] text-blue-500 shrink-0" title="Verifiziert">✓</span>
            )}
            <span className="text-[12px] font-semibold text-brand shrink-0">
              {matchScore} Pkt
            </span>
          </div>
          <div className="mt-0.5 text-[13px] text-ink-sub truncate">
            {provider.craftsmanHandle} · {provider.location || 'Standort fehlt'}
          </div>
          {(provider.readinessMissingFields?.length ?? 0) > 0 && (
            <div className="mt-1 inline-flex items-center gap-1.5">
              <span className="rounded-full bg-amber-50 ring-1 ring-amber-200/60 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                Profil unvollständig
              </span>
            </div>
          )}
        </div>
        <CategoryBadge category={provider.primaryCategory} />
      </div>

      {/* Services offered summary */}
      {provider.servicesOffered.length > 0 && (
        <div className="mt-3 text-[13px] text-ink-sub leading-snug line-clamp-2">
          {provider.servicesOffered.slice(0, SERVICES_PREVIEW_COUNT).join(' · ')}
          {provider.servicesOffered.length > SERVICES_PREVIEW_COUNT && ` +${provider.servicesOffered.length - SERVICES_PREVIEW_COUNT}`}
        </div>
      )}

      {/* Match reasons */}
      {matchReasons.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {matchReasons.map((reason) => (
            <MatchReasonBadge key={reason.label} label={reason.label} />
          ))}
        </div>
      )}

      {/* Trust signals */}
      {(provider.completedJobsCount != null && provider.completedJobsCount > 0) || (provider.wouldHireAgainCount != null && provider.wouldHireAgainCount > 0) ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {provider.completedJobsCount != null && provider.completedJobsCount > 0 ? (
            <span className="inline-flex items-center rounded-chip bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-200/50">
              {provider.completedJobsCount} Projekte
            </span>
          ) : null}
          {provider.wouldHireAgainCount != null && provider.wouldHireAgainCount > 0 ? (
            <span className="inline-flex items-center rounded-chip bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200/50">
              {provider.wouldHireAgainCount}× wieder gebucht
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-4 flex gap-2.5">
        <Link
          to={`/explore/craftsman/${provider.craftsmanId}`}
          className="flex-1 rounded-card bg-slate-100 py-2.5 text-center text-[14px] font-semibold text-slate-700 ring-1 ring-edge/60 transition active:scale-[0.98]"
        >
          Profil ansehen
        </Link>
        {onSelectProvider ? (
          <button
            type="button"
            onClick={() => void handleSelectProvider()}
            disabled={inquiryPending}
            className="flex-[1.4] rounded-card bg-brand py-2.5 text-[14px] font-semibold text-white shadow-elevated transition active:scale-[0.98] disabled:opacity-60"
          >
            {inquiryPending ? 'Wird gespeichert…' : 'Betrieb auswählen →'}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleInquiry}
            disabled={inquiryPending}
            className="flex-[1.4] rounded-card bg-brand py-2.5 text-[14px] font-semibold text-white shadow-elevated transition active:scale-[0.98] disabled:opacity-60"
          >
            {inquiryPending ? 'Wird gesendet…' : project ? 'Projekt anfragen →' : 'Anfrage starten →'}
          </button>
        )}
      </div>

      {inquiryError ? (
        <p className="mt-2 text-[13px] text-red-600">{inquiryError}</p>
      ) : null}
    </div>
  )
}

function EmptyResults() {
  return (
    <div className="rounded-container bg-surface p-8 ring-1 ring-edge shadow-elevated text-center">
      <Search size={32} className="mx-auto mb-3 text-slate-400" aria-hidden />
      <div className="text-[15px] font-semibold text-ink">
        Keine Handwerker gefunden
      </div>
      <div className="mt-1.5 text-[13px] text-ink-sub leading-relaxed">
        Für diese Kriterien wurden keine passenden Handwerker gefunden.
      </div>
      <ul className="mt-3 space-y-1 text-left text-[12px] text-ink-sub">
        <li>• Versuche eine andere Kategorie</li>
        <li>• Wähle einen allgemeineren Standort</li>
        <li>• Reduziere den Budget-Filter</li>
      </ul>
    </div>
  )
}

// ── Default-Browse list (no criteria yet) ─────────────────────────────────────

function BrowseProviderCard({
  provider,
  onClick,
}: {
  provider: ExploreProviderCard
  onClick: () => void
}) {
  const incomplete = (provider.readinessMissingFields?.length ?? 0) > 0
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-container bg-surface p-3.5 text-left ring-1 ring-edge shadow-subtle transition active:scale-[0.99]"
    >
      {provider.craftsmanAvatarUrl ? (
        <img
          src={provider.craftsmanAvatarUrl}
          alt={provider.craftsmanName}
          className="h-12 w-12 shrink-0 rounded-full object-cover ring-2 ring-white shadow"
        />
      ) : (
        <div className="h-12 w-12 shrink-0 rounded-full bg-slate-100 ring-2 ring-white shadow flex items-center justify-center text-slate-400">
          <Hammer size={18} aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-bold text-slate-900">
            {provider.craftsmanName}
          </span>
          {provider.verified && (
            <span className="text-[12px] text-blue-500" title="Verifiziert">✓</span>
          )}
        </div>
        {incomplete ? (
          <div className="mt-0.5 inline-flex items-center gap-1.5">
            <span className="rounded-full bg-amber-50 ring-1 ring-amber-200/60 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              Profil unvollständig
            </span>
            {provider.readinessMissingFields?.[0] && (
              <span className="text-[11px] text-slate-400">
                {provider.readinessMissingFields[0]}
              </span>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-slate-500 mt-0.5">
            📍 {provider.location || 'Standort unbekannt'}
          </div>
        )}
        {provider.tradeCategories.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {provider.tradeCategories.slice(0, 3).map((cat) => (
              <span
                key={cat}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
              >
                {cat}
              </span>
            ))}
          </div>
        )}
      </div>
      {(provider.completedJobsCount ?? 0) > 0 && (
        <div className="shrink-0 text-right">
          <div className="text-[14px] font-bold text-slate-900 leading-none">
            {provider.completedJobsCount}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400 mt-1">
            Projekte
          </div>
        </div>
      )}
    </button>
  )
}

function BrowseSection({
  providerCards,
  activeChip,
  onSelectChip,
  onProviderClick,
  loading,
}: {
  providerCards: ExploreProviderCard[]
  activeChip: string | null
  onSelectChip: (chip: string | null) => void
  onProviderClick: (provider: ExploreProviderCard) => void
  loading: boolean
}) {
  // Build chip set from real provider trade categories.
  const allChips = useMemo(() => {
    const set = new Set<string>()
    for (const card of providerCards) {
      for (const cat of card.tradeCategories) {
        const trimmed = cat.trim()
        if (trimmed) set.add(trimmed)
      }
    }
    return Array.from(set).sort()
  }, [providerCards])

  const filtered = useMemo(() => {
    const sorted = [...providerCards].sort((a, b) => {
      const aJ = a.completedJobsCount ?? 0
      const bJ = b.completedJobsCount ?? 0
      if (bJ !== aJ) return bJ - aJ
      return a.craftsmanName.localeCompare(b.craftsmanName)
    })
    if (!activeChip) return sorted
    return sorted.filter((c) => c.tradeCategories.includes(activeChip))
  }, [providerCards, activeChip])

  if (loading && providerCards.length === 0) {
    return (
      <div className="space-y-2.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 rounded-container bg-slate-100 animate-pulse" />
        ))}
      </div>
    )
  }

  if (providerCards.length === 0) {
    return (
      <div className="rounded-container bg-slate-50 p-6 ring-1 ring-edge text-center">
        <div className="text-[14px] font-semibold text-slate-700">
          Hier erscheinen bald Handwerker
        </div>
        <div className="mt-1 text-[12px] text-slate-500">
          Erste Betriebe schließen gerade ihr Onboarding ab.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Quick-filter chips */}
      <div className="-mx-1 px-1 flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        <button
          type="button"
          onClick={() => onSelectChip(null)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
            activeChip === null
              ? 'bg-slate-900 text-white shadow-subtle'
              : 'bg-white ring-1 ring-edge text-slate-700'
          }`}
        >
          Alle · {providerCards.length}
        </button>
        {allChips.map((chip) => {
          const active = chip === activeChip
          return (
            <button
              key={chip}
              type="button"
              onClick={() => onSelectChip(active ? null : chip)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
                active
                  ? 'bg-slate-900 text-white shadow-subtle'
                  : 'bg-white ring-1 ring-edge text-slate-700'
              }`}
            >
              {chip}
            </button>
          )
        })}
      </div>

      {/* Result count */}
      <div className="px-1 text-[12px] font-semibold text-slate-500">
        {filtered.length} Handwerker
      </div>

      {/* Cards */}
      <div className="space-y-2.5">
        {filtered.map((p) => (
          <BrowseProviderCard
            key={p.craftsmanId}
            provider={p}
            onClick={() => onProviderClick(p)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="rounded-container bg-slate-50 p-5 ring-1 ring-edge text-center text-[12px] text-slate-500">
            Keine Treffer für „{activeChip}". <button
              type="button"
              onClick={() => onSelectChip(null)}
              className="ml-1 font-semibold text-blue-600"
            >Filter zurücksetzen</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Project-based mode ────────────────────────────────────────────────────────

function ProjectPicker({
  projects,
  selectedId,
  onSelect,
}: {
  projects: Project[]
  selectedId: string | null
  onSelect: (project: Project) => void
}) {
  if (projects.length === 0) {
    return (
      <div className="rounded-card bg-slate-50 p-5 ring-1 ring-edge/60 text-center">
        <FolderOpen size={28} className="mx-auto mb-2 text-slate-400" aria-hidden />
        <div className="text-[14px] font-semibold text-ink">
          Keine Projekte mit Kategorie
        </div>
        <div className="mt-1 text-[12px] text-ink-sub leading-relaxed">
          Erstelle zuerst ein Projekt über den Projektassistenten.
          Nur Projekte mit Kategorie können für die Suche verwendet werden.
        </div>
        <Link
          to="/projects/new"
          className="mt-4 inline-flex items-center gap-1.5 rounded-chip bg-brand px-4 py-2 text-[13px] font-semibold text-white shadow-elevated"
        >
          Projekt erstellen →
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {projects.map((project) => {
        const isSelected = selectedId === project.id
        return (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelect(project)}
            className={`w-full rounded-container p-4 text-left transition active:scale-[0.99] ${
              isSelected
                ? 'bg-brand text-white shadow-elevated'
                : 'bg-white ring-1 ring-edge shadow-subtle'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[14px] font-semibold leading-snug truncate ${
                    isSelected ? 'text-white' : 'text-ink'
                  }`}
                >
                  {project.title}
                </div>
                <div
                  className={`mt-0.5 flex items-center gap-1 text-[12px] truncate ${
                    isSelected ? 'text-white/75' : 'text-ink-sub'
                  }`}
                >
                  <MapPin size={11} aria-hidden />
                  {project.location}
                </div>
              </div>
              <span
                className={`shrink-0 inline-flex items-center rounded-chip px-2.5 py-0.5 text-[11px] font-semibold ${
                  isSelected
                    ? 'bg-white/20 text-white'
                    : 'bg-blue-50 text-brand ring-1 ring-blue-200/60'
                }`}
              >
                {project.category}
              </span>
            </div>
            {project.description && (
              <div
                className={`mt-2 text-[12px] line-clamp-2 leading-relaxed ${
                  isSelected ? 'text-white/80' : 'text-ink-sub'
                }`}
              >
                {project.description}
              </div>
            )}
            <div className={`mt-2 text-[11px] font-semibold ${isSelected ? 'text-white/60' : 'text-ink-muted'}`}>
              {isSelected ? 'Ausgewählt – Handwerker werden geladen' : 'Tippen zum Auswählen'}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Manual guided mode ────────────────────────────────────────────────────────

function ManualSearchForm({
  input,
  onChange,
}: {
  input: Partial<ManualSearchInput>
  onChange: (updates: Partial<ManualSearchInput>) => void
}) {
  return (
    <div className="space-y-3">
      {/* Category */}
      <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
        <label className="mb-2.5 block text-[13px] font-semibold text-ink">
          Kategorie <span className="text-red-400">*</span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {SERVICE_CATEGORIES.map((cat) => {
            const active = input.category === cat.label
            return (
              <button
                key={cat.label}
                type="button"
                onClick={() =>
                  onChange({ category: active ? '' : cat.label })
                }
                className={`flex items-center gap-2 rounded-card px-3.5 py-2.5 text-left transition active:scale-[0.97] ${
                  active
                    ? 'bg-brand text-white shadow-elevated'
                    : 'bg-slate-50 text-ink ring-1 ring-edge/70'
                }`}
              >
                <cat.Icon size={17} aria-hidden />
                <span className="text-[13px] font-semibold">{cat.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Location */}
      <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
        <label className="mb-2.5 block text-[13px] font-semibold text-ink">
          Standort <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={input.location ?? ''}
          onChange={(e) => onChange({ location: e.target.value })}
          placeholder="z. B. Hannover, Berlin-Mitte"
          className="w-full rounded-card bg-slate-50 px-4 py-3 text-[15px] text-ink ring-1 ring-edge/70 placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </div>

      {/* Description */}
      <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
        <label className="mb-2.5 block text-[13px] font-semibold text-ink">
          Was benötigst du? <span className="text-red-400">*</span>
        </label>
        <textarea
          rows={4}
          value={input.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Beschreibe kurz, was du benötigst – z. B. Sicherungskasten modernisieren, Badezimmer renovieren…"
          className="w-full resize-none rounded-card bg-slate-50 px-4 py-3 text-[15px] text-ink ring-1 ring-edge/70 placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
      </div>

      {/* Budget (optional) */}
      <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
        <label className="mb-2 block text-[13px] font-semibold text-ink">
          Budgetrahmen{' '}
          <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {BUDGET_OPTIONS.map((opt) => {
            const active = input.budget === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange({ budget: active ? undefined : opt })}
                className={`rounded-chip px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                  active
                    ? 'bg-brand text-white'
                    : 'bg-slate-100 text-ink-sub ring-1 ring-edge/60'
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>
      </div>

      {/* Timing (optional) */}
      <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
        <label className="mb-2 block text-[13px] font-semibold text-ink">
          Zeitraum{' '}
          <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {TIMING_OPTIONS.map((opt) => {
            const active = input.timing === opt
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange({ timing: active ? undefined : opt })}
                className={`rounded-chip px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                  active
                    ? 'bg-brand text-white'
                    : 'bg-slate-100 text-ink-sub ring-1 ring-edge/60'
                }`}
              >
                {opt}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Results section ───────────────────────────────────────────────────────────

function ResultsSection({
  results,
  criteria,
  project,
  onSelectProvider,
}: {
  results: ProviderMatchResult[]
  criteria: SearchCriteria
  project?: Project | null
  onSelectProvider?: (provider: ExploreProviderCard) => Promise<void>
}) {
  return (
    <ContentSection
      eyebrow={`${results.length} Treffer`}
      title="Passende Handwerker"
    >
      <div className="space-y-4">
        {results.length === 0 ? (
          <EmptyResults />
        ) : (
          results.map((result) => (
            <ResultCard
              key={result.provider.craftsmanId}
              result={result}
              criteria={criteria}
              project={project}
              onSelectProvider={onSelectProvider}
            />
          ))
        )}
      </div>
    </ContentSection>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

type SearchNavState = {
  mode?: Mode
  projectId?: string
  input?: Partial<ManualSearchInput>
}

function parseNavState(state: unknown): SearchNavState {
  if (!state || typeof state !== 'object') return {}
  const s = state as Record<string, unknown>
  return {
    mode: s.mode === 'project' || s.mode === 'manual' || s.mode === 'provider' ? s.mode : undefined,
    projectId: typeof s.projectId === 'string' ? s.projectId : undefined,
    input:
      s.input && typeof s.input === 'object'
        ? (s.input as Partial<ManualSearchInput>)
        : undefined,
  }
}

export default function CustomerSearchScreen() {
  const location = useLocation()
  const navigate = useNavigate()
  const goBack = useSmartBack('/')
  const navState = parseNavState(location.state)

  // mode='provider' is the invited guided-entry path: the customer selects
  // their craftsman before creating a project. The search UI defaults to
  // manual input so the customer can type a name / location / category.
  const [mode, setMode] = useState<Mode>(navState.mode ?? 'project')
  const [projects, setProjects] = useState<Project[]>(getProjects())
  const [providerCards, setProviderCards] = useState<ExploreProviderCard[]>([])
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerLoadEpoch, setProviderLoadEpoch] = useState(0)

  // Project mode state
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    navState.projectId ?? null
  )

  // Manual mode state
  const [manualInput, setManualInput] = useState<Partial<ManualSearchInput>>(
    navState.input ?? {}
  )

  // Browse-mode chip filter (used when manual mode has no criteria yet)
  const [browseChip, setBrowseChip] = useState<string | null>(null)

  // Subscribe to project store
  useEffect(() => {
    return subscribeProjects(() => {
      setProjects(getProjects())
    })
  }, [])

  // Load real provider cards on mount (and on retry)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProviderLoadError(null)
    setProviderLoading(true)
    getExploreProviderCards()
      .then((cards) => {
        if (cards.length > 0) {
          setProviderCards(cards)
          // Populate the cache so category inquiry workflows initiated from
          // this screen (or later from CustomerNewRequestCard, etc.) can
          // resolve a real provider without a secondary async lookup.
          setDiscoveryProviderCache(cards)
        }
        setProviderLoading(false)
      })
      .catch(() => {
        setProviderLoadError('Handwerker konnten nicht geladen werden.')
        setProviderLoading(false)
      })
  }, [providerLoadEpoch])

  // Only projects that are eligible for search: have a category, and are not
  // cancelled or completed (finished/withdrawn projects shouldn't appear in the
  // picker as search targets — a new handyman can't be found for them).
  const categorisedProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          Boolean(p.category?.trim()) &&
          p.status !== 'cancelled' &&
          p.status !== 'completed'
      ),
    [projects]
  )

  const selectedProject = useMemo(
    () =>
      selectedProjectId
        ? categorisedProjects.find((p) => p.id === selectedProjectId) ?? null
        : null,
    [selectedProjectId, categorisedProjects]
  )

  const projectCriteria = useMemo(
    () =>
      selectedProject ? deriveSearchCriteriaFromProject(selectedProject) : null,
    [selectedProject]
  )

  const manualCriteria = useMemo(
    () => deriveSearchCriteriaFromManualInput(manualInput),
    [manualInput]
  )

  const activeCriteria = mode === 'project' ? projectCriteria : manualCriteria

  const results = useMemo(
    () =>
      activeCriteria
        ? matchProviderCardsToSearchCriteria(activeCriteria, providerCards)
        : [],
    [activeCriteria, providerCards]
  )

  function handleModeChange(newMode: Mode) {
    setMode(newMode)
  }

  function handleProjectSelect(project: Project) {
    setSelectedProjectId(
      selectedProjectId === project.id ? null : project.id
    )
  }

  function handleManualChange(updates: Partial<ManualSearchInput>) {
    setManualInput((prev) => ({ ...prev, ...updates }))
  }

  // Provider-selection mode: called when the customer taps "Betrieb auswählen"
  // on a result card during the invited guided-entry flow.
  async function handleSelectInvitedProvider(provider: ExploreProviderCard): Promise<void> {
    const ok = await selectInvitedProviderWorkflow(provider.craftsmanId)
    if (ok) navigate('/')
  }

  const isProviderMode = mode === 'provider'

  return (
    <AppShell active="explore">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button
            type="button"
            onClick={goBack}
            aria-label="Zurück"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"
          >
            <ArrowLeft size={18} className="text-ink" aria-hidden />
          </button>
          {/* ── Header ────────────────────────────────────────────────────── */}
          <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
            <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              SaFix
            </div>
            <div className="mt-0.5 text-[20px] font-semibold text-ink">
              {isProviderMode ? 'Betrieb finden' : 'Handwerker suchen'}
            </div>
            <p className="mt-1.5 text-[14px] text-ink-sub leading-relaxed">
              {isProviderMode
                ? 'Suche den Betrieb, der dich eingeladen hat – per Kategorie, Standort oder Name.'
                : 'Finde passende Handwerker – aus einem bestehenden Projekt oder mit einer neuen gezielten Suche.'}
            </p>
            {!isProviderMode && (
              <div className="mt-4">
                <ModeTabs active={mode} onChange={handleModeChange} />
              </div>
            )}
          </div>

          {providerLoadError && (
            <div className="rounded-card bg-rose-50 px-4 py-3 ring-1 ring-rose-200">
              <div className="text-[13px] text-rose-700">{providerLoadError}</div>
              <button
                type="button"
                onClick={() => setProviderLoadEpoch((n) => n + 1)}
                disabled={providerLoading}
                className="mt-2 text-[13px] font-semibold text-rose-700 underline underline-offset-2 disabled:opacity-50"
              >
                {providerLoading ? 'Wird geladen…' : 'Erneut versuchen'}
              </button>
            </div>
          )}

          {/* ── Project-based mode ────────────────────────────────────────── */}
          {mode === 'project' && (
            <>
              <ContentSection eyebrow="Schritt 1" title="Projekt auswählen">
                <ProjectPicker
                  projects={categorisedProjects}
                  selectedId={selectedProjectId}
                  onSelect={handleProjectSelect}
                />
              </ContentSection>

              {projectCriteria && (
                <ContentSection eyebrow="Suchbasis" title="Kriterien erkannt">
                  <CriteriaCard criteria={projectCriteria} />
                </ContentSection>
              )}
            </>
          )}

          {/* ── Manual guided mode + provider-selection mode ──────────────── */}
          {(mode === 'manual' || isProviderMode) && (
            <>
              {!isProviderMode && (
                <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-ink-muted mb-1">
                    Schritt 1–3
                  </div>
                  <div className="text-[16px] font-semibold text-ink">
                    Geführte Suche
                  </div>
                  <p className="mt-1 text-[13px] text-ink-sub">
                    Fülle die Felder aus – Ergebnisse erscheinen sobald Kategorie,
                    Standort und Beschreibung angegeben sind.
                  </p>
                </div>
              )}

              <ManualSearchForm input={manualInput} onChange={handleManualChange} />

              {manualCriteria && (
                <ContentSection eyebrow="Suchbasis" title="Aktive Kriterien">
                  <CriteriaCard criteria={manualCriteria} />
                </ContentSection>
              )}
            </>
          )}

          {/* ── Results ───────────────────────────────────────────────────── */}
          {activeCriteria ? (
            <ResultsSection
              results={results}
              criteria={activeCriteria}
              project={mode === 'project' ? selectedProject : null}
              onSelectProvider={isProviderMode ? handleSelectInvitedProvider : undefined}
            />
          ) : mode === 'manual' && !isProviderMode ? (
            // Default-Browse: zeigt komplette sichtbare Provider-Liste, sortiert
            // nach Trust (completedJobs desc). Customer kann ohne Pflichtfelder
            // browsen und per Quick-Chip nach Gewerk filtern.
            <ContentSection eyebrow="Entdecken" title="Alle Handwerker">
              <BrowseSection
                providerCards={providerCards}
                activeChip={browseChip}
                onSelectChip={setBrowseChip}
                onProviderClick={(p) => navigate(`/explore/craftsman/${p.craftsmanId}`)}
                loading={providerLoading}
              />
            </ContentSection>
          ) : (
            <div className="rounded-container bg-slate-50 p-6 ring-1 ring-edge/60 text-center">
              <div className="mb-2 text-slate-400 flex justify-center">
                {mode === 'project'
                  ? <FolderOpen size={28} aria-hidden />
                  : <PenLine size={28} aria-hidden />
                }
              </div>
              <div className="text-[14px] font-semibold text-ink">
                {mode === 'project'
                  ? 'Wähle ein Projekt aus'
                  : 'Fülle die Pflichtfelder aus'}
              </div>
              <div className="mt-1 text-[12px] text-ink-sub">
                {mode === 'project'
                  ? 'Tippe auf ein Projekt, um passende Handwerker zu finden.'
                  : 'Kategorie, Standort und Beschreibung sind erforderlich.'}
              </div>
            </div>
          )}
        </div>
      </section>
    </AppShell>
  )
}
