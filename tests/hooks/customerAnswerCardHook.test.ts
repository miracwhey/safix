// @vitest-environment jsdom
/**
 * useCustomerAnswerCard — live-hook behavioral repros (Block 6).
 *
 * Drives the REAL hook via renderHook against seeded in-memory repositories —
 * the behavioral counterpart to the Block-1 structural guards. Proves end to
 * end through the live subscriptions + memo:
 *   • dispute fires the loud tone (the prior hard-coded `disputeStatus=undefined`
 *     regression),
 *   • funded truth produces a calm tone — never a stale loud "Zahlung leisten",
 *   • a payable deposit deep-links to funding,
 *   • a job-less project is NUDGE,
 *   • isHydrated reflects repository hydration.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { setupCleanRepositories } from '../helpers/setupRepositories'

// The vitest-jsdom localStorage in this repo is non-functional, and
// src/lib/supabase.ts captures `window.localStorage` at createClient time
// (isBrowser=true under jsdom). Install a working stub via vi.hoisted — which
// runs BEFORE the imports below — so the Supabase auth client captures it
// instead of the broken jsdom one.
vi.hoisted(() => {
  const store: Record<string, string> = {}
  const memoryStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v)
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: memoryStorage })
  }
})

import { addJob } from '../../src/lib/jobs'
import { addProject } from '../../src/lib/projects'
import { getFundingRequestRepository } from '../../src/lib/payments/fundingRequest/fundingRequestRegistry'
import { getDisputeRepository } from '../../src/lib/disputes/repository'
import { useCustomerAnswerCard } from '../../src/hooks/useHomeState'

import type { Job } from '../../src/lib/jobs/types'
import type { Project } from '../../src/lib/projects/projectTypes'
import type { FundingRequest, FundingRequestStatus } from '../../src/lib/payments/fundingRequest/types'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const ISO = new Date(NOW).toISOString()

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', projectId: 'project-1', title: 'Test Job', customer: 'Max',
    location: 'Hannover', dateLabel: 'Morgen', status: 'new', amount: '5.000 €',
    description: 'Bad', paymentState: 'none', documentationStatus: '',
    assignedMemberIds: [], notes: [], photoCount: 0, activities: [],
    craftsmanUserId: 'craftsman-1', customerUserId: 'customer-1', ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1', sourceJobId: 'job-1', title: 'Bad Reno', customer: 'Max',
    craftsman: 'Müller', location: 'Hannover', dateLabel: 'Morgen', price: '5.000 €',
    status: 'request', paymentState: 'none', category: 'Bad', messageCount: 0,
    noteCount: 0, photoCount: 0, createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

function seedFunding(jobId: string, status: FundingRequestStatus, id: string) {
  const fr: FundingRequest = {
    id, sourceOfferId: 'offer-1', jobId, escrowPlanId: 'ep-1',
    customerUserId: 'customer-1', providerId: 'provider-1', providerUserId: 'craftsman-1',
    type: 'full_escrow', status, amount: 5000, currency: 'EUR', createdBy: 'provider',
    createdAt: NOW, updatedAt: NOW, ...(status === 'funded' ? { fundedAt: NOW } : {}),
  }
  getFundingRequestRepository().add(fr)
}

async function seedOpenDispute(jobId: string) {
  await getDisputeRepository().add({
    id: 'disp-1', jobId, status: 'open', reason: 'work_quality',
    title: 'Streit', description: 'Konflikt', createdAt: ISO, updatedAt: ISO,
  })
}

function accepted(overrides: Partial<Job> = {}): Job {
  return makeJob({ status: 'new', proposalSentAt: NOW - 48 * HOUR, proposalAcceptedAt: NOW - 24 * HOUR, ...overrides })
}

beforeEach(() => setupCleanRepositories())
afterEach(cleanup)

describe('useCustomerAnswerCard — live hook', () => {
  it('open dispute fires the loud tone (regression: was hard-coded undefined)', async () => {
    addJob(accepted({ paymentState: 'in_escrow' }))
    addProject(makeProject())
    await seedOpenDispute('job-1')

    const { result } = renderHook(() => useCustomerAnswerCard())
    expect(result.current.model?.tone).toBe('loud')
    expect(result.current.model?.iconKey).toBe('dispute')
  })

  it('funded truth → calm tone, escrow confirmed (never stale "Zahlung leisten")', () => {
    addJob(accepted({ paymentState: 'deposit_required' }))
    addProject(makeProject({ paymentState: 'deposit_required' }))
    seedFunding('job-1', 'funded', 'fr-funded')

    const { result } = renderHook(() => useCustomerAnswerCard())
    expect(result.current.model?.tone).toBe('calm')
    expect(result.current.model?.escrowConfirmed).toBe(true)
    expect(result.current.model?.label).not.toBe('Zahlung leisten')
  })

  it('payable deposit → loud, deep-links to /funding/:id', () => {
    addJob(accepted({ paymentState: 'deposit_required' }))
    addProject(makeProject({ paymentState: 'deposit_required' }))
    seedFunding('job-1', 'sent', 'fr-pay')

    const { result } = renderHook(() => useCustomerAnswerCard())
    expect(result.current.model?.tone).toBe('loud')
    expect(result.current.model?.route.to).toBe('/funding/fr-pay')
  })

  it('project without a linked job → NUDGE, hydrated', () => {
    addProject(makeProject({ sourceJobId: '', status: 'request', paymentState: 'none' }))

    const { result } = renderHook(() => useCustomerAnswerCard())
    expect(result.current.model?.tone).toBe('nudge')
    expect(result.current.isHydrated).toBe(true)
  })

  it('no active project → no top project, no model', () => {
    const { result } = renderHook(() => useCustomerAnswerCard())
    expect(result.current.topProject).toBeNull()
    expect(result.current.model).toBeNull()
    expect(result.current.activeProjectCount).toBe(0)
  })

  it('LIVE recompute on funding transition — tone does NOT freeze (the freeze fix)', async () => {
    addJob(accepted({ paymentState: 'deposit_required' }))
    addProject(makeProject({ paymentState: 'deposit_required' }))
    seedFunding('job-1', 'sent', 'fr-flip')

    const { result } = renderHook(() => useCustomerAnswerCard())
    // Pre-transition: payable deposit is loud.
    expect(result.current.model?.tone).toBe('loud')
    expect(result.current.model?.escrowConfirmed).toBe(false)

    // Mutate the funding repo AFTER render → subscription → paymentsTick → memo
    // recompute, with NO manual rerender. If the subscriptions/bump were broken
    // (the freeze bug), the tone would stay 'loud' here.
    await act(async () => {
      await getFundingRequestRepository().update('fr-flip', (r) => ({
        ...r,
        status: 'funded',
        fundedAt: NOW,
      }))
    })

    expect(result.current.model?.tone).toBe('calm')
    expect(result.current.model?.escrowConfirmed).toBe(true)
    expect(result.current.model?.label).not.toBe('Zahlung leisten')
  })
})
