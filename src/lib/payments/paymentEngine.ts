import type { Payment, PaymentState } from './types.js'
import { canTransition } from './stateMachine.js'

function transitionPayment(
  payment: Payment,
  nextState: PaymentState
): Payment {
  if (!canTransition(payment.state, nextState)) {
    throw new Error(
      `Illegal payment transition: ${payment.state} → ${nextState}`
    )
  }

  return {
    ...payment,
    state: nextState,
    updatedAt: Date.now(),
  }
}

export function markDepositPaid(payment: Payment): Payment {
  return transitionPayment(payment, 'deposit_paid')
}

export function lockEscrow(payment: Payment): Payment {
  return transitionPayment(payment, 'in_escrow')
}

export function startWork(payment: Payment): Payment {
  return transitionPayment(payment, 'work_in_progress')
}

export function requestRelease(payment: Payment): Payment {
  return transitionPayment(payment, 'release_pending')
}

export function releasePayment(payment: Payment): Payment {
  return transitionPayment(payment, 'released')
}

export function openDispute(payment: Payment): Payment {
  return transitionPayment(payment, 'disputed')
}

export function refundPayment(payment: Payment): Payment {
  return transitionPayment(payment, 'refunded')
}
