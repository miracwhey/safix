/**
 * Today Mini Planner — 4-Mode Product Contract Tests
 *
 * Proves the final Today block contract is a real mini day planner with 4 explicit modes:
 *
 *   MODE 1 — today_has_items:
 *     Real today scheduled/in-progress items exist.
 *     Planner body shows project-first rows, internally scrollable.
 *
 *   MODE 2 — today_empty_but_upcoming:
 *     Nothing today, but next real scheduled item exists in the future.
 *     Planner body shows empty-today message + upcoming preview.
 *
 *   MODE 3 — only_pending_exists:
 *     Work in system but none truly scheduled. Pending jobs never as today items.
 *     Planner body: "Heute nichts terminiert".
 *
 *   MODE 4 — no_relevant_work:
 *     No relevant work at all. Quiet planner shell.
 *
 * Tests cover:
 *   1.  Today block renders as structured planner, not flat text card
 *   2.  Planner body exists in all 4 modes
 *   3.  today_has_items renders project-first rows
 *   4.  Pending jobs never appear as today planned rows
 *   5.  No fake clock value appears
 *   6.  If no real time exists, block handles it honestly ("Uhrzeit offen")
 *   7.  Empty-today modes still render a quiet planner shell
 *   8.  Upcoming preview works when future scheduled work exists
 *   9.  Overflow is bounded and internally scrollable
 *   10. Title source never falls back to internal/workflow language in planner rows
 *   11. Entry card and Today block remain purpose-separated
 *   12. Routing remains semantically correct
 */

import { describe, it, expect } from 'vitest'
import { deriveTodayBlock, type TodayBlockMode } from '../../src/lib/dashboard/todayBlockSelectors'
import { deriveWorkEntrySummary } from '../../src/lib/dashboard/workEntrySelectors'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'
import type { Job } from '../../src/lib/jobs/types'

// ── Factories ──────────────────────────────────────────────────────────────

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

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-test',
    title: 'Test Job',
    customer: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    status: 'new',
    amount: '1.000 €',
    assignedMemberIds: [],
    activities: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

const TODAY = '2026-03-31'
const TOMORROW = '2026-04-01'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Today block renders as structured planner, not flat text card
// ═══════════════════════════════════════════════════════════════════════════

describe('1. Today block is a structured planner component', () => {
  it('component has unified Planner Header and Planner Body sections', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Planner Header — always present (emoji replaced with Lucide Calendar icon)
    expect(source).toContain('Planner Header')
    expect(source).toContain('Calendar')
    expect(source).toContain('Heute')
    // Planner Body — bounded scroll area
    expect(source).toContain('Planner Body')
    expect(source).toContain('planner-body')
    expect(source).toContain('max-h-[228px]')
    expect(source).toContain('overflow-y-auto')
  })

  it('header always shows "Heute" label with date context and CTA', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // "Heute" is in the header with calendar icon nearby (emoji replaced with Lucide Calendar)
    expect(source).toContain('Calendar')
    expect(source).toContain('Heute')
    // Date context always rendered
    expect(source).toContain('formattedDate')
    // CTA always rendered
    expect(source).toContain('summary.ctaRoute')
    expect(source).toContain('summary.ctaLabel')
  })

  it('headline is always "Heute" regardless of mode', () => {
    const modes = [
      deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY),
      deriveTodayBlock([], TODAY),
    ]
    for (const block of modes) {
      expect(block.headline).toBe('Heute')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Planner body exists in all 4 modes
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Planner body exists in all 4 modes', () => {
  it('component renders body for today_has_items mode', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("summary.mode === 'today_has_items'")
  })

  it('component renders body for today_empty_but_upcoming mode', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("summary.mode === 'today_empty_but_upcoming'")
  })

  it('component renders body for only_pending_exists mode', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("summary.mode === 'only_pending_exists'")
  })

  it('component renders body for no_relevant_work mode', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain("summary.mode === 'no_relevant_work'")
  })

  it('exactly 4 modes exist in the type union', () => {
    const VALID_MODES: TodayBlockMode[] = [
      'today_has_items',
      'today_empty_but_upcoming',
      'only_pending_exists',
      'no_relevant_work',
    ]
    // Every possible derivation must produce one of these modes
    const scenarios = [
      deriveTodayBlock([], TODAY),
      deriveTodayBlock([makeEntry({ status: 'pending' })], TODAY),
      deriveTodayBlock([makeEntry({ status: 'completed' })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TODAY }), makeEntry({ dateKey: TODAY })], TODAY),
      deriveTodayBlock([makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })], TODAY),
    ]
    for (const block of scenarios) {
      expect(VALID_MODES).toContain(block.mode)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. today_has_items renders project-first rows
// ═══════════════════════════════════════════════════════════════════════════

describe('3. today_has_items renders project-first rows', () => {
  it('project title is the primary content of each row', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, title: 'Elektrik-Projekt Hannover', startsAtLabel: '09:00' }),
      makeEntry({ dateKey: TODAY, title: 'Dachsanierung Berlin', startsAtLabel: '14:00' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('today_has_items')
    expect(result.items[0].title).toBe('Elektrik-Projekt Hannover')
    expect(result.items[1].title).toBe('Dachsanierung Berlin')
  })

  it('rows include customer and location as secondary line', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      title: 'Elektrik-Projekt',
      customerName: 'Kunde',
      location: 'Hannover',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].customerName).toBe('Kunde')
    expect(result.items[0].location).toBe('Hannover')
  })

  it('rows include optional status badge with human labels only', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, status: 'scheduled' }),
      makeEntry({ dateKey: TODAY, status: 'in_progress', startsAtLabel: 'Jetzt' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].statusLabel).toBe('Geplant')
    expect(result.items[1].statusLabel).toBe('In Arbeit')
  })

  it('single item and multiple items both use today_has_items mode', () => {
    const single = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)
    expect(single.mode).toBe('today_has_items')
    expect(single.todayCount).toBe(1)

    const multi = deriveTodayBlock([
      makeEntry({ dateKey: TODAY }),
      makeEntry({ dateKey: TODAY }),
      makeEntry({ dateKey: TODAY }),
    ], TODAY)
    expect(multi.mode).toBe('today_has_items')
    expect(multi.todayCount).toBe(3)
  })

  it('subtitle shows count of today items', () => {
    const single = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)
    expect(single.subtitle).toBe('1 Einsatz heute')

    const multi = deriveTodayBlock([
      makeEntry({ dateKey: TODAY }),
      makeEntry({ dateKey: TODAY }),
    ], TODAY)
    expect(multi.subtitle).toBe('2 Einsätze heute')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Pending jobs never appear as today planned rows
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Pending jobs never appear as today planned rows', () => {
  it('pending entry alone → only_pending_exists, no items', () => {
    const entry = makeEntry({ status: 'pending', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
    expect(result.todayCount).toBe(0)
  })

  it('pending + scheduled mix → only scheduled appears in items', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY, title: 'Pending Work' }),
      makeEntry({ status: 'scheduled', dateKey: TODAY, title: 'Real Scheduled' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('today_has_items')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe('Real Scheduled')
  })

  it('pending entries never appear in upcomingItem', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TOMORROW }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('only_pending_exists')
    expect(result.upcomingItem).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. No fake clock value appears
// ═══════════════════════════════════════════════════════════════════════════

describe('5. No fake clock value appears', () => {
  it('item without real time has hasRealTime=false and empty timeLabel', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(false)
    expect(result.items[0].timeLabel).toBe('')
  })

  it('"Jetzt" is a valid real-time label for in_progress', () => {
    const entry = makeEntry({ startsAtLabel: 'Jetzt', status: 'in_progress', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('Jetzt')
  })

  it('real HH:MM time is preserved', () => {
    const entry = makeEntry({ startsAtLabel: '14:30', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].hasRealTime).toBe(true)
    expect(result.items[0].timeLabel).toBe('14:30')
  })

  it('no fabricated "09:00" or similar when time is missing', () => {
    const entry = makeEntry({ startsAtLabel: '', dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    // timeLabel should be empty, not a fabricated value
    expect(result.items[0].timeLabel).not.toMatch(/^\d{1,2}:\d{2}$/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. If no real time exists, block handles it honestly
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Honest time handling — "Uhrzeit offen"', () => {
  it('component shows "Uhrzeit offen" when hasRealTime is false', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('Uhrzeit offen')
  })

  it('component does NOT show a dot placeholder for missing time', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Old pattern: a small dot circle for no-time items
    expect(source).not.toContain('rounded-full bg-slate-300')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Empty-today modes still render a quiet planner shell
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Empty/quiet modes still render planner shell', () => {
  it('only_pending_exists is visible with honest message', () => {
    const result = deriveTodayBlock([makeEntry({ status: 'pending', dateKey: TODAY })], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.subtitle).toBe('Heute nichts terminiert')
    expect(result.items).toHaveLength(0)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('no_relevant_work is visible with quiet message', () => {
    const result = deriveTodayBlock([], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.subtitle).toBe('Keine Einsätze geplant')
    expect(result.items).toHaveLength(0)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('completed/cancelled entries → no_relevant_work, not hidden', () => {
    const entries = [
      makeEntry({ status: 'completed', dateKey: TODAY }),
      makeEntry({ status: 'cancelled', dateKey: TODAY }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })

  it('pending + completed mix → only_pending_exists (pending detected)', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY }),
      makeEntry({ status: 'completed', dateKey: TODAY }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('only_pending_exists')
    expect(result.items).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Upcoming preview works when future scheduled work exists
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Upcoming preview in today_empty_but_upcoming mode', () => {
  it('shows upcoming item preview when future scheduled entry exists', () => {
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

  it('upcoming hint includes next date label', () => {
    const entry = makeEntry({
      dateKey: TOMORROW,
      dateLabel: 'Morgen',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.upcomingHint).toBe('Nächster Einsatz Morgen')
  })

  it('picks the chronologically closest future entry for preview', () => {
    const entries = [
      makeEntry({ dateKey: '2026-04-05', dateLabel: 'Samstag', title: 'Later' }),
      makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen', title: 'Sooner' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.upcomingItem!.title).toBe('Sooner')
    expect(result.upcomingHint).toContain('Morgen')
  })

  it('today items always empty in upcoming mode', () => {
    const entry = makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items).toHaveLength(0)
    expect(result.todayCount).toBe(0)
  })

  it('component renders upcoming preview link for drill-down', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    // Upcoming preview row links to job detail
    expect(source).toContain('summary.upcomingItem.jobId')
    expect(source).toContain('summary.upcomingHint')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Overflow is bounded and internally scrollable
// ═══════════════════════════════════════════════════════════════════════════

describe('9. Bounded internal scroll', () => {
  it('component has max-height and overflow-y-auto on planner body', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('max-h-[228px]')
    expect(source).toContain('overflow-y-auto')
  })

  it('all today items are returned (component handles scroll)', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        dateKey: TODAY,
        startsAtLabel: `${String(8 + i).padStart(2, '0')}:00`,
        title: `Job ${i + 1}`,
      }),
    )
    const result = deriveTodayBlock(entries, TODAY)

    // All items returned — not capped
    expect(result.items).toHaveLength(10)
    expect(result.todayCount).toBe(10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Title source never falls back to internal/workflow language
// ═══════════════════════════════════════════════════════════════════════════

describe('10. Title source quality — no internal/workflow language', () => {
  const forbiddenTitles = [
    'Anfrage läuft',
    'Auftrag aus Angebot',
    'Angebot versendet',
    'Warte auf Freigabe',
    'Neue Anfrage',
    'Anstehender Auftrag',
  ]

  it('statusLabel uses only human planning labels ("Geplant", "In Arbeit")', () => {
    const scheduled = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const inProgress = makeEntry({ dateKey: TODAY, status: 'in_progress', startsAtLabel: 'Jetzt' })
    const result = deriveTodayBlock([scheduled, inProgress], TODAY)

    expect(result.items[0].statusLabel).toBe('Geplant')
    expect(result.items[1].statusLabel).toBe('In Arbeit')

    for (const item of result.items) {
      for (const forbidden of forbiddenTitles) {
        expect(item.statusLabel).not.toBe(forbidden)
      }
    }
  })

  it('item titles pass through from CalendarEntry (project-first)', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      title: 'Elektrik-Projekt Hannover',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].title).toBe('Elektrik-Projekt Hannover')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Entry card and Today block remain purpose-separated
// ═══════════════════════════════════════════════════════════════════════════

describe('11. Entry card ≠ Today block — purpose separation', () => {
  it('Entry card is attention surface, Today block is planner surface', () => {
    const job = makeJob({ status: 'booked', assignedMemberIds: ['w1'] })
    const workEntry = deriveWorkEntrySummary([job], [], [])

    const entry = makeEntry({ dateKey: TODAY })
    const todayBlock = deriveTodayBlock([entry], TODAY)

    // Entry card: attention framing
    expect(workEntry.eyebrow).toBeTruthy()

    // Today block: planner framing
    expect(todayBlock.headline).toBe('Heute')
    expect(todayBlock.ctaRoute).toBe('/craftsman/operations')
  })

  it('Entry card routes to work-queue (data-driven), Today block routes to schedule', async () => {
    const fs = await import('fs')
    const workEntrySource = fs.readFileSync(
      new URL('../../src/components/dashboard/WorkEntryCard.tsx', import.meta.url),
      'utf-8',
    )
    // Entry card routing is data-driven from summary.ctaRoute
    expect(workEntrySource).toContain('summary.ctaRoute')

    // Today block routes to schedule (via selector CTA)
    const todayBlock = deriveTodayBlock([], TODAY)
    expect(todayBlock.ctaRoute).toBe('/craftsman/operations')
  })

  it('Today block does not echo entry card attention wording', () => {
    const todayBlock = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)

    // Today block should not contain attention-style language
    expect(todayBlock.subtitle).not.toContain('Aufmerksamkeit')
    expect(todayBlock.subtitle).not.toContain('brauchen')
    expect(todayBlock.subtitle).not.toContain('Aufgaben')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Routing remains semantically correct
// ═══════════════════════════════════════════════════════════════════════════

describe('12. Routing semantics', () => {
  it('Today block CTA → /craftsman/operations (planning screen)', () => {
    const result = deriveTodayBlock([makeEntry({ dateKey: TODAY })], TODAY)

    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toBe('Planung öffnen →')
    expect(result.ctaLabel).toContain('Planung')
    expect(result.ctaLabel).not.toContain('Auftrag')
  })

  it('Today row items expose jobId for /craftsman/jobs/:jobId routing', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, jobId: 'job-abc' }),
      makeEntry({ dateKey: TODAY, jobId: 'job-xyz' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].jobId).toBe('job-abc')
    expect(result.items[1].jobId).toBe('job-xyz')
  })

  it('Upcoming preview item exposes jobId for drill-down', () => {
    const entry = makeEntry({ dateKey: TOMORROW, dateLabel: 'Morgen', jobId: 'job-upcoming' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.jobId).toBe('job-upcoming')
  })

  it('component routes today items to /craftsman/jobs/:jobId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${item.jobId}')
  })

  it('component routes upcoming preview to /craftsman/jobs/:jobId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${summary.upcomingItem.jobId}')
  })

  it('CTA is present in all modes', () => {
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
})
