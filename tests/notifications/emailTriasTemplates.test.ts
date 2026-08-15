/**
 * Block 3 — Email trias templates.
 *
 * Pins the subject/body contract for every transactional email that
 * belongs to the payment/payout trust corridor. These labels must match
 * the Timeline + Notification wording so no surface drifts.
 */

import { describe, it, expect } from 'vitest'

import { buildEmailContent } from '../../src/lib/notifications/delivery/templates'
import { VALID_DELIVERY_TYPES } from '../../src/lib/notifications/delivery/types'

describe('Email trias — template contract', () => {
  const cases: Array<{
    type: (typeof VALID_DELIVERY_TYPES)[number]
    context: Record<string, unknown>
    subjectIncludes: string
    bodyIncludes: string
  }> = [
    {
      type: 'escrow_locked',
      context: { jobTitle: 'Bad', recipientRole: 'customer' },
      subjectIncludes: 'Zahlung abgesichert',
      bodyIncludes: 'über Stripe abgesichert',
    },
    {
      type: 'escrow_locked',
      context: { jobTitle: 'Bad', recipientRole: 'craftsman' },
      subjectIncludes: 'Zahlung abgesichert',
      bodyIncludes: '25 %',
    },
    {
      type: 'payment_released',
      context: { jobTitle: 'Bad' },
      subjectIncludes: 'Zahlung freigegeben',
      bodyIncludes: 'abgesicherten Zahlung',
    },
    {
      type: 'payout_handoff_initiated',
      context: { jobTitle: 'Bad' },
      subjectIncludes: 'Zur Auszahlung übergeben',
      bodyIncludes: 'Zahlungsdienstleister',
    },
    {
      type: 'payout_completed',
      context: { jobTitle: 'Bad' },
      subjectIncludes: 'Geld eingegangen',
      bodyIncludes: 'Bankkonto',
    },
    {
      type: 'payout_failed',
      context: { jobTitle: 'Bad' },
      subjectIncludes: 'Auszahlung fehlgeschlagen',
      bodyIncludes: 'SaFix prüft',
    },
  ]

  for (const c of cases) {
    it(`builds email content for ${c.type} (${String(c.context.recipientRole ?? 'default')})`, () => {
      const content = buildEmailContent(c.type, c.context)
      expect(content.subject).toContain(c.subjectIncludes)
      expect(content.text).toContain(c.bodyIncludes)
      // HTML body must escape-wrap the subject + body, so both appear in it.
      expect(content.html).toContain(c.subjectIncludes)
    })
  }

  it('registers every new trust-corridor type in VALID_DELIVERY_TYPES', () => {
    const required = [
      'escrow_locked',
      'payment_released',
      'payout_handoff_initiated',
      'payout_completed',
      'payout_failed',
    ] as const
    for (const t of required) {
      expect(VALID_DELIVERY_TYPES).toContain(t)
    }
  })
})
