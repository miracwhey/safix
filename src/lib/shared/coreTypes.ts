export type EntityId = string
export type TimestampMs = number

export type UserRole = 'customer' | 'craftsman' | 'worker'

export type JobStatus =
  | 'new'
  | 'booked'
  | 'scheduled'
  | 'in_progress'
  | 'waiting_payment'
  | 'completed'
  | 'cancelled'

export type PaymentState =
  | 'none'
  | 'deposit_required'
  | 'deposit_paid'
  | 'in_escrow'
  | 'work_in_progress'
  | 'release_pending'
  | 'released'
  | 'disputed'
  | 'refunded'
  // Diagnosis-specific payment states — separate from standard escrow flow
  | 'diagnosis_payment_pending'
  | 'diagnosis_payment_completed'

export type CurrencyCode = 'EUR'

export type MoneyAmount = {
  amount: number
  currency: CurrencyCode
}
