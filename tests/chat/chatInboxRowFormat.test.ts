import { describe, it, expect } from 'vitest'
import {
  inboxRowDisplay,
  inboxRowPreview,
  inboxRowTimestamp,
  inboxRowUnreadBadge,
} from '../../src/components/chat/chatInboxRowFormat'

describe('inboxRowDisplay', () => {
  const meta = {
    customerName: 'Anna Kunde',
    customerAvatarUrl: 'https://x/anna.jpg',
    craftsmanName: 'Berthold Bau',
    craftsmanAvatarUrl: 'https://x/berthold.jpg',
    projectTitle: 'Bad sanieren',
    projectSubtitle: 'Mustergasse 1',
    projectLocation: 'Berlin',
  }

  it('shows the craftsman to the customer', () => {
    const d = inboxRowDisplay(meta, 'customer')
    expect(d.name).toBe('Berthold Bau')
    expect(d.avatarUrl).toBe('https://x/berthold.jpg')
    expect(d.subtitle).toBe('Bad sanieren')
  })

  it('shows the customer to the craftsman / owner / admin', () => {
    expect(inboxRowDisplay(meta, 'craftsman').name).toBe('Anna Kunde')
    expect(inboxRowDisplay(meta, 'owner').name).toBe('Anna Kunde')
    expect(inboxRowDisplay(meta, 'admin').name).toBe('Anna Kunde')
  })

  it('worker view leads with the project, not a person', () => {
    const d = inboxRowDisplay(meta, 'worker')
    expect(d.name).toBe('Bad sanieren')
    expect(d.subtitle).toBe('Mustergasse 1')
  })

  it('falls back to the supplied title when metadata is missing', () => {
    const d = inboxRowDisplay(null, 'customer', 'Fallback Titel')
    expect(d.name).toBe('Fallback Titel')
    expect(d.avatarUrl).toBeNull()
  })

  it('uses the safe fallback name when nothing else is available', () => {
    const d = inboxRowDisplay(null, 'customer')
    expect(d.name).toBe('Unbenannter Chat')
  })
})

describe('inboxRowTimestamp', () => {
  it('returns empty string for null/0/undefined', () => {
    expect(inboxRowTimestamp(null)).toBe('')
    expect(inboxRowTimestamp(0)).toBe('')
    expect(inboxRowTimestamp(undefined)).toBe('')
  })

  it('returns "Jetzt" for sub-minute distance', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 30)
    const ts = now - 20_000
    expect(inboxRowTimestamp(ts, now)).toBe('Jetzt')
  })

  it('returns HH:MM for same-day distance', () => {
    // Construct a local time so the helper's getHours/getMinutes are stable.
    const now = new Date(2026, 4, 10, 12, 0, 0).getTime()
    const ts = new Date(2026, 4, 10, 9, 7, 0).getTime()
    expect(inboxRowTimestamp(ts, now)).toBe('09:07')
  })

  it('returns "Gestern" when the timestamp falls on the previous calendar day', () => {
    const now = new Date(2026, 4, 10, 12, 0, 0).getTime()
    const ts = new Date(2026, 4, 9, 22, 30, 0).getTime()
    expect(inboxRowTimestamp(ts, now)).toBe('Gestern')
  })

  it('returns a weekday label inside the last 7 days', () => {
    const now = new Date(2026, 4, 10, 12, 0, 0).getTime() // Sunday
    const ts = new Date(2026, 4, 7, 9, 0, 0).getTime()    // Thursday
    expect(inboxRowTimestamp(ts, now)).toBe('Do')
  })

  it('returns DD.MM. for older same-year distance', () => {
    const now = new Date(2026, 4, 10, 12, 0, 0).getTime()
    const ts = new Date(2026, 0, 14, 9, 0, 0).getTime()
    expect(inboxRowTimestamp(ts, now)).toBe('14.01.')
  })

  it('returns DD.MM.YYYY for cross-year distance', () => {
    const now = new Date(2026, 4, 10, 12, 0, 0).getTime()
    const ts = new Date(2024, 11, 5, 9, 0, 0).getTime()
    expect(inboxRowTimestamp(ts, now)).toBe('05.12.2024')
  })
})

describe('inboxRowUnreadBadge', () => {
  it('renders empty string when there is nothing to show', () => {
    expect(inboxRowUnreadBadge(0)).toBe('')
    expect(inboxRowUnreadBadge(null)).toBe('')
    expect(inboxRowUnreadBadge(undefined)).toBe('')
  })

  it('renders the count for normal values', () => {
    expect(inboxRowUnreadBadge(1)).toBe('1')
    expect(inboxRowUnreadBadge(42)).toBe('42')
    expect(inboxRowUnreadBadge(99)).toBe('99')
  })

  it('caps at 99+', () => {
    expect(inboxRowUnreadBadge(100)).toBe('99+')
    expect(inboxRowUnreadBadge(1234)).toBe('99+')
  })
})

describe('inboxRowPreview', () => {
  it('returns empty string for missing input', () => {
    expect(inboxRowPreview(null)).toBe('')
    expect(inboxRowPreview('')).toBe('')
  })

  it('collapses whitespace and trims', () => {
    expect(inboxRowPreview('  hello\n\n  world  ')).toBe('hello world')
  })

  it('truncates with an ellipsis when the input exceeds the max length', () => {
    const long = 'a'.repeat(200)
    const out = inboxRowPreview(long, 50)
    expect(out.length).toBe(50)
    expect(out.endsWith('…')).toBe(true)
  })
})
