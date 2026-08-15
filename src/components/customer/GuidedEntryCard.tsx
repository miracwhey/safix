import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Sparkles } from 'lucide-react'
import CorridorAction from '../system/CorridorAction'
import {
  getGuidedEntryState,
  getGuidedEntryStatus,
  subscribeGuidedEntry,
  chooseInvitedPath,
  chooseSelfFoundPath,
  startProviderSearch,
  markProjectNeeded,
  markProjectCreated,
  markMatchingReady,
  completeGuidedEntry,
  clearGuidedEntryError,
  type GuidedEntryState,
  type GuidedEntryStatus,
} from '../../lib/customerEntry/guidedEntryState'
import {
  deriveGuidedEntryVisibility,
  type GuidedEntryVisibility,
} from '../../lib/customerEntry/guidedEntryVisibility'
import { getProjects, subscribeProjects, type Project } from '../../lib/projects'
import { getConversations } from '../../lib/messages'
import { getJobs, subscribeJobs } from '../../lib/jobs'

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function useGuidedEntry(): { state: GuidedEntryState; status: GuidedEntryStatus } {
  const [s, setS] = useState(getGuidedEntryState)
  const [st, setSt] = useState(getGuidedEntryStatus)
  useEffect(() => subscribeGuidedEntry(() => {
    setS(getGuidedEntryState())
    setSt(getGuidedEntryStatus())
  }), [])
  return { state: s, status: st }
}

// ---------------------------------------------------------------------------
// Shared: error banner
// ---------------------------------------------------------------------------

function SaveErrorBanner({ message }: { message: string }) {
  return (
    <div
      data-testid="guided-entry-error"
      className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700 ring-1 ring-red-200/60"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="flex-1">
        {message}{' '}
        <button
          type="button"
          onClick={() => clearGuidedEntryError()}
          className="underline underline-offset-2"
        >
          Schließen
        </button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InitialChoice() {
  const { status } = useGuidedEntry()

  const handleInvited = async () => {
    await chooseInvitedPath()
  }

  const handleSelfFound = async () => {
    await chooseSelfFoundPath()
  }

  return (
    <div data-testid="guided-entry-initial">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint px-2.5 py-1 text-[11px] font-bold text-brand">
        <Sparkles size={12} aria-hidden />
        Willkommen bei SaFix
      </span>
      <h2 className="mt-3 text-[20px] font-bold tracking-[-0.01em] text-ink">
        Womit fangen wir an?
      </h2>
      <p className="mt-1 text-[13px] text-ink-sub">
        Sag uns, ob du schon einen Betrieb hast — wir übernehmen den Rest.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-2.5">
        <button
          type="button"
          disabled={status.saving}
          onClick={() => void handleInvited()}
          className="flex items-center justify-between gap-3 rounded-[16px] bg-[linear-gradient(158deg,#2E6BF0_0%,#1D4ED8_55%,#1A3FB5_100%)] px-4 py-3.5 text-left text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22),0_12px_24px_-14px_rgba(29,78,216,0.6)] transition active:scale-[0.98] disabled:opacity-60"
        >
          <div className="min-w-0">
            <div className="text-[14.5px] font-bold">
              {status.saving ? 'Speichern…' : 'Ich habe schon einen Betrieb'}
            </div>
            <div className="mt-0.5 text-[12px] text-white/80">
              Direkt aufrufen und Anfrage senden.
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-white/15 px-2.5 py-1 text-[10.5px] font-semibold text-white ring-1 ring-inset ring-white/25">
            Mein Betrieb
          </span>
        </button>
        <button
          type="button"
          disabled={status.saving}
          onClick={() => void handleSelfFound()}
          className="flex items-center justify-between gap-3 rounded-[16px] bg-surface px-4 py-3.5 text-left ring-1 ring-edge shadow-subtle transition active:scale-[0.98] disabled:opacity-60"
        >
          <div className="min-w-0">
            <div className="text-[14.5px] font-bold text-ink">
              {status.saving ? 'Speichern…' : 'Ich suche noch einen'}
            </div>
            <div className="mt-0.5 text-[12px] text-ink-sub">
              Projekt beschreiben — wir finden passende Betriebe.
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10.5px] font-semibold text-ink-muted">
            über SaFix
          </span>
        </button>
      </div>

      {status.error && <SaveErrorBanner message={status.error} />}
    </div>
  )
}

function InvitedPathCard() {
  const navigate = useNavigate()
  const { state: entry, status } = useGuidedEntry()

  const handleSearchProvider = async () => {
    const saved = await startProviderSearch()
    if (saved) navigate('/search', { state: { mode: 'provider' } })
  }

  const handleCreateProject = async () => {
    const saved = await markProjectNeeded()
    if (saved) navigate('/projects/new')
  }

  if (entry.step === 'invited' || entry.step === 'searching_provider') {
    return (
      <div data-testid="guided-entry-invited">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Betrieb finden
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Suche gezielt den Betrieb, der dich eingeladen hat — per Name, Ort oder @Handle.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void handleSearchProvider()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Betrieb suchen →'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  if (
    entry.step === 'provider_selected' ||
    entry.step === 'project_needed'
  ) {
    return (
      <div data-testid="guided-entry-provider-selected">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Anfrage an deinen Betrieb
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Beschreibe dein Vorhaben, damit der Betrieb dir direkt ein passendes Angebot machen kann.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void handleCreateProject()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Anfrage erstellen →'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  if (entry.step === 'project_created') {
    return (
      <div data-testid="guided-entry-project-created">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Anfrage bereit
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Deine Anfrage wurde gespeichert. Du kannst sie jetzt direkt an den Betrieb senden.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void completeGuidedEntry()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Fertig — weiter zur Übersicht'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  return null
}

function SelfFoundPathCard() {
  const navigate = useNavigate()
  const { state: entry, status } = useGuidedEntry()
  const [projects, setProjects] = useState<Project[]>(getProjects())

  useEffect(() => subscribeProjects(() => setProjects(getProjects())), [])

  const handleCreateProject = async () => {
    const saved = await markProjectNeeded()
    if (saved) navigate('/projects/new')
  }

  const handleFindProviders = async () => {
    if (entry.projectId) {
      const saved = await markMatchingReady()
      if (saved) {
        navigate('/search', {
          state: { mode: 'project', projectId: entry.projectId },
        })
      }
    }
  }

  // Link newly-created project: only when the user is in project-needed
  // step and returns from the project builder. We compare against the
  // previous project count to detect genuinely new additions.
  // Uses void — errors are surfaced via the GuidedEntryStatus error banner.
  const prevProjectCount = useRef(projects.length)
  useEffect(() => {
    if (
      entry.step === 'project_needed' &&
      projects.length > prevProjectCount.current &&
      !entry.projectId
    ) {
      // A new project appeared while the user was in the project-needed step
      const latest = projects[projects.length - 1]
      void markProjectCreated(latest.id)
    }
    prevProjectCount.current = projects.length
  }, [projects, entry.step, entry.projectId])

  if (entry.step === 'self_found' || entry.step === 'project_needed') {
    return (
      <div data-testid="guided-entry-self-found">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Projekt beschreiben
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Beschreibe zuerst dein Vorhaben — was soll gemacht werden und wo?
          Danach zeigen wir dir passende Handwerker in deiner Nähe.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void handleCreateProject()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Projekt erstellen →'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  if (entry.step === 'project_created' || entry.step === 'matching_ready') {
    return (
      <div data-testid="guided-entry-matching">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Passende Handwerker entdecken
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Dein Projekt wurde gespeichert! Finde jetzt Handwerker, die zu deinem Vorhaben passen, und sende ihnen gezielt Anfragen.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void handleFindProviders()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Passende Handwerker anzeigen →'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  if (entry.step === 'request_ready') {
    return (
      <div data-testid="guided-entry-request-ready">
        <h2 className="text-[17px] font-semibold text-slate-900">
          Anfragen versandbereit
        </h2>
        <p className="mt-1 text-[13px] text-slate-500">
          Du kannst dein Projekt jetzt an bis zu 3 passende Handwerker pro Tag senden.
        </p>
        <CorridorAction
          variant="primary"
          loading={status.saving}
          onClick={() => void completeGuidedEntry()}
          className="mt-4"
        >
          {status.saving ? 'Speichern…' : 'Fertig — weiter zur Übersicht'}
        </CorridorAction>
        {status.error && <SaveErrorBanner message={status.error} />}
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// Visibility hook
// ---------------------------------------------------------------------------

function useGuidedEntryVisibility(): GuidedEntryVisibility {
  const computeVisibility = () =>
    deriveGuidedEntryVisibility(
      getGuidedEntryState(),
      getProjects(),
      getConversations(),
      getJobs(),
    )

  const [vis, setVis] = useState<GuidedEntryVisibility>(computeVisibility)

  useEffect(() => {
    const recompute = () => setVis(computeVisibility())
    const unsubs = [
      subscribeGuidedEntry(recompute),
      subscribeProjects(recompute),
      subscribeJobs(recompute),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  return vis
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function GuidedEntryCard() {
  const { state: entry } = useGuidedEntry()
  const visibility = useGuidedEntryVisibility()

  // Hide entirely when visibility says so
  if (visibility.mode === 'none') return null

  // Full guided-entry card
  return (
    <div
      data-testid="guided-entry-card"
      className="rounded-[24px] bg-gradient-to-br from-blue-50/80 to-indigo-50/60 p-5 ring-1 ring-edge/70 shadow-elevated"
    >
      {entry.step === 'initial' && <InitialChoice />}

      {entry.path === 'invited' && entry.step !== 'initial' && (
        <InvitedPathCard />
      )}

      {entry.path === 'self_found' && entry.step !== 'initial' && (
        <SelfFoundPathCard />
      )}
    </div>
  )
}
