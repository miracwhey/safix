import type { Payment } from './types.js'

export const mockPayments: Payment[] = [
  {
    id: 'payment_1',
    jobId: 'job-1',
    state: 'disputed',
    amounts: {
      totalAmount: 2000,
      depositAmount: 500,
      finalAmount: 1500,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'payment_2',
    jobId: 'job-2',
    state: 'deposit_required',
    amounts: {
      totalAmount: 1200,
      depositAmount: 300,
      finalAmount: 900,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'payment_3',
    jobId: 'job-3',
    state: 'released',
    amounts: {
      totalAmount: 3500,
      depositAmount: 1000,
      finalAmount: 2500,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'payment_4',
    jobId: 'job-4',
    state: 'release_pending',
    amounts: {
      totalAmount: 290,
      depositAmount: 73,
      finalAmount: 217,
    },
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
    updatedAt: Date.now() - 1000 * 60 * 60 * 12,
  },
  {
    id: 'payment_5',
    jobId: 'job-5',
    state: 'released',
    amounts: {
      totalAmount: 510,
      depositAmount: 128,
      finalAmount: 382,
    },
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 8,
    updatedAt: Date.now() - 1000 * 60 * 60 * 24,
  },
]
