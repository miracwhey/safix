import { mockPayments } from '../mockData.js'
import type { Payment } from '../types.js'
import type { PaymentRepository } from './PaymentRepository.js'

type Listener = () => void

export class InMemoryPaymentRepository implements PaymentRepository {
  private payments: Payment[]
  private readonly listeners = new Set<Listener>()

  constructor(initialData: Payment[] = [...mockPayments]) {
    this.payments = initialData
  }

  async initialize(): Promise<void> {
    // In-memory data is already loaded from mock data at construction time
  }

  isHydrated(): boolean {
    // In-memory repos are always hydrated — data is available at construction
    return true
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getAll(): Payment[] {
    return [...this.payments]
  }

  getByJobId(jobId: string): Payment | undefined {
    return this.payments.find((payment) => payment.jobId === jobId)
  }

  async add(payment: Payment): Promise<void> {
    this.payments = [payment, ...this.payments]
    this.notify()
  }

  async update(paymentId: string, updater: (payment: Payment) => Payment): Promise<void> {
    this.payments = this.payments.map((payment) =>
      payment.id === paymentId ? updater(payment) : payment
    )
    this.notify()
  }

  async finalizeStateAtomic(
    jobId: string,
    targetState: 'released' | 'refunded',
    options?: { disputeId?: string; actor?: string; refundedAmount?: number }
  ): Promise<Payment> {
    const existing = this.payments.find((p) => p.jobId === jobId)
    if (!existing) {
      throw new Error(`finalizeStateAtomic: no payment for job ${jobId}`)
    }
    if (existing.state === targetState) {
      return existing
    }
    const updated: Payment = {
      ...existing,
      state: targetState,
      ...(options?.refundedAmount !== undefined ? { refundedAmount: options.refundedAmount } : {}),
      updatedAt: Date.now(),
    }
    this.payments = this.payments.map((p) => (p.jobId === jobId ? updated : p))
    this.notify()
    return updated
  }
}
