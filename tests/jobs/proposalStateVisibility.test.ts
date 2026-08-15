import { describe, it, expect } from 'vitest'
import { deriveProposalReadiness, deriveProposalState } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs/types'

const baseJob: Job = {
  id: 'job-1',
  projectId: 'project-1',
  title: 'Test Job',
  customer: 'Kunde',
  location: 'Berlin',
  dateLabel: 'Nächste Woche',
  status: 'new',
  amount: '',
  description: '',
  paymentState: 'deposit_required',
  documentationStatus: 'Noch keine Dokumentation',
  assignedMemberIds: [],
  notes: [],
  photoCount: 0,
  activities: [],
}

describe('deriveProposalState', () => {
  it('returns "draft_blocked" when a draft exists but prerequisites are missing', () => {
    const state = deriveProposalState({
      ...baseJob,
      amount: '500 €',
      description: '',
      intakeContext: {
        origin: 'inquiry_reel',
        originLabel: 'Reel',
        requestLocation: 'Berlin',
      },
    })

    expect(state.state).toBe('draft_blocked')
    expect(state.label).toContain('Entwurf')
  })

  it('returns "ready_to_send" when all prerequisites are met', () => {
    const state = deriveProposalState({
      ...baseJob,
      amount: '1.200 €',
      description: 'Komplette Badrenovierung',
      dateLabel: '01.05.',
      intakeContext: {
        origin: 'inquiry_project',
        originLabel: 'Projekt',
        requestDescription: 'Badrenovierung inkl. Fliesen',
        requestLocation: 'Hamburg',
        requestBudget: '1.200 €',
        requestDuration: '2 Wochen',
      },
    })

    expect(state.state).toBe('ready_to_send')
    expect(state.label).toBe('Versandbereit')
  })

  it('returns "sent" when proposalSentAt is set', () => {
    const state = deriveProposalState({
      ...baseJob,
      amount: '900 €',
      description: 'Angebot steht bereit',
      proposalSentAt: Date.now(),
      intakeContext: {
        origin: 'inquiry_profile',
        originLabel: 'Profil',
        requestDescription: 'Elektrik',
        requestLocation: 'Berlin',
        requestBudget: '900 €',
        requestDuration: '1 Woche',
      },
    })

    expect(state.state).toBe('sent')
    expect(state.label).toBe('Angebot gesendet')
  })

  it('does not report "accepted" when proposalSentAt is missing', () => {
    const state = deriveProposalState({
      ...baseJob,
      amount: '2.500 €',
      description: 'Angebot angenommen',
      proposalAcceptedAt: Date.now(),
    })

    expect(state.state).toBe('invalid')
    expect(state.label).toBe('Ungültiger Angebotsstatus')
  })

  it('returns "accepted" only when both sent and accepted timestamps are present', () => {
    const now = Date.now()
    const state = deriveProposalState({
      ...baseJob,
      amount: '2.500 €',
      description: 'Angebot angenommen',
      proposalSentAt: now - 1000,
      proposalAcceptedAt: now,
    })

    expect(state.state).toBe('accepted')
    expect(state.label).toBe('Angebot angenommen')
  })

  it('surfaces an invalid readiness state when acceptance is stored without send timestamp', () => {
    const readiness = deriveProposalReadiness({
      ...baseJob,
      amount: '1.000 €',
      description: 'Test',
      proposalAcceptedAt: Date.now(),
    })

    expect(readiness.readiness).toBe('proposal_invalid')
    expect(readiness.readinessColor).toBe('red')
  })
})
