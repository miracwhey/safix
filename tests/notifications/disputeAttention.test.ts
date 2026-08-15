import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { deriveAttentionItems } from '../../src/lib/notifications/attentionSelectors'
import type { Dispute, DisputeStatus } from '../../src/lib/disputes/types'
import type { AttentionItem } from '../../src/lib/notifications/types'

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dispute-attn-1',
    jobId: 'job-attn-1',
    status: 'provider_waiting',
    reason: 'work_quality',
    title: 'Bad-Sanierung Müller',
    description: 'Beschwerde wegen Fugen.',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T08:00:00.000Z',
    ...overrides,
  } as Dispute
}

function dispute(status: DisputeStatus): AttentionItem | undefined {
  const items = deriveAttentionItems([], [buildDispute({ status })])
  return items.find((i) => i.category === 'dispute')
}

describe('deriveDisputeAttention — N3c state-aware items', () => {
  it('renders provider_waiting with primary action and urgent severity', () => {
    const item = dispute('provider_waiting')
    expect(item).toBeDefined()
    expect(item?.severity).toBe('urgent')
    expect(item?.title).toBe('Streit · Bad-Sanierung Müller')
    expect(item?.description).toBe('SaFix wartet auf deine Stellungnahme.')
    expect(item?.roles).toEqual(['craftsman'])
    // N13.6 — owner-side urgent dispute attention deep-links into the
    // profile-side reconciliation center entry, not the job tab.
    expect(item?.primaryAction?.label).toBe('Stellungnahme senden')
    expect(item?.primaryAction?.to).toMatch(
      /^\/craftsman\/profile\/disputes\/R-\d{4}_\d{2}-\d{4}$/,
    )
  })

  it('renders customer_waiting with primary action targeting the customer', () => {
    const item = dispute('customer_waiting')
    expect(item?.severity).toBe('urgent')
    expect(item?.roles).toEqual(['customer'])
    expect(item?.primaryAction?.label).toBe('Stellungnahme senden')
    expect(item?.title).toBe('Streit · Bad-Sanierung Müller')
    expect(item?.description).toBe('SaFix wartet auf deine Stellungnahme.')
  })

  it('renders under_review without a primary action (read-only)', () => {
    const item = dispute('under_review')
    expect(item?.severity).toBe('waiting')
    expect(item?.title).toBe('Streit · Bad-Sanierung Müller')
    expect(item?.description).toBe('SaFix prüft den Fall.')
    expect(item?.primaryAction).toBeUndefined()
    expect(item?.roles).toContain('craftsman')
    expect(item?.roles).toContain('customer')
  })

  it('renders open without a primary action and uses action severity', () => {
    const item = dispute('open')
    expect(item?.severity).toBe('action')
    expect(item?.title).toBe('Streit · Bad-Sanierung Müller')
    expect(item?.description).toBe('Streitfall offen — Beweise einreichbar.')
    expect(item?.primaryAction).toBeUndefined()
  })

  it('emits no item for terminal dispute statuses', () => {
    expect(dispute('resolved')).toBeUndefined()
    expect(dispute('closed')).toBeUndefined()
    expect(dispute('cancelled')).toBeUndefined()
  })

  it('never mentions Stripe — copy contract', () => {
    for (const status of [
      'provider_waiting',
      'customer_waiting',
      'under_review',
      'open',
    ] as DisputeStatus[]) {
      const item = dispute(status)
      const blob = `${item?.title} ${item?.description} ${item?.primaryAction?.label ?? ''}`
      expect(blob.toLowerCase()).not.toContain('stripe')
      expect(blob).toContain('Streit')
    }
  })

  it('owner provider_waiting links to the profile-side reconciliation center (N13.6)', () => {
    const item = dispute('provider_waiting')
    expect(item?.linkTo).toMatch(/^\/craftsman\/profile\/disputes\/R-\d{4}_\d{2}-\d{4}$/)
    expect(item?.primaryAction?.to).toBe(item?.linkTo)
  })

  it('multi-role under_review still uses the JobDetail dispute focus anchor', () => {
    const item = dispute('under_review')
    expect(item?.linkTo).toBe('/craftsman/jobs/job-attn-1?focus=dispute')
  })

  it('keeps icon stable across all dispute states', () => {
    for (const status of [
      'provider_waiting',
      'customer_waiting',
      'under_review',
      'open',
    ] as DisputeStatus[]) {
      const item = dispute(status)
      expect(item?.icon).toBe('⚖️')
    }
  })
})

describe('AttentionBanner — primaryAction render contract', () => {
  const BANNER = resolve(__dirname, '../../src/components/notifications/AttentionBanner.tsx')
  const src = readFileSync(BANNER, 'utf-8')

  it('imports the AttentionItem type with the new primaryAction slot', () => {
    // The banner re-imports AttentionItem alongside other notification types;
    // the literal substring may live across lines after the multi-import
    // refactor in Block 7.2.8, so match the type usage instead of the import
    // header.
    expect(src).toMatch(/AttentionItem/)
    expect(src).toContain('item.primaryAction')
  })

  it('renders an inline CTA button when primaryAction is set', () => {
    expect(src).toContain('item.primaryAction.label')
    expect(src).toContain('item.primaryAction.to')
  })

  it('renders the secondary "Verlauf öffnen ›" link alongside the CTA', () => {
    expect(src).toContain('Verlauf öffnen')
  })

  it('avoids nesting Link inside Link when primaryAction is set', () => {
    // The branch with primaryAction must use a <div> wrapper, not <Link>.
    expect(src).toContain('if (hasPrimary && item.primaryAction)')
    // The primary-action branch wraps in <div>, the read-only branch wraps
    // in <Link to={item.linkTo}>. Asserting both shapes coexist:
    expect(src).toContain('<div\n        className={`rounded-2xl px-4 py-3 ring-1')
  })
})
