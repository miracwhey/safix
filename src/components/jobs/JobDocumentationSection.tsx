import type { OwnerNote } from '../../lib/owner/types'
import CraftsmanDetailActionCard from '../CraftsmanDetailActionCard'

type Props = {
  documentationStatus: string
  photoCount: number
  ownerNotes: OwnerNote[]
  noteInput: string
  onNoteInputChange: (value: string) => void
  onAddNote: () => void
}

export default function JobDocumentationSection({
  documentationStatus,
  photoCount,
  ownerNotes,
  noteInput,
  onNoteInputChange,
  onAddNote,
}: Props) {
  return (
    <CraftsmanDetailActionCard
      title="Notizen & Status"
      subtitle="Arbeitsnotizen und Dokumentationsstatus"
    >
      <div className="rounded-2xl bg-slate-50 px-4 py-4 ring-1 ring-slate-200/70">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-slate-200/70">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Status
            </div>
            <div className="mt-0.5 text-[13px] font-medium text-slate-900">
              {documentationStatus}
            </div>
          </div>

          <div className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-slate-200/70">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Fotos
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-slate-900">
              {photoCount}
            </div>
          </div>

          <div className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-slate-200/70">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              Notizen
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-slate-900">
              {ownerNotes.length}
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <textarea
            value={noteInput}
            onChange={(e) => onNoteInputChange(e.target.value)}
            placeholder="Kurze Arbeitsnotiz hinzufügen..."
            className="min-h-[80px] flex-1 rounded-2xl bg-white px-3 py-2.5 text-[13px] text-slate-900 outline-none ring-1 ring-slate-200/70 placeholder:text-slate-400"
          />
          <button
            type="button"
            onClick={onAddNote}
            disabled={noteInput.trim().length === 0}
            className="self-end rounded-2xl bg-white px-3 py-2.5 text-[13px] font-semibold text-slate-900 ring-1 ring-slate-200/70 transition active:scale-[0.97] disabled:opacity-40"
          >
            Speichern
          </button>
        </div>

        <div className="mt-3 space-y-1.5">
          {ownerNotes.length === 0 ? (
            <div className="rounded-2xl bg-white px-3 py-2.5 text-[13px] text-slate-500 ring-1 ring-slate-200/70">
              Noch keine Notizen vorhanden
            </div>
          ) : (
            ownerNotes.map((note) => (
              <div
                key={note.id}
                className="rounded-2xl bg-white px-3 py-2.5 ring-1 ring-slate-200/70"
              >
                <div className="text-[13px] text-slate-800">{note.body}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </CraftsmanDetailActionCard>
  )
}
