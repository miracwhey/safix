import { useState } from 'react'
import { Link } from 'react-router-dom'

type Props = {
  jobId: string
  onSchedule: (jobId: string, start: number, end: number) => void | Promise<void>
  onClose: () => void
}

/**
 * Inline action panel for direct appointment scheduling from the queue.
 *
 * Provides date + time inputs and saves the appointment via the provided
 * callback. Also includes a secondary affordance to open the schedule screen
 * so the craftsman can check availability before choosing a slot.
 */
export default function QueueAppointmentPanel({
  jobId,
  onSchedule,
  onClose,
}: Props) {
  // Default to tomorrow at 09:00, 2-hour window
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const defaultDate = tomorrow.toISOString().split('T')[0]

  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('09:00')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!date || !time) {
      setError('Datum und Uhrzeit angeben')
      return
    }

    const startDate = new Date(`${date}T${time}:00`)
    const startMs = startDate.getTime()
    if (isNaN(startMs)) {
      setError('Ungültiges Datum oder Uhrzeit')
      return
    }

    const endMs = startMs + 2 * 60 * 60 * 1000 // 2-hour window

    setSaving(true)
    setError(null)
    try {
      await onSchedule(jobId, startMs, endMs)
    } catch {
      setError('Termin konnte nicht gespeichert werden')
      setSaving(false)
      return
    }
    setSaving(false)
    onClose()
  }

  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-2.5 ring-1 ring-slate-200/70" data-testid="appointment-panel">
      {error && (
        <p className="mb-2 text-[11px] font-semibold text-red-600">{error}</p>
      )}

      <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
        Termin festlegen
      </p>

      <div className="flex items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="flex-1 rounded-md bg-white px-2 py-1 text-[12px] text-slate-900 ring-1 ring-slate-200/70 focus:outline-none focus:ring-2 focus:ring-slate-400"
          data-testid="appointment-date"
        />
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="w-[90px] rounded-md bg-white px-2 py-1 text-[12px] text-slate-900 ring-1 ring-slate-200/70 focus:outline-none focus:ring-2 focus:ring-slate-400"
          data-testid="appointment-time"
        />
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition active:scale-[0.97] disabled:opacity-50"
        >
          Termin speichern
        </button>
        <Link
          to="/craftsman/operations"
          className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 transition"
        >
          Kalender ansehen →
        </Link>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 transition"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}
