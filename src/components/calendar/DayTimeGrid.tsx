import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CalendarEntry } from '../../lib/calendar/calendarTypes'
import { getCalendarStatusLabel } from '../../lib/calendar/calendarSelectors'
import { getTeamMembers } from '../../lib/jobs'

// ── Constants ────────────────────────────────────────────────────────────────

const HOUR_HEIGHT = 60 // px per hour row
const START_HOUR = 6
const END_HOUR = 22
const TOTAL_HOURS = END_HOUR - START_HOUR

// ── Time helpers ─────────────────────────────────────────────────────────────

function parseTime(label: string): number | null {
  if (!label || label === 'Jetzt' || label === 'Offen') return null
  const match = label.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  return parseInt(match[1], 10) + parseInt(match[2], 10) / 60
}

function getCurrentHourFraction(): number {
  const now = new Date()
  return now.getHours() + now.getMinutes() / 60
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ── Component ────────────────────────────────────────────────────────────────

type DayTimeGridProps = {
  entries: CalendarEntry[]
  isToday: boolean
}

export default function DayTimeGrid({ entries, isToday }: DayTimeGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [nowFraction, setNowFraction] = useState(getCurrentHourFraction)

  // Update current-time line every 60 seconds
  useEffect(() => {
    if (!isToday) return
    const interval = setInterval(() => setNowFraction(getCurrentHourFraction()), 60_000)
    return () => clearInterval(interval)
  }, [isToday])

  // Scroll to ~8 AM on mount (typical work start)
  useEffect(() => {
    if (gridRef.current) {
      const scrollTarget = (8 - START_HOUR) * HOUR_HEIGHT
      gridRef.current.scrollTop = scrollTarget
    }
  }, [])

  const teamMembers = getTeamMembers()
  const memberNameMap = new Map(teamMembers.map((m) => [m.id, m.name]))

  const hours: number[] = []
  for (let h = START_HOUR; h < END_HOUR; h++) hours.push(h)

  // Build positioned event blocks
  const blocks = entries
    .map((entry) => {
      const startHour = parseTime(entry.startsAtLabel)
      if (startHour === null) return null // skip entries without real start time

      const endHour = parseTime(entry.endsAtLabel)
      const duration = endHour !== null ? endHour - startHour : 1 // default 1h if no end
      const top = (clamp(startHour, START_HOUR, END_HOUR) - START_HOUR) * HOUR_HEIGHT
      const height = Math.max(clamp(duration, 0.25, TOTAL_HOURS) * HOUR_HEIGHT, 30)

      return { entry, top, height, startHour, endHour, duration }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)

  // Entries without real start time — render at the top as "time open" notices
  const untimed = entries.filter((entry) => parseTime(entry.startsAtLabel) === null)

  const nowLineTop = isToday
    ? (clamp(nowFraction, START_HOUR, END_HOUR) - START_HOUR) * HOUR_HEIGHT
    : null

  return (
    <div data-testid="day-time-grid" className="flex flex-col">
      {/* Untimed entries banner (status = in_progress with "Jetzt" etc.) */}
      {untimed.length > 0 && (
        <div className="border-b border-slate-100 px-3 py-2 space-y-1.5">
          {untimed.map((entry) => {
            const inner = (
              <>
                <span className="font-semibold text-amber-800 truncate">{entry.title}</span>
                <span className="shrink-0 text-amber-600">Uhrzeit offen</span>
              </>
            )
            return entry.jobId ? (
              <Link
                key={entry.id}
                to={`/craftsman/jobs/${entry.jobId}`}
                className="flex items-center gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] hover:bg-amber-100 transition"
              >
                {inner}
              </Link>
            ) : (
              <div key={entry.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[12px]">
                {inner}
              </div>
            )
          })}
        </div>
      )}

      {/* Scrollable time grid */}
      <div
        ref={gridRef}
        className="relative overflow-y-auto flex-1"
        style={{ minHeight: 400, maxHeight: 480 }}
      >
        <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
          {/* Hour rows */}
          {hours.map((h) => (
            <div
              key={h}
              className="absolute left-0 right-0 flex border-t border-slate-100"
              style={{ top: (h - START_HOUR) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
              data-testid={`hour-row-${h}`}
            >
              <div className="w-[52px] shrink-0 pr-2 pt-0.5 text-right">
                <span className="text-[11px] font-medium text-slate-400">
                  {String(h).padStart(2, '0')}:00
                </span>
              </div>
              <div className="flex-1" />
            </div>
          ))}

          {/* Event blocks */}
          {blocks.map(({ entry, top, height }) => {
            const assigneeNames = entry.assignedMemberIds
              .map((id) => memberNameMap.get(id))
              .filter((name): name is string => !!name)
              .join(', ')

            // Height thresholds for adaptive block rendering:
            // < 50px → compact single-line (30min events)
            // 50–90px → medium two-line (1h events)
            // ≥ 90px → full multi-line with status badge (2h+ events)
            const COMPACT_THRESHOLD = 50
            const FULL_THRESHOLD = 90
            const isCompact = height < COMPACT_THRESHOLD
            const isMedium = height >= COMPACT_THRESHOLD && height < FULL_THRESHOLD

            const isCustom = entry.kind === 'custom'
            const bgStyle = isCustom
              ? 'bg-slate-50 border border-slate-200'
              : entry.status === 'in_progress'
                ? 'bg-amber-50 border border-amber-200'
                : 'bg-blue-50 border border-blue-200'

            const blockClass = [
              'absolute left-[56px] right-2 rounded-lg overflow-hidden transition-shadow hover:shadow-md',
              bgStyle,
            ].join(' ')

            const statusBadgeStyle = isCustom
              ? 'bg-slate-100 text-slate-600'
              : entry.status === 'in_progress'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-blue-100 text-blue-700'

            const blockContent = isCompact ? (
              <div className="flex items-center gap-1.5 h-full">
                <span className="text-[10px] font-medium text-slate-500 shrink-0">
                  {entry.startsAtLabel}–{entry.endsAtLabel || '?'}
                </span>
                <span className="text-[11px] font-semibold text-slate-800 truncate">{entry.title}</span>
              </div>
            ) : isMedium ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-slate-500 shrink-0">
                    {entry.startsAtLabel}–{entry.endsAtLabel || '?'}
                  </span>
                  <span className="text-[12px] font-semibold text-slate-800 truncate">{entry.title}</span>
                </div>
                <p className="text-[10px] text-slate-500 truncate leading-tight mt-0.5">
                  {[entry.location, assigneeNames].filter(Boolean).join(' · ')}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-start justify-between gap-1">
                  <span className="text-[11px] font-medium text-slate-500">
                    {entry.startsAtLabel}–{entry.endsAtLabel || '?'}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${statusBadgeStyle}`}>
                    {isCustom ? 'Eigener Termin' : getCalendarStatusLabel(entry.status)}
                  </span>
                </div>
                <p className="text-[13px] font-semibold text-slate-800 truncate mt-0.5 leading-tight">
                  {entry.title}
                </p>
                {entry.location && (
                  <p className="text-[11px] text-slate-500 truncate leading-tight">{entry.location}</p>
                )}
                {assigneeNames && (
                  <p className="text-[11px] text-slate-400 truncate leading-tight">{assigneeNames}</p>
                )}
              </>
            )

            return entry.jobId ? (
              <Link
                key={entry.id}
                to={`/craftsman/jobs/${entry.jobId}`}
                data-testid={`event-block-${entry.id}`}
                className={blockClass}
                style={{ top, height, minHeight: 30, zIndex: 10, padding: isCompact ? '2px 8px' : '4px 10px' }}
              >
                {blockContent}
              </Link>
            ) : (
              <div
                key={entry.id}
                data-testid={`event-block-${entry.id}`}
                className={blockClass}
                style={{ top, height, minHeight: 30, zIndex: 10, padding: isCompact ? '2px 8px' : '4px 10px' }}
              >
                {blockContent}
              </div>
            )
          })}

          {/* Current-time line (today only) */}
          {nowLineTop !== null && (
            <div
              data-testid="now-line"
              className="absolute left-0 right-0 z-20 flex items-center pointer-events-none"
              style={{ top: nowLineTop }}
            >
              <div className="w-[52px] flex justify-end pr-1">
                <div className="h-2 w-2 rounded-full bg-red-500" />
              </div>
              <div className="flex-1 h-[2px] bg-red-500" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
