import { describe, it, expect } from 'vitest'
import { deriveTodayBlock } from '../../src/lib/dashboard/todayBlockSelectors'
import type { CalendarEntry } from '../../src/lib/calendar/calendarTypes'

// ── Factory ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Dachsanierung',
    customerName: 'Testkunde',
    location: 'Berlin',
    dateLabel: 'Heute',
    dateKey: '2026-03-30',
    startsAtLabel: '09:00',
    endsAtLabel: '11:00',
    assignedMemberIds: ['w1'],
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

const TODAY = '2026-03-30'

// ── 1. no_relevant_work mode when no relevant work exists ─────────────────────

describe('Today block — no_relevant_work states', () => {
  it('no_relevant_work when no calendar entries exist', () => {
    const result = deriveTodayBlock([], TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
    expect(result.todayCount).toBe(0)
    expect(result.headline).toBe('Heute')
    expect(result.subtitle).toBe('Keine Einsätze geplant')
    expect(result.items).toHaveLength(0)
    expect(result.ctaRoute).toBe('/craftsman/operations')
  })

  it('no_relevant_work when all entries are completed', () => {
    const entries = [
      makeEntry({ status: 'completed', dateKey: TODAY }),
      makeEntry({ status: 'completed', dateKey: '2026-04-01' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })

  it('no_relevant_work when all entries are cancelled', () => {
    const entries = [makeEntry({ status: 'cancelled', dateKey: TODAY })]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })

  it('no_relevant_work when all active entries are in the past (before today)', () => {
    const entries = [makeEntry({ dateKey: '2026-03-28', status: 'scheduled' })]
    const result = deriveTodayBlock(entries, TODAY)
    // Past entries with dateKey < todayKey — not "today" and not "future"
    // TodayBlock stays visible as planner shell, not accidentally hidden
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('no_relevant_work')
  })
})

// ── 2. only_pending_exists mode when only unscheduled pending work exists ─────

describe('Today block — only_pending_exists mode', () => {
  it('only pending entries → only_pending_exists mode', () => {
    const entries = [makeEntry({ status: 'pending', dateKey: TODAY })]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.visible).toBe(true)
    expect(result.mode).toBe('only_pending_exists')
    expect(result.todayCount).toBe(0)
    expect(result.headline).toBe('Heute')
    expect(result.subtitle).toBe('Heute nichts terminiert')
    expect(result.items).toHaveLength(0)
  })

  it('pending items never appear as today planned rows', () => {
    const entries = [
      makeEntry({ status: 'pending', dateKey: TODAY }),
      makeEntry({ status: 'pending', dateKey: '2026-04-01' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)
    expect(result.items).toHaveLength(0)
    expect(result.upcomingItem).toBeNull()
  })
})

// ── 3. today_has_items mode for single and multiple items ─────────────────────

describe('Today block — today_has_items (single)', () => {
  it('shows single today appointment with correct headline and subtitle', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      startsAtLabel: '10:00',
      title: 'Küche renovieren',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('today_has_items')
    expect(result.todayCount).toBe(1)
    expect(result.headline).toBe('Heute')
    expect(result.subtitle).toBe('1 Einsatz heute')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].jobId).toBe(entry.jobId)
  })

  it('includes time and title in single item', () => {
    const entry = makeEntry({
      dateKey: TODAY,
      startsAtLabel: '14:30',
      title: 'Heizung reparieren',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.items[0].timeLabel).toBe('14:30')
    expect(result.items[0].title).toBe('Heizung reparieren')
  })
})

describe('Today block — today_has_items (multiple)', () => {
  it('shows count subtitle for multiple today appointments', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, startsAtLabel: '09:00', title: 'Badumbau' }),
      makeEntry({ dateKey: TODAY, startsAtLabel: '13:00', title: 'Dacharbeit' }),
      makeEntry({ dateKey: TODAY, startsAtLabel: '16:00', title: 'Elektrik' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.visible).toBe(true)
    expect(result.mode).toBe('today_has_items')
    expect(result.todayCount).toBe(3)
    expect(result.headline).toBe('Heute')
    expect(result.subtitle).toBe('3 Einsätze heute')
    // All items returned — component handles scroll/bounding
    expect(result.items).toHaveLength(3)
    expect(result.items[0].timeLabel).toBe('09:00')
    expect(result.items[1].timeLabel).toBe('13:00')
    expect(result.items[2].timeLabel).toBe('16:00')
  })

  it('sorts items by time (earliest first)', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, startsAtLabel: '15:00', title: 'Spät' }),
      makeEntry({ dateKey: TODAY, startsAtLabel: '08:00', title: 'Früh' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].title).toBe('Früh')
    expect(result.items[1].title).toBe('Spät')
  })
})

// ── 4. Uses real scheduling truth, not fake home-only logic ──────────────────

describe('Today block — scheduling truth', () => {
  it('derives from CalendarEntry data (same source as schedule screen)', () => {
    // The selector takes CalendarEntry[] — the same type used by calendarSelectors.ts
    const entry = makeEntry({ dateKey: TODAY, status: 'scheduled' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.items[0].id).toBe(entry.id)
    expect(result.items[0].jobId).toBe(entry.jobId)
  })

  it('respects CalendarEntry status: filters out completed/cancelled', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, status: 'completed' }),
      makeEntry({ dateKey: TODAY, status: 'cancelled' }),
      makeEntry({ dateKey: TODAY, status: 'scheduled', title: 'Active' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.items[0].title).toBe('Active')
  })

  it('includes in_progress entries as active (not only scheduled)', () => {
    const entry = makeEntry({ dateKey: TODAY, status: 'in_progress', title: 'Ongoing' })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.visible).toBe(true)
    expect(result.items[0].title).toBe('Ongoing')
    expect(result.items[0].statusLabel).toBe('In Arbeit')
  })
})

// ── 5. Routing from Today CTA is semantically correct ────────────────────────

describe('Today block — CTA routing', () => {
  it('CTA routes to /craftsman/operations (planning surface)', () => {
    const entry = makeEntry({ dateKey: TODAY })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.ctaRoute).toBe('/craftsman/operations')
    expect(result.ctaLabel).toBe('Planung öffnen →')
  })

  it('CTA label says "Planung öffnen", not "Auftrag öffnen"', () => {
    const entries = [
      makeEntry({ dateKey: TODAY }),
      makeEntry({ dateKey: TODAY }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.ctaLabel).not.toContain('Auftrag')
    expect(result.ctaLabel).toContain('Planung')
  })
})

// ── 6. Routing from individual today item rows ───────────────────────────────

describe('Today block — item routing', () => {
  it('each item exposes jobId for routing to /craftsman/jobs/:jobId', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, jobId: 'job-abc' }),
      makeEntry({ dateKey: TODAY, jobId: 'job-xyz' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.items[0].jobId).toBe('job-abc')
    expect(result.items[1].jobId).toBe('job-xyz')
  })
})

// ── 9. Mini situation summary compact and not regressed ──────────────────────

describe('Mini situation summary — remains compact', () => {
  it('CompactDashboardStats accepts todayCount as optional prop', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/CompactDashboardStats.tsx', import.meta.url),
      'utf-8',
    )
    // todayCount is an optional prop (backward compat — no longer rendered)
    expect(source).toContain('todayCount?')
    // Renders the 3 core stat cards
    expect(source).toContain('Aufträge')
    expect(source).toContain('Zahlungen')
    expect(source).toContain('Nachrichten')
    // Uses StatCard (compact grid cards), not chip layout
    expect(source).toContain('StatCard')
    expect(source).toContain('grid')
  })

  it('CompactDashboardStats does not become a large Card or dashboard block', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/CompactDashboardStats.tsx', import.meta.url),
      'utf-8',
    )
    // No Card wrapper, no large heading
    expect(source).not.toContain('CraftsmanSectionCard')
    expect(source).not.toContain('<h2')
  })
})

// ── 10. today_empty_but_upcoming mode for future items ───────────────────────

describe('Today block — today_empty_but_upcoming mode', () => {
  it('future-only entry triggers today_empty_but_upcoming with upcoming preview', () => {
    const entry = makeEntry({
      dateKey: '2026-04-01',
      dateLabel: 'Mittwoch',
      startsAtLabel: '10:00',
      title: 'Fenster einbauen',
    })
    const result = deriveTodayBlock([entry], TODAY)

    expect(result.mode).toBe('today_empty_but_upcoming')
    expect(result.headline).toBe('Heute')
    expect(result.subtitle).toBe('Heute nichts geplant')
    expect(result.todayCount).toBe(0)
    expect(result.items).toHaveLength(0)
    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Fenster einbauen')
    expect(result.upcomingHint).toContain('Nächster Einsatz')
    expect(result.upcomingHint).toContain('Mittwoch')
  })

  it('upcoming mode headline is "Heute", not "Nächster Einsatz"', () => {
    const entries = [
      makeEntry({ dateKey: '2026-04-02', dateLabel: 'Donnerstag', startsAtLabel: '08:00' }),
      makeEntry({ dateKey: '2026-04-03', dateLabel: 'Freitag', startsAtLabel: '14:00' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.headline).toBe('Heute')
    expect(result.upcomingHint).toContain('Nächster Einsatz')
    expect(result.upcomingHint).toContain('Donnerstag')
  })
})

// ── Bonus: TodayBlock component source verification ──────────────────────────

describe('TodayBlock component — routing correctness', () => {
  it('TodayBlock component links to /craftsman/operations (CTA)', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('summary.ctaRoute')
    expect(source).toContain('summary.ctaLabel')
  })

  it('TodayBlock component links individual items to /craftsman/jobs/:jobId', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('/craftsman/jobs/${item.jobId}')
  })

  it('TodayBlock does not render when summary.visible is false', async () => {
    const fs = await import('fs')
    const source = fs.readFileSync(
      new URL('../../src/components/dashboard/TodayBlock.tsx', import.meta.url),
      'utf-8',
    )
    expect(source).toContain('if (!summary.visible) return null')
  })
})

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('Today block — edge cases', () => {
  it('mixed today + future entries counts only today entries in todayCount', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, title: 'Today job' }),
      makeEntry({ dateKey: '2026-04-01', title: 'Future job' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.mode).toBe('today_has_items')
  })

  it('completed today entries are not counted', () => {
    const entries = [
      makeEntry({ dateKey: TODAY, status: 'completed' }),
      makeEntry({ dateKey: TODAY, status: 'scheduled', title: 'Active' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.todayCount).toBe(1)
    expect(result.items[0].title).toBe('Active')
  })

  it('only future entry shown uses the closest date', () => {
    const entries = [
      makeEntry({ dateKey: '2026-04-05', dateLabel: 'Samstag', startsAtLabel: '14:00', title: 'Later' }),
      makeEntry({ dateKey: '2026-04-01', dateLabel: 'Mittwoch', startsAtLabel: '09:00', title: 'Sooner' }),
    ]
    const result = deriveTodayBlock(entries, TODAY)

    expect(result.mode).toBe('today_empty_but_upcoming')
    expect(result.upcomingItem).not.toBeNull()
    expect(result.upcomingItem!.title).toBe('Sooner')
    expect(result.upcomingHint).toContain('Mittwoch')
  })
})
