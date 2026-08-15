/**
 * In-memory implementation of EscrowPlanRepository.
 *
 * Used in tests and local development.  Starts with an empty data set
 * (no mock data) — each test wires up its own state via setupCleanRepositories().
 */

import type { EscrowPaymentPlan, EscrowTranche } from './escrowTypes.js'
import type { EscrowPlanRepository } from './escrowRepository.js'

type Listener = () => void

export class InMemoryEscrowPlanRepository implements EscrowPlanRepository {
  private plans: EscrowPaymentPlan[]
  private tranches: EscrowTranche[]
  private readonly listeners = new Set<Listener>()

  constructor(initialPlans: EscrowPaymentPlan[] = [], initialTranches: EscrowTranche[] = []) {
    this.plans = [...initialPlans]
    this.tranches = [...initialTranches]
  }

  async initialize(): Promise<void> {
    // In-memory — nothing to load
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn())
  }

  // ── Plans ──────────────────────────────────────────────────────────────

  getAllPlans(): EscrowPaymentPlan[] {
    return [...this.plans]
  }

  getPlanById(planId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.id === planId)
  }

  getPlanByOfferId(offerId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.sourceOfferId === offerId)
  }

  getPlanByJobId(jobId: string): EscrowPaymentPlan | undefined {
    return this.plans.find((p) => p.jobId === jobId)
  }

  async addPlan(plan: EscrowPaymentPlan): Promise<void> {
    this.plans = [plan, ...this.plans]
    this.notify()
  }

  async updatePlan(planId: string, updater: (p: EscrowPaymentPlan) => EscrowPaymentPlan): Promise<void> {
    this.plans = this.plans.map((p) => (p.id === planId ? updater(p) : p))
    this.notify()
  }

  // ── Tranches ───────────────────────────────────────────────────────────

  getTranchesForPlan(planId: string): EscrowTranche[] {
    return this.tranches.filter((t) => t.planId === planId)
  }

  async addTranche(tranche: EscrowTranche): Promise<void> {
    this.tranches = [tranche, ...this.tranches]
    this.notify()
  }

  async updateTranche(trancheId: string, updater: (t: EscrowTranche) => EscrowTranche): Promise<void> {
    this.tranches = this.tranches.map((t) => (t.id === trancheId ? updater(t) : t))
    this.notify()
  }

  // ── Subscription ───────────────────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
