import { createPortal } from 'react-dom'
import type { Project } from '../../lib/projects'

type Props = {
  projects: Project[]
  onSelect: (projectId: string) => void
  onClose: () => void
}

const STATUS_LABELS: Record<string, string> = {
  request: 'Anfrage',
  accepted: 'Angenommen',
  scheduled: 'Geplant',
  in_progress: 'In Arbeit',
  review: 'Prüfung',
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
}

export default function ProjectPickerSheet({ projects, onSelect, onClose }: Props) {
  // Bottom-sheet overlay (Block 1): portals to document.body so it escapes the
  // chat input bar's fixed z-40 stacking context. Backdrop + z-[60] place it
  // above SyncStatusBar and BottomNav; the panel owns its own scroll + safe-area
  // so a long project list never grows off-screen.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="relative mx-auto flex max-h-[80dvh] w-full max-w-[480px] flex-col overflow-y-auto rounded-t-3xl bg-white px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 shadow-[0_-12px_32px_-16px_rgba(2,6,23,0.18)]">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900">Projekt anhängen</div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[13px] text-slate-600"
          >
            ✕
          </button>
        </div>

        {projects.length === 0 ? (
          <p className="text-[13px] text-slate-500">Keine Projekte vorhanden.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelect(project.id)}
                className="flex items-start gap-3 rounded-[16px] bg-slate-50 px-3 py-3 text-left ring-1 ring-slate-200/70 transition active:scale-[0.99]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-slate-900">
                      {project.title}
                    </span>
                    <span className="shrink-0 rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                      {STATUS_LABELS[project.status] ?? project.status}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-500">
                    {project.category && (
                      <span className="font-medium text-blue-700">{project.category}</span>
                    )}
                    {project.location && (
                      <span>{project.location}</span>
                    )}
                    {(project.price || project.requestedBudget) && (
                      <span>{project.price || project.requestedBudget}</span>
                    )}
                    {project.dateLabel && project.dateLabel !== 'Termin offen' && (
                      <span>{project.dateLabel}</span>
                    )}
                  </div>
                  {project.description && (
                    <div className="mt-1 line-clamp-1 text-[11px] text-slate-400">
                      {project.description}
                    </div>
                  )}
                </div>
                <div className="mt-0.5 text-[13px] text-slate-400">&rarr;</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
