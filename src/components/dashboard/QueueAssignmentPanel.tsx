import { useState } from 'react'
import type { TeamMember } from '../../lib/jobs/types'

type Props = {
  jobId: string
  teamMembers: TeamMember[]
  onAssign: (jobId: string, memberId: string) => void
  onTakeMyself: (jobId: string) => void
  onClose: () => void
}

/**
 * Inline action panel for direct worker assignment from the queue.
 *
 * Lists "Ich übernehme selbst" as the first option, followed by team members.
 * Each row is a single tap — no secondary duplicate actions.
 */
export default function QueueAssignmentPanel({
  jobId,
  teamMembers,
  onAssign,
  onTakeMyself,
  onClose,
}: Props) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAssign = async (memberId: string) => {
    setSaving(true)
    setError(null)
    try {
      onAssign(jobId, memberId)
    } catch {
      setError('Zuweisung fehlgeschlagen')
      setSaving(false)
      return
    }
    setSaving(false)
    onClose()
  }

  const handleTakeMyself = async () => {
    setSaving(true)
    setError(null)
    try {
      onTakeMyself(jobId)
    } catch {
      setError('Übernahme fehlgeschlagen')
      setSaving(false)
      return
    }
    setSaving(false)
    onClose()
  }

  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200/70" data-testid="assignment-panel">
      {error && (
        <p className="mb-2 text-[11px] font-semibold text-red-600">{error}</p>
      )}

      <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
        Zuteilen an
      </p>

      <div className="space-y-1">
        {/* Self-assign — always first */}
        <button
          type="button"
          disabled={saving}
          onClick={handleTakeMyself}
          className="flex w-full items-center justify-between rounded-md bg-white px-2.5 py-1.5 text-left ring-1 ring-slate-200 transition hover:bg-slate-50 active:scale-[0.99] disabled:opacity-50"
        >
          <span className="text-[12px] font-bold text-slate-900">Ich übernehme selbst</span>
          <span className="text-[11px] text-slate-400">→</span>
        </button>

        {/* Team members */}
        {teamMembers.map((member) => (
          <button
            key={member.id}
            type="button"
            disabled={saving}
            onClick={() => handleAssign(member.id)}
            className="flex w-full items-center justify-between rounded-md bg-white px-2.5 py-1.5 text-left ring-1 ring-slate-200/70 transition hover:bg-slate-100 active:scale-[0.99] disabled:opacity-50"
          >
            <div>
              <span className="text-[12px] font-semibold text-slate-900">{member.name}</span>
              {member.role && (
                <span className="ml-1.5 text-[11px] text-slate-400">{member.role}</span>
              )}
            </div>
            <span className="text-[11px] text-slate-400">Zuweisen →</span>
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-slate-400 hover:text-slate-600 active:opacity-70 transition"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}
