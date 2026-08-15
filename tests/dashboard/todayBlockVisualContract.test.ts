/**
 * Today Block — Visual/Component Contract Tests
 *
 * Proves the final Today block component contract is a real mini day planner:
 *
 *   1. Header always renders in all 4 modes
 *   2. Body always renders in all 4 modes
 *   3. today_has_items shows structured planner rows
 *   4. Pending items do not render as planner rows
 *   5. No fake time is shown
 *   6. Missing real time renders honest placeholder, not fake clock
 *   7. today_empty_but_upcoming renders a real upcoming preview row/card
 *   8. only_pending_exists renders planner shell, not flat prose-only card
 *   9. no_relevant_work renders planner shell, not broken empty space
 *   10. Bounded body scroll behavior exists
 *   11. Title source does not leak workflow/internal naming
 *   12. Routing remains correct
 */

import fs from 'fs'
import { describe, it, expect } from 'vitest'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Factory ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Elektrik-Projekt Hannover',
    customerName: 'Mustermann GmbH',
    location: 'Hannover',
    dateLabel: 'Heute',
    dateKey: '2026-03-31',
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

const TODAY = '2026-03-31'
const TOMORROW = '2026-04-01'

function loadComponentSource(): string {
  return fs.readFileSync(
    new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
    'utf-8',
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Header always renders in all 4 modes
// ═══════════════════════════════════════════════════════════════════════════

describe('1. Header always renders in all 4 modes', () => {
  it('headline is always "Heute" in every mode', () => {
    const scenarios = [
      deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY),
      deriveTodayBlock([], TODAY),
    ]
    for (const block of scenarios) {
      expect(block.visible).toBe(true)
      expect(block.headline).toBe('Heute')
      expect(block.ctaLabel).toBe('Planung öffnen →')
      expect(block.ctaRoute).toBe('/craftsman/operations')
    }
  })

  it('component renders calendar icon container and "Heute" label', () => {
    const source = loadComponentSource()
    // Calendar icon container present (emoji replaced with Lucide Calendar icon)
    expect(source).toContain('w-7 h-7')
    expect(source).toContain('Calendar')
    // "Heute" label at 16px semibold
    expect(source).toContain('text-[16px]')
    expect(source).toContain('Heute')
    // Date context line at 13px
    expect(source).toContain('text-[13px]')
    expect(source).toContain('formattedDate')
  })

  it('component renders CTA at 15px semibold blue', () => {
    const source = loadComponentSource()
    expect(source).toContain('text-[15px]')
    expect(source).toContain('font-semibold')
    expect(source).toContain('text-blue-600')
    expect(source).toContain('summary.ctaLabel')
  })

  it('header separator divider always present', () => {
    const source = loadComponentSource()
    expect(source).toContain('border-t border-slate-100')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Body always renders in all 4 modes
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Body always renders in all 4 modes', () => {
  it('component renders planner body for all 4 modes', () => {
    const source = loadComponentSource()
    expect(source).toContain("summary.mode === 'today_has_items'")
    expect(source).toContain("summary.mode === 'today_empty_but_upcoming'")
    expect(source).toContain("summary.mode === 'only_pending_exists'")
    expect(source).toContain("summary.mode === 'no_relevant_work'")
  })

  it('planner body has inner surface with tinted background', () => {
    const source = loadComponentSource()
    expect(source).toContain('planner-body')
    expect(source).toContain('bg-brand-50/20')
    expect(source).toContain('rounded-2xl')
  })

  it('planner body has min-height and bounded max-height', () => {
    const source = loadComponentSource()
    expect(source).toContain('min-h-[80px]')
    expect(source).toContain('max-h-[228px]')
    expect(source).toContain('overflow-y-auto')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. today_has_items shows structured planner rows
// ═══════════════════════════════════════════════════════════════════════════

describe('3. today_has_items shows structured planner rows', () => {
  it('renders rows with time rail, title, customer, status chip', () => {
    const entries = [
      makeEntry({
        dateKey: TODAY,
        startsAtLabel: '09:00',
        title: 'Küche renovieren',
        customerName: 'Schmidt',
        location: 'München',
        status: 'scheduled',
      }),
      makeEntry({
        dateKey: TODAY,
        startsAtLabel: 'Jetzt',
        title: 'Dacharbeit',
        customerName: 'Meier',
        location: 'Berlin',
        status: 'in_progress',
      }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('today_has_items')
    expect(result.items).toHaveLength(2)

    // First item (in_progress with "Jetzt" sorts before HH:MM)
    expect(result.items[0].timeLabel).toBe('09:00')
    expect(result.items[0].hasRealTime).toBe(true)

    // All items have project-first title
    for (const item of result.items) {
      expect(item.title).toBeTruthy()
      expect(item.customerName).toBeTruthy()
      expect(item.location).toBeTruthy()
      expect(['Geplant', 'In Arbeit']).toContain(item.statusLabel)
    }
  })

  it('rows use rounded-xl containers with proper sizing', () => {
    const source = loadComponentSource()
    // Row container has rounded-xl and min-height
    expect(source).toContain('rounded-xl')
    expect(source).toContain('min-h-[64px]')
    // Time rail is 54px wide
    expect(source).toContain('w-[54px]')
    // Title at 15px semibold
    expect(source).toContain('text-[15px]')
    expect(source).toContain('font-semibold')
  })

  it('rows have gap between them', () => {
    const source = loadComponentSource()
    expect(source).toContain('gap-2')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Pending items do not render as planner rows
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Pending items do not render as planner rows', () => {
  it('pending entry alone → only_pending_exists, zero items', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
    expect(result.todayCount).toBe(0)
  })

  it('pending + scheduled → only scheduled appears in planner rows', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY, title: 'Pending' }),
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Scheduled' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.mode).toBe('today_has_items')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe('Scheduled')
  })

  it('pending entries never appear in upcomingItem', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TOMORROW })], TODAY)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.upcomingItem).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. No fake time is shown
// ═══════════════════════════════════════════════════════════════════════════

describe('5. No fake time is shown', () => {
  it('item without real time has empty timeLabel', () => {
    const result = deriveTodayBlock([makeEntry({ startsAtLabel: '', dateKey: TODAY })], TODAY)
    expect(result.items[0].hasRealTime).toBe(false)
    expect(result.items[0].timeLabel).toBe('')
  })

  it('real HH:MM time is preserved verbatim', () => {
    const result = deriveTodayBlock([makeEntry({ startsAtLabel: '14:30', dateKey: TODAY })], TODAY)
    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('14:30')
  })

  it('"Jetzt" is valid real-time for in_progress', () => {
    const result = deriveTodayBlock([makeEntry({ startsAtLabel: 'Jetzt', status: 'in_progress', dateKey: TODAY })], TODAY)
    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('Jetzt')
  })

  it('no "09:00" fabrication when time is missing', () => {
    const result = deriveTodayBlock([makeEntry({ startsAtLabel: '', dateKey: TODAY })], TODAY)
    expect(result.items[0].timeLabel).not.toMatch(/^\d{1,2}:\d{2}$/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Missing real time renders honest placeholder
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Missing real time renders "Uhrzeit offen"', () => {
  it('component shows "Uhrzeit offen" for items without real time', () => {
    const source = loadComponentSource()
    expect(source).toContain('Uhrzeit offen')
  })

  it('component does not fabricate placeholder times', () => {
    const source = loadComponentSource()
    // Should not contain fake time patterns
    expect(source).not.toContain("'09:00'")
    expect(source).not.toContain('"09:00"')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. today_empty_but_upcoming renders real upcoming preview row/card
// ═══════════════════════════════════════════════════════════════════════════

describe('7. today_empty_but_upcoming renders upcoming preview', () => {
  it('renders upcoming preview with title, time, customer info', () => {
    const entry = makeEntry({
      dateKey: TOMORROW,
      dateLabel: 'Morgen',
      startsAtLabel: '10:00',
      title: 'Fenster einbauen',
      customerName: 'Schmidt',
      location: 'München',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.mode).toBe('today_empty_but_upcoming')
    expect(result.subtitle).toBe('Heute nichts geplant')
    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Fenster einbauen')
    expect(result.upcomingItem!.customerName).toBe('Schmidt')
    expect(result.upcomingItem!.location).toBe('München')
    expect(result.upcomingItem!.timeLabel).toBe('10:00')
    expect(result.upcomingItem!.hasRealTime).toBe(true)
  })

  it('upcoming hint label includes "Nächster Einsatz"', () => {
    const result = deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY)
    expect(result.upcomingHint).toBe('Nächster Einsatz Morgen')
  })

  it('component renders upcoming preview as a distinct card/row', () => {
    const source = loadComponentSource()
    expect(source).toContain('summary.upcomingItem')
    expect(source).toContain('summary.upcomingHint')
    // Upcoming row is a proper Link for drill-down
    expect(source).toContain('summary.upcomingItem.jobId')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. only_pending_exists renders planner shell, not flat prose
// ═══════════════════════════════════════════════════════════════════════════

describe('8. only_pending_exists renders planner shell', () => {
  it('produces honest subtitle and secondary support line', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.subtitle).toBe('Heute nichts terminiert')
    expect(result.secondarySubtitle).toBe('Plane deinen nächsten Einsatz in der Planung.')
    expect(result.items).toHaveLength(0)
  })

  it('component renders secondary subtitle for only_pending_exists', () => {
    const source = loadComponentSource()
    expect(source).toContain('summary.secondarySubtitle')
  })

  it('block is visible with CTA even in only_pending_exists', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY)
    expect(result.visible).toBe(true)
    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toBe('Planung öffnen →')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. no_relevant_work renders planner shell, not broken empty space
// ═══════════════════════════════════════════════════════════════════════════

describe('9. no_relevant_work renders planner shell', () => {
  it('produces quiet subtitle and secondary support line', () => {
    const result = deriveTodayBlock([], TODAY)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.subtitle).toBe('Keine Einsätze geplant')
    expect(result.secondarySubtitle).toBe('Neue Termine erscheinen hier.')
    expect(result.items).toHaveLength(0)
  })

  it('block is visible and renders planner shell', () => {
    const result = deriveTodayBlock([], TODAY)
    expect(result.visible).toBe(true)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('completed/cancelled entries → no_relevant_work, still visible shell', () => {
    const entries = [
      makeEntry({ status: 'completed', dateKey: TODAY }),
      makeEntry({ status: 'cancelled', dateKey: TODAY }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Bounded body scroll behavior exists
// ═══════════════════════════════════════════════════════════════════════════

describe('10. Bounded body scroll behavior', () => {
  it('planner body has bounded max-height with overflow scroll', () => {
    const source = loadComponentSource()
    expect(source).toContain('max-h-[228px]')
    expect(source).toContain('overflow-y-auto')
  })

  it('planner body has min-height so empty states are not collapsed', () => {
    const source = loadComponentSource()
    expect(source).toContain('min-h-[80px]')
  })

  it('all today items are returned unbounded (scroll handles overflow)', () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      makeEntry({
        dateKey: TODAY,
        startsAtLabel: `${String(8 + i).padStart(2, '0')}:00`,
        title: `Job ${i + 1}`,
      }),
    )
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.items).toHaveLength(12)
    expect(result.todayCount).toBe(12)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Title source does not leak workflow/internal naming
// ═══════════════════════════════════════════════════════════════════════════

describe('11. Title source does not leak internal naming', () => {
  const forbiddenTitles = [
    'Anfrage läuft',
    'Auftrag aus Angebot',
    'Angebot versendet',
    'Warte auf Freigabe',
    'Neue Anfrage',
    'Anstehender Auftrag',
    'Angebots-Job',
  ]

  it('statusLabel uses only "Geplant" or "In Arbeit"', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, status: 'scheduled' }),
      makeEntry({ dateKey: TODAY, status: 'in_progress', startsAtLabel: 'Jetzt' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].statusLabel).toBe('Geplant')
    expect(result.items[1].statusLabel).toBe('In Arbeit')

    for (const item of result.items) {
      for (const forbidden of forbiddenTitles) {
        expect(item.statusLabel).not.toBe(forbidden)
        expect(item.title).not.toBe(forbidden)
      }
    }
  })

  it('item titles pass through from CalendarEntry (project-first)', () => {
    const entry = makeEntry({ dateKey: TODAY, title: 'Elektrik-Projekt Hannover' })
    const result = deriveTodayBlock([entry], TODAY)
    expect(result.items[0].title).toBe('Elektrik-Projekt Hannover')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Routing remains correct
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Routing remains correct', () => {
  it('CTA → /craftsman/operations in all modes', () => {
    const modes = [
      deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY),
      deriveTodayBlock([], TODAY),
    ]
    for (const block of modes) {
      expect(block.ctaRoute).toBe('/craftsman/operations')
      expect(block.ctaLabel).toBe('Planung öffnen →')
    }
  })

  it('planner rows expose jobId for /craftsman/jobs/:jobId routing', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, jobId: 'job-abc' }),
      makeEntry({ dateKey: TODAY, jobId: 'job-xyz' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.items[0].jobId).toBe('job-abc')
    expect(result.items[1].jobId).toBe('job-xyz')
  })

  it('upcoming preview exposes jobId for drill-down', () => {
    const result = deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen', jobId: 'job-up' })], TODAY)
    expect(result.upcomingItem!.jobId).toBe('job-up')
  })

  it('component routes items to /craftsman/jobs/:jobId', () => {
    const source = loadComponentSource()
    expect(source).toContain('/craftsman/jobs/${item.jobId}')
    expect(source).toContain('/craftsman/jobs/${summary.upcomingItem.jobId}')
  })

  it('component routes CTA to summary.ctaRoute', () => {
    const source = loadComponentSource()
    expect(source).toContain('summary.ctaRoute')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Visual structure contract — outer card
// ═══════════════════════════════════════════════════════════════════════════

describe('Visual contract — outer card structure', () => {
  it('outer card uses rounded-3xl for 24px visual radius', () => {
    const source = loadComponentSource()
    expect(source).toContain('rounded-3xl')
  })

  it('outer card has p-4 for 16px padding', () => {
    const source = loadComponentSource()
    expect(source).toContain('p-4')
  })

  it('outer card has white background with ring border and shadow', () => {
    const source = loadComponentSource()
    expect(source).toContain('bg-white')
    expect(source).toContain('ring-1')
    expect(source).toContain('shadow-')
  })

  it('component returns null when not visible', () => {
    const source = loadComponentSource()
    expect(source).toContain('if (!summary.visible) return null')
  })
})
