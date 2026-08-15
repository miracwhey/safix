import type { PaymentState } from '../shared/coreTypes.js'

export const allowedTransitions: Record<PaymentState, PaymentState[]> = {
  // Standard escrow path
  none: ['deposit_required'],
  deposit_required: ['deposit_paid'],
  deposit_paid: ['in_escrow', 'refunded'],
  in_escrow: ['work_in_progress', 'disputed', 'refunded'],
  work_in_progress: ['release_pending', 'disputed'],
  release_pending: ['released', 'disputed', 'refunded'],
  released: [],
  disputed: ['refunded', 'released', 'release_pending'],
  refunded: [],
  // Diagnosis instant-payment path — separate from escrow
  diagnosis_payment_pending: ['diagnosis_payment_completed', 'refunded'],
  diagnosis_payment_completed: [],
}

export function canTransition(
  from: PaymentState,
  to: PaymentState
): boolean {
  return allowedTransitions[from].includes(to)
}
