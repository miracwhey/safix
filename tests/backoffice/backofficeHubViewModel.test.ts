import { describe, expect, it } from 'vitest'

import {
  deriveBackofficeHubViewModel,
  type BackofficeHubInputs,
} from '../../src/lib/backoffice'
import type { OnboardingProgress } from '../../src/lib/onboarding'

const ZERO_INPUTS: BackofficeHubInputs = {
  unassignedJobsCount: 0,
  incomingRequestsCount: 0,
  openCorrectionsCount: 0,
  unreadInternalThreadsCount: 0,
  unreadNotificationsCount: 0,
  onboardingProgress: null,
  teamActiveCount: 0,
  teamPendingStubCount: 0,
  teamHighLoadCount: 0,
}

function progressFixture(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    steps: [],
    completedCount: 0,
    totalCount: 5,
    completionPercent: 0,
    isComplete: false,
    nextStep: {
      id: 'business_identity',
      title: 'Betriebsprofil',
      description: 'Unternehmensname, Handle und Standort eintragen',
      navigationPath: '/onboarding/craftsman-profile',
      status: 'next',
    },
    isDiscoveryBlocked: true,
    isProfileReady: false,
    isPayoutReady: false,
    ...overrides,
  }
}

describe('deriveBackofficeHubViewModel', () => {
  describe('zero state', () => {
    it('renders default subtitles and emits no badges', () => {
      const hub = deriveBackofficeHubViewModel(ZERO_INPUTS)

      expect(hub.betrieb).toEqual({
        to: '/craftsman/operations',
        subtitle: 'Planung & Dokumentation',
      })
      expect(hub.team).toEqual({
        to: '/craftsman/team',
        subtitle: 'Ersten Mitarbeiter anlegen',
      })
      expect(hub.nachrichten.badge).toBeUndefined()
      expect(hub.korrekturen.badge).toBeUndefined()
      expect(hub.anfragen.badge).toBeUndefined()
      expect(hub.benachrichtigungen.badge).toBeUndefined()
      expect(hub.auftraege).toEqual({
        to: '/craftsman/jobs',
        subtitle: 'Jobs verwalten und bearbeiten',
      })
      expect(hub.profil).toEqual({
        to: '/craftsman/profile',
        subtitle: 'Profil & Showcase bearbeiten',
      })
    })

    it('keeps Finanzen and Rechnungen generic without canonical truth', () => {
      const hub = deriveBackofficeHubViewModel(ZERO_INPUTS)

      expect(hub.finanzen).toEqual({
        to: '/craftsman/finance',
        subtitle: 'Umsatz, Zahlungen & KPIs',
      })
      expect(hub.rechnungen).toEqual({
        to: '/craftsman/invoices',
        subtitle: 'Rechnungen erstellen & verwalten',
      })
    })

    it('keeps Betrieb generic — no Operations tab logic in the hub', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        // even when other domains are noisy, Betrieb stays generic
        unassignedJobsCount: 5,
        unreadInternalThreadsCount: 9,
      })

      expect(hub.betrieb).toEqual({
        to: '/craftsman/operations',
        subtitle: 'Planung & Dokumentation',
      })
      expect(hub.betrieb.badge).toBeUndefined()
    })
  })

  describe('Team card', () => {
    it('shows the active count and route when team has active members', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        teamActiveCount: 3,
      })

      expect(hub.team.to).toBe('/craftsman/team')
      expect(hub.team.subtitle).toBe('3 Mitarbeiter aktiv')
      expect(hub.team.badge).toBeUndefined()
    })

    it('appends pending stub note and shows count badge when stubs wait', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        teamActiveCount: 2,
        teamPendingStubCount: 1,
      })

      expect(hub.team.subtitle).toBe('2 Mitarbeiter aktiv · 1 wartet')
      expect(hub.team.badge).toBe(1)
    })

    it('combines stub and high-load counts into a single badge', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        teamActiveCount: 4,
        teamPendingStubCount: 1,
        teamHighLoadCount: 2,
      })

      expect(hub.team.badge).toBe(3)
    })

    it('falls back to onboarding subtitle when team has no members at all', () => {
      const hub = deriveBackofficeHubViewModel(ZERO_INPUTS)

      expect(hub.team.subtitle).toBe('Ersten Mitarbeiter anlegen')
      expect(hub.team.badge).toBeUndefined()
    })
  })

  describe('counter badges', () => {
    it('shows the request count when incoming requests exist', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        incomingRequestsCount: 3,
      })

      expect(hub.anfragen.badge).toBe(3)
      expect(hub.anfragen.to).toBe('/craftsman/requests')
    })

    it('shows the open corrections count', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        openCorrectionsCount: 2,
      })

      expect(hub.korrekturen.badge).toBe(2)
      expect(hub.korrekturen.to).toBe('/craftsman/korrekturen')
    })

    it('shows the unread internal-thread count', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unreadInternalThreadsCount: 1,
      })

      expect(hub.nachrichten.badge).toBe(1)
      expect(hub.nachrichten.to).toBe('/craftsman/nachrichten')
    })

    it('shows the unread notifications count', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unreadNotificationsCount: 7,
      })

      expect(hub.benachrichtigungen.badge).toBe(7)
      expect(hub.benachrichtigungen.to).toBe('/craftsman/notifications')
    })

    it('clamps an unread notifications count above 99 to "99+"', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unreadNotificationsCount: 142,
      })

      expect(hub.benachrichtigungen.badge).toBe('99+')
    })

    it('does not surface a "0" badge when a count is exactly zero', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        incomingRequestsCount: 0,
        openCorrectionsCount: 0,
        unreadInternalThreadsCount: 0,
        unreadNotificationsCount: 0,
      })

      expect(hub.anfragen.badge).toBeUndefined()
      expect(hub.korrekturen.badge).toBeUndefined()
      expect(hub.nachrichten.badge).toBeUndefined()
      expect(hub.benachrichtigungen.badge).toBeUndefined()
    })
  })

  describe('Aufträge contextual route', () => {
    it('routes to handlungsbedarf when at least one assignment is missing', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unassignedJobsCount: 1,
      })

      expect(hub.auftraege.to).toBe('/craftsman/jobs?focus=handlungsbedarf')
      expect(hub.auftraege.subtitle).toBe('1 Auftrag ohne Zuweisung')
    })

    it('uses plural copy for more than one unassigned job', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unassignedJobsCount: 4,
      })

      expect(hub.auftraege.subtitle).toBe('4 Aufträge ohne Zuweisung')
      expect(hub.auftraege.to).toBe('/craftsman/jobs?focus=handlungsbedarf')
    })

    it('falls back to the generic Aufträge route when nothing is unassigned', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        unassignedJobsCount: 0,
      })

      expect(hub.auftraege.to).toBe('/craftsman/jobs')
      expect(hub.auftraege.subtitle).toBe('Jobs verwalten und bearbeiten')
    })
  })

  describe('Profil card', () => {
    it('shows percentage and next step when onboarding is incomplete', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        onboardingProgress: progressFixture({
          completionPercent: 40,
          isComplete: false,
          nextStep: {
            id: 'profile_trust',
            title: 'Profilbild & Bio',
            description: 'Profilfoto und kurze Vorstellung hochladen',
            navigationPath: '/craftsman/profile',
            status: 'next',
          },
        }),
      })

      expect(hub.profil.subtitle).toBe('40% — Profilbild & Bio')
      expect(hub.profil.to).toBe('/craftsman/profile')
    })

    it('always routes to /craftsman/profile even when next step lives elsewhere (e.g. payout_setup)', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        onboardingProgress: progressFixture({
          completionPercent: 80,
          isComplete: false,
          nextStep: {
            id: 'payout_setup',
            title: 'Zahlungseinrichtung',
            description: 'Stripe Connect für Auszahlungen aktivieren',
            navigationPath: '/craftsman/finance',
            status: 'next',
          },
        }),
      })

      expect(hub.profil.subtitle).toBe('80% — Zahlungseinrichtung')
      expect(hub.profil.to).toBe('/craftsman/profile')
    })

    it('falls back to the generic Profil card when onboarding is complete', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        onboardingProgress: progressFixture({
          completionPercent: 100,
          completedCount: 5,
          isComplete: true,
          nextStep: null,
          isDiscoveryBlocked: false,
          isProfileReady: true,
          isPayoutReady: true,
        }),
      })

      expect(hub.profil).toEqual({
        to: '/craftsman/profile',
        subtitle: 'Profil & Showcase bearbeiten',
      })
    })

    it('falls back to the generic Profil card while onboarding is still loading', () => {
      const hub = deriveBackofficeHubViewModel({
        ...ZERO_INPUTS,
        onboardingProgress: null,
      })

      expect(hub.profil).toEqual({
        to: '/craftsman/profile',
        subtitle: 'Profil & Showcase bearbeiten',
      })
    })
  })
})
