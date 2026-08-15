import type { Dispute } from './types'

const HOUR_MS = 1000 * 60 * 60
const isoNowMinusHours = (hours: number): string =>
  new Date(Date.now() - hours * HOUR_MS).toISOString()

export const mockDisputes: Dispute[] = [
  {
    id: 'dispute_1',
    jobId: 'job-1',
    status: 'under_review',
    reason: 'work_quality',
    title: 'Malerarbeiten nicht vollständig',
    description:
      'Die vereinbarten Malerarbeiten im Wohnzimmer wurden nur teilweise ausgeführt. Zwei Wände wurden nicht gestrichen und die Abdeckarbeiten fehlen.',
    createdAt: isoNowMinusHours(48),
    updatedAt: isoNowMinusHours(12),
    evidence: [],
  },
  {
    id: 'dispute_2',
    jobId: 'job-2',
    status: 'customer_waiting',
    reason: 'delay',
    title: 'Verzögerung bei Bodenverlegung',
    description:
      'Der Auftrag sollte bis zum 01.03. abgeschlossen sein. Bislang sind erst 40 % der Fläche verlegt und kein neuer Termin wurde kommuniziert.',
    createdAt: isoNowMinusHours(24),
    updatedAt: isoNowMinusHours(24),
    evidence: [],
  },
  {
    id: 'dispute_3',
    jobId: 'job-3',
    status: 'resolved',
    decision: 'release',
    resolutionType: 'release_full',
    settlementStatus: 'settled',
    reason: 'scope_conflict',
    title: 'Leistungsumfang Badezimmerrenovierung',
    description:
      'Kunde beanstandete, dass die Fliesenarbeiten nicht dem vereinbarten Umfang entsprachen. Nach Prüfung der Dokumentation wurde die Zahlung freigegeben.',
    createdAt: isoNowMinusHours(72),
    updatedAt: isoNowMinusHours(24),
    resolvedAt: isoNowMinusHours(24),
    evidence: [],
  },
  {
    id: 'dispute_4',
    jobId: 'job-4',
    status: 'resolved',
    decision: 'reject',
    resolutionType: 'rejected',
    settlementStatus: 'settled',
    reason: 'other',
    title: 'Unberechtigte Reklamation',
    description:
      'Die eingereichte Reklamation konnte nicht bestätigt werden. Die Leistungen wurden vollständig und vertragsgemäß erbracht.',
    createdAt: isoNowMinusHours(96),
    updatedAt: isoNowMinusHours(48),
    resolvedAt: isoNowMinusHours(48),
    evidence: [],
  },
]
