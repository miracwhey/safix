import { getFeedbackByCraftsmanId } from './feedbackStore'

/**
 * Returns the number of feedbacks where the customer said they would hire
 * the craftsman again.
 */
export function getWouldHireAgainCount(craftsmanUserId: string): number {
  return getFeedbackByCraftsmanId(craftsmanUserId).filter((f) => f.wouldHireAgain).length
}

/**
 * Returns the total number of feedbacks submitted for a craftsman.
 */
export function getTotalFeedbackCount(craftsmanUserId: string): number {
  return getFeedbackByCraftsmanId(craftsmanUserId).length
}

/**
 * Derives a "would hire again" rate (0–1) for a craftsman.
 * Returns `undefined` when there are no feedbacks yet.
 */
export function deriveWouldHireAgainRate(craftsmanUserId: string): number | undefined {
  const feedbacks = getFeedbackByCraftsmanId(craftsmanUserId)
  if (feedbacks.length === 0) return undefined
  const positives = feedbacks.filter((f) => f.wouldHireAgain).length
  return positives / feedbacks.length
}
