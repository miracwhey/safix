import { useRef, useEffect } from 'react'

type DayStripProps = {
  selectedDateKey: string
  todayDateKey: string
  onSelectDay: (dateKey: string) => void
}

const SHORT_WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

function buildDayRange(centerDateKey: string): { dateKey: string; dayNum: number; weekday: string; date: Date }[] {
  const center = parseDateKey(centerDateKey)
  const days: { dateKey: string; dayNum: number; weekday: string; date: Date }[] = []
  for (let offset = -14; offset <= 14; offset++) {
    const d = new Date(center)
    d.setDate(d.getDate() + offset)
    days.push({
      dateKey: formatDK(d),
      dayNum: d.getDate(),
      weekday: SHORT_WEEKDAYS[d.getDay()],
      date: d,
    })
  }
  return days
}

function parseDateKey(dk: string): Date {
  const [y, m, d] = dk.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDK(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export default function DayStrip({ selectedDateKey, todayDateKey, onSelectDay }: DayStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const days = buildDayRange(selectedDateKey)

  useEffect(() => {
    if (selectedRef.current && scrollRef.current) {
      selectedRef.current.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }
  }, [selectedDateKey])

  return (
    <div
      ref={scrollRef}
      data-testid="day-strip"
      className="flex gap-1 overflow-x-auto py-1 px-1 scrollbar-hide"
      style={{ scrollbarWidth: 'none' }}
    >
      {days.map((day) => {
        const isSelected = day.dateKey === selectedDateKey
        const isToday = day.dateKey === todayDateKey

        return (
          <button
            key={day.dateKey}
            ref={isSelected ? selectedRef : undefined}
            type="button"
            data-testid={`day-cell-${day.dateKey}`}
            onClick={() => onSelectDay(day.dateKey)}
            aria-label={day.date.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}
            aria-current={isSelected ? 'date' : undefined}
            className={[
              'flex flex-col items-center justify-center rounded-xl px-2.5 py-1.5 min-w-[44px] transition-colors',
              isSelected
                ? 'bg-slate-900 text-white'
                : isToday
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-white text-slate-600 hover:bg-slate-50',
            ].join(' ')}
          >
            <span className="text-[10px] font-medium leading-tight">{day.weekday}</span>
            <span className={[
              'text-[15px] font-semibold leading-tight mt-0.5',
              isSelected ? 'text-white' : isToday ? 'text-blue-700' : 'text-slate-800',
            ].join(' ')}>
              {day.dayNum}
            </span>
          </button>
        )
      })}
    </div>
  )
}
