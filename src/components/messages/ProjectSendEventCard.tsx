import { Link } from 'react-router-dom'
import type { MessageRole } from '../../lib/messages'
import type { ProjectArtifact } from '../../lib/messages/threadArtifactTypes'
import { getProjectDetailPath } from './projectDetailPath'
import { ArtifactCardShell } from '../chat/ArtifactCardShell'
import {
  type ArtifactCardView,
  tone,
  TYPE_LABEL,
  PROJECT_STATUS_LABEL,
} from '../chat/artifactCardVocab'

type Props = {
  artifact: ProjectArtifact
  timeLabel: string
  role: MessageRole
  onSetActive?: (projectId: string) => void
}

/**
 * Renders a project-send event inline in the chat timeline (V5 redesign
 * 2026-06-23: now renders through the shared `ArtifactCardShell` — identical
 * shell + vocabulary as every other stream artifact card; full-width, no
 * outgoing/incoming alignment).
 *
 * Extras preserved: the ★ Hauptprojekt badge and the customer "Als Hauptprojekt
 * setzen" action (rendered as a sibling below the tappable card, since a button
 * cannot nest inside the navigation anchor).
 *
 * Data source: canonical append-only ProjectArtifact from thread_artifacts.
 */
export default function ProjectSendEventCard({ artifact, timeLabel, role, onSetActive }: Props) {
  const title = artifact.project?.title ?? artifact.snapshot?.title ?? 'Projekt'
  const status = artifact.project?.status ?? artifact.snapshot?.status ?? 'request'
  const category = artifact.project?.category ?? artifact.snapshot?.category
  const projectId = artifact.project?.id ?? artifact.snapshot?.projectId
  const detailPath = getProjectDetailPath(artifact, role)

  const view: ArtifactCardView = {
    iconKey: 'Project',
    typeLabel: TYPE_LABEL.Project,
    prominent: title,
    prominentKind: 'title',
    subtitle: category?.trim() || undefined,
    statusLabel: PROJECT_STATUS_LABEL[status] ?? status,
    statusTone: tone(status),
  }

  const badge = artifact.isActiveProject ? (
    <span className="shrink-0 text-[10px] font-bold text-amber-600" data-testid="timeline-hauptprojekt-badge">
      ★ Hauptprojekt
    </span>
  ) : undefined

  const showSetActive =
    role === 'customer' && !artifact.isActiveProject && onSetActive && projectId

  return (
    <div className="mx-4 my-1.5" data-testid="project-send-event">
      {detailPath ? (
        <Link
          to={detailPath}
          data-testid="project-send-event-link"
          className="block cursor-pointer select-none transition hover:-translate-y-px active:translate-y-0"
        >
          <ArtifactCardShell view={view} badge={badge} testid="artifact-card-project" />
        </Link>
      ) : (
        <ArtifactCardShell view={view} badge={badge} testid="artifact-card-project" />
      )}

      {showSetActive ? (
        <button
          type="button"
          data-testid="timeline-set-active-project"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onSetActive!(projectId!)
          }}
          className="mt-1 px-1 text-[11px] font-semibold text-amber-600 transition hover:text-amber-700"
        >
          ★ Als Hauptprojekt setzen
        </button>
      ) : null}

      <div className="mt-0.5 px-1 text-[10px] text-slate-400">{timeLabel}</div>
    </div>
  )
}
