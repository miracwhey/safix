import { describe, it, expect } from 'vitest'
import {
  deriveCustomerJobStage,
  deriveCustomerNextAction,
  deriveNextAction,
} from '../../src/lib/jobs'

describe('proposal lifecycle consistency across selectors', () => {
  it('treats sent state consistently across next actions and stages', () => {
    const sentAt = Date.now() - 1000
    const next = deriveNextAction('new', undefined, undefined, sentAt, undefined)
    const customerNext = deriveCustomerNextAction('new', undefined, undefined, sentAt, undefined)
    const stage = deriveCustomerJobStage('new', undefined, sentAt, undefined)

    expect(next.label).toContain('Angebot gesendet')
    expect(customerNext.label).toContain('Angebot')
    expect(stage.stage).toBe('offer_received')
  })

  it('treats accepted state only when send timestamp exists', () => {
    const sentAt = Date.now() - 2000
    const acceptedAt = Date.now() - 1000
    const next = deriveNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    const customerNext = deriveCustomerNextAction('new', 'deposit_required', undefined, sentAt, acceptedAt)
    const stage = deriveCustomerJobStage('new', undefined, sentAt, acceptedAt)

    expect(next.label).toContain('Zahlung')
    expect(customerNext.label).toContain('Zahlung')
    expect(stage.stage).toBe('offer_accepted')
  })

  it('flags acceptance without send as invalid/inquiry state', () => {
    const next = deriveNextAction('new', undefined, undefined, undefined, Date.now())
    const customerNext = deriveCustomerNextAction('new', undefined, undefined, undefined, Date.now())
    const stage = deriveCustomerJobStage('new', undefined, undefined, Date.now())

    expect(next.label).toContain('Ungültig')
    expect(customerNext.label).toContain('Angebot unklar')
    expect(stage.stage).toBe('inquiry_sent')
  })
})
