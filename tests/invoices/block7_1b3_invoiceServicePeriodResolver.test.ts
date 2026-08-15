/**
 * Block 7.1B3 — Invoice Service Period Resolver
 *
 * Pure unit tests für `resolveDefaultServicePeriod` und `normalizeServicePeriod`.
 */

import { describe, it, expect } from 'vitest'
import {
  resolveDefaultServicePeriod,
  normalizeServicePeriod,
} from '../../src/lib/invoices/invoiceServicePeriodResolver'

const apr10 = new Date('2026-04-10').getTime()
const apr12 = new Date('2026-04-12').getTime()
const apr15 = new Date('2026-04-15').getTime()

describe('resolveDefaultServicePeriod', () => {
  it('nimmt Schedule-Plan-Zeitraum, wenn beide Zeitstempel vorhanden sind', () => {
    const out = resolveDefaultServicePeriod({
      job: { workCompletedAt: apr15 },
      schedule: { scheduledStart: apr10, scheduledEnd: apr12 },
    })
    expect(out?.from).toBe(apr10)
    expect(out?.to).toBe(apr12)
    expect(out?.label).toContain('10.04.2026')
    expect(out?.label).toContain('12.04.2026')
    expect(out?.label).toContain('Leistungszeitraum')
  })

  it('fällt zurück auf proposalAcceptedAt → workCompletedAt', () => {
    const out = resolveDefaultServicePeriod({
      job: { workCompletedAt: apr15, proposalAcceptedAt: apr10 },
    })
    expect(out?.from).toBe(apr10)
    expect(out?.to).toBe(apr15)
    expect(out?.label).toContain('10.04.2026')
    expect(out?.label).toContain('15.04.2026')
  })

  it('liefert single-date Leistungsdatum, wenn nur workCompletedAt da ist', () => {
    const out = resolveDefaultServicePeriod({
      job: { workCompletedAt: apr15 },
    })
    expect(out?.from).toBeNull()
    expect(out?.to).toBe(apr15)
    expect(out?.label).toContain('15.04.2026')
    expect(out?.label.toLowerCase()).toContain('leistungsdatum')
  })

  it('liefert NULL, wenn keine Quelle ein Datum hat', () => {
    expect(resolveDefaultServicePeriod({ job: {} })).toBeNull()
  })
})

describe('normalizeServicePeriod', () => {
  it('liefert NULL bei komplett leerem Input', () => {
    expect(
      normalizeServicePeriod({ from: null, to: null, label: '' }),
    ).toBeNull()
  })
  it('generiert Label aus Daten falls leer', () => {
    const out = normalizeServicePeriod({ from: apr10, to: apr12, label: '' })
    expect(out?.label).toContain('10.04.2026')
    expect(out?.label).toContain('12.04.2026')
  })
  it('trimmt manuell gesetztes Label', () => {
    const out = normalizeServicePeriod({
      from: apr12,
      to: apr12,
      label: '  Leistungsdatum: 12.04.2026  ',
    })
    expect(out?.label).toBe('Leistungsdatum: 12.04.2026')
  })
})
