import type { Job, JobConversation } from '../jobs'
import { isActiveJob, isCompletedJob } from '../jobs'
import { getActionablePaymentState } from '../jobs/helpers'
import type { OnboardingProgress } from '../onboarding'

export type BackofficeKPI = {
  activeJobs: number
  completedJobs: number
  totalJobs: number
  openChats: number
  jobsInProgress: number
  waitingPayment: number
}

export function getBackofficeKPIs(
  jobs: Job[],
  conversations: JobConversation[]
): BackofficeKPI {
  const activeJobs = jobs.filter(isActiveJob).length
  const completedJobs = jobs.filter(isCompletedJob).length

  const jobsInProgress = jobs.filter((job) => job.status === 'in_progress').length
  const waitingPayment = jobs.filter(
    (job) =>
      job.status === 'waiting_payment' ||
      getActionablePaymentState(job) === 'release_pending'
  ).length

  return {
    activeJobs,
    completedJobs,
    totalJobs: jobs.length,
    openChats: conversations.length,
    jobsInProgress,
    waitingPayment,
  }
}

// ── Backoffice Hub view model ────────────────────────────────────────────────
//
// Pure derivation of the state-aware adornments shown on the Verwaltung-Hub
// (CraftsmanBackofficeScreen). All inputs come from canonical selectors;
// this module never reads state itself and never invents readiness rules.
// Empty / zero state must remain noise-free: no "0" badges, no fake hints.

export type BackofficeHubCardId =
  | 'betrieb'
  | 'team'
  | 'nachrichten'
  | 'korrekturen'
  | 'anfragen'
  | 'auftraege'
  | 'finanzen'
  | 'rechnungen'
  | 'profil'
  | 'benachrichtigungen'

export type BackofficeHubCardViewModel = {
  to: string
  subtitle: string
  badge?: number | string
}

export type BackofficeHubViewModel = Record<
  BackofficeHubCardId,
  BackofficeHubCardViewModel
>

export type BackofficeHubInputs = {
  unassignedJobsCount: number
  incomingRequestsCount: number
  openCorrectionsCount: number
  unreadInternalThreadsCount: number
  unreadNotificationsCount: number
  onboardingProgress: OnboardingProgress | null
  teamActiveCount: number
  teamPendingStubCount: number
  teamHighLoadCount: number
}

const DEFAULT_HUB_VIEW_MODEL: BackofficeHubViewModel = {
  betrieb: {
    to: '/craftsman/operations',
    subtitle: 'Planung & Dokumentation',
  },
  team: {
    to: '/craftsman/team',
    subtitle: 'Mitarbeiter, Beitritts-Code & Stunden',
  },
  nachrichten: {
    to: '/craftsman/nachrichten',
    subtitle: 'Interne Büro- & Team-Kommunikation',
  },
  korrekturen: {
    to: '/craftsman/korrekturen',
    subtitle: 'Zeiterfassungs- & Einsatzkorrekturen prüfen',
  },
  anfragen: {
    to: '/craftsman/requests',
    subtitle: 'Offene Anfragen prüfen & bearbeiten',
  },
  auftraege: {
    to: '/craftsman/jobs',
    subtitle: 'Jobs verwalten und bearbeiten',
  },
  finanzen: {
    to: '/craftsman/finance',
    subtitle: 'Umsatz, Zahlungen & KPIs',
  },
  rechnungen: {
    to: '/craftsman/invoices',
    subtitle: 'Rechnungen erstellen & verwalten',
  },
  profil: {
    to: '/craftsman/profile',
    subtitle: 'Profil & Showcase bearbeiten',
  },
  benachrichtigungen: {
    to: '/craftsman/notifications',
    subtitle: 'Alle Meldungen anzeigen',
  },
}

function clampUnreadBadge(count: number): number | string | undefined {
  if (count <= 0) return undefined
  if (count > 99) return '99+'
  return count
}

function nonZeroBadge(count: number): number | undefined {
  return count > 0 ? count : undefined
}

export function deriveBackofficeHubViewModel(
  inputs: BackofficeHubInputs,
): BackofficeHubViewModel {
  const profil = (() => {
    const progress = inputs.onboardingProgress
    if (!progress || progress.isComplete || !progress.nextStep) {
      return DEFAULT_HUB_VIEW_MODEL.profil
    }
    // Keep progress indicator in subtitle but never redirect away from profile.
    // Onboarding steps like payout_setup pointed to /craftsman/finance, causing
    // both Profil and Finanzen cards to land on the same screen.
    return {
      to: DEFAULT_HUB_VIEW_MODEL.profil.to,
      subtitle: `${progress.completionPercent}% — ${progress.nextStep.title}`,
    }
  })()

  const auftraege = (() => {
    if (inputs.unassignedJobsCount <= 0) {
      return DEFAULT_HUB_VIEW_MODEL.auftraege
    }
    const count = inputs.unassignedJobsCount
    return {
      to: '/craftsman/jobs?focus=handlungsbedarf',
      subtitle: `${count} ${count === 1 ? 'Auftrag' : 'Aufträge'} ohne Zuweisung`,
    }
  })()

  const team = (() => {
    const active = inputs.teamActiveCount
    const stubs = inputs.teamPendingStubCount
    const highLoad = inputs.teamHighLoadCount

    if (active === 0 && stubs === 0) {
      return {
        to: DEFAULT_HUB_VIEW_MODEL.team.to,
        subtitle: 'Ersten Mitarbeiter anlegen',
      }
    }

    const parts: string[] = [`${active} ${active === 1 ? 'Mitarbeiter' : 'Mitarbeiter'} aktiv`]
    if (stubs > 0) parts.push(`${stubs} ${stubs === 1 ? 'wartet' : 'warten'}`)

    return {
      to: DEFAULT_HUB_VIEW_MODEL.team.to,
      subtitle: parts.join(' · '),
      badge: nonZeroBadge(stubs + highLoad),
    }
  })()

  return {
    ...DEFAULT_HUB_VIEW_MODEL,
    profil,
    auftraege,
    team,
    anfragen: {
      ...DEFAULT_HUB_VIEW_MODEL.anfragen,
      badge: nonZeroBadge(inputs.incomingRequestsCount),
    },
    korrekturen: {
      ...DEFAULT_HUB_VIEW_MODEL.korrekturen,
      badge: nonZeroBadge(inputs.openCorrectionsCount),
    },
    nachrichten: {
      ...DEFAULT_HUB_VIEW_MODEL.nachrichten,
      badge: nonZeroBadge(inputs.unreadInternalThreadsCount),
    },
    benachrichtigungen: {
      ...DEFAULT_HUB_VIEW_MODEL.benachrichtigungen,
      badge: clampUnreadBadge(inputs.unreadNotificationsCount),
    },
  }
}
