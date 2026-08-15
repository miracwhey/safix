import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Bookmark, MessageSquare, PenLine, Plus, Share2 } from 'lucide-react'
import InstaProfileHeader, {
  type InstaProfileAction,
} from '../../../src/components/profile/InstaProfileHeader'
import { formatStatNumber } from '../../../src/components/profile/instaStatFormat'

function avatar() {
  return React.createElement(
    'div',
    { className: 'h-[78px] w-[78px] rounded-full', 'aria-hidden': true },
    'AV',
  )
}

const baseStats: [
  { value: string; label: string },
  { value: string; label: string },
  { value: string; label: string },
] = [
  { value: '12', label: 'Reels' },
  { value: '34', label: 'Likes' },
  { value: '★ 4.6', label: '12 Bew.' },
]

describe('InstaProfileHeader', () => {
  it('renders name, category line, bio and stat tiles', () => {
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Elektro Weber GmbH',
        handle: '@elektroweber_abc',
        bio: 'Meisterbetrieb seit 2008.',
        tradeCategories: ['Elektrik', 'Sanitär'],
        location: 'Hannover',
        serviceRadiusKm: 25,
        stats: baseStats,
        actions: [],
        avatarSlot: avatar(),
      }),
    )
    expect(html).toContain('Elektro Weber GmbH')
    expect(html).toContain('Meisterbetrieb seit 2008.')
    // Trades + Stadt erscheinen jetzt in der Kategorie-Zeile (Reels-Redesign),
    // nicht mehr als Trade-Chips bzw. eigene „bis X km"-Zeile.
    expect(html).toContain('Elektrik')
    expect(html).toContain('Sanitär')
    expect(html).toContain('Reels')
    expect(html).toContain('★ 4.6')
    expect(html).toContain('12 Bew.')
    expect(html).toContain('Hannover')
  })

  it('shows the response-latency pill when given', () => {
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Test',
        handle: '@test_a',
        tradeCategories: [],
        stats: baseStats,
        responseLatencyLabel: 'Antwort meist < 4 h',
        actions: [],
        avatarSlot: avatar(),
      }),
    )
    expect(html).toContain('Antwort meist &lt; 4 h')
    expect(html).toContain('Aktiv')
  })

  it('hides the status pill when showStatusPill=false', () => {
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Test',
        handle: '@test_a',
        tradeCategories: [],
        stats: baseStats,
        showStatusPill: false,
        actions: [],
        avatarSlot: avatar(),
      }),
    )
    expect(html).not.toContain('Aktiv')
  })

  it('renders verified-badge when verified=true', () => {
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Test',
        handle: '@test_a',
        verified: true,
        tradeCategories: [],
        stats: baseStats,
        actions: [],
        avatarSlot: avatar(),
      }),
    )
    expect(html).toContain('aria-label="Verifizierter Handwerker"')
  })

  it('customer mode: renders Anfragen primary + Merken/Teilen icons + busy state', () => {
    const actions: InstaProfileAction[] = [
      {
        key: 'inquire',
        label: 'Wird gesendet …',
        icon: MessageSquare,
        variant: 'primary',
        onClick: () => {},
        pending: true,
      },
      {
        key: 'save',
        label: 'Merken',
        icon: Bookmark,
        variant: 'icon',
        onClick: () => {},
        ariaLabel: 'Merken',
      },
      {
        key: 'share',
        label: 'Teilen',
        icon: Share2,
        variant: 'icon',
        onClick: () => {},
      },
    ]
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Test',
        handle: '@test_a',
        tradeCategories: [],
        stats: baseStats,
        actions,
        avatarSlot: avatar(),
      }),
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Wird gesendet')
    expect(html).toContain('aria-label="Merken"')
    expect(html).toContain('aria-label="Teilen"')
  })

  it('owner mode: + Arbeitsprobe primary + Bearbeiten/Vorschau icons', () => {
    const actions: InstaProfileAction[] = [
      {
        key: 'add-sample',
        label: '+ Arbeitsprobe',
        icon: Plus,
        variant: 'primary',
        onClick: () => {},
      },
      {
        key: 'edit',
        label: 'Bearbeiten',
        icon: PenLine,
        variant: 'icon',
        onClick: () => {},
      },
    ]
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Mein Betrieb',
        handle: '@mein',
        tradeCategories: ['Elektrik'],
        stats: baseStats,
        actions,
        avatarSlot: avatar(),
      }),
    )
    expect(html).toContain('+ Arbeitsprobe')
    expect(html).toContain('aria-label="Bearbeiten"')
  })

  it('renders error banner via errorMessage prop with role=alert', () => {
    const html = renderToString(
      React.createElement(InstaProfileHeader, {
        name: 'Test',
        handle: '@test_a',
        tradeCategories: [],
        stats: baseStats,
        actions: [],
        avatarSlot: avatar(),
        errorMessage: 'Anfrage konnte nicht gestartet werden.',
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('Anfrage konnte nicht gestartet werden.')
  })
})

describe('formatStatNumber', () => {
  it('returns the integer string for n < 1000', () => {
    expect(formatStatNumber(0)).toBe('0')
    expect(formatStatNumber(42)).toBe('42')
    expect(formatStatNumber(999)).toBe('999')
  })

  it('formats thousands as "1.2k"', () => {
    expect(formatStatNumber(1234)).toBe('1.2k')
  })

  it('drops the decimal when result rounds to integer thousands', () => {
    expect(formatStatNumber(2000)).toBe('2k')
  })

  it('uses an integer suffix once n >= 10_000', () => {
    expect(formatStatNumber(12_345)).toBe('12k')
  })

  it('formats millions as "1.2M"', () => {
    expect(formatStatNumber(1_200_000)).toBe('1.2M')
  })
})
