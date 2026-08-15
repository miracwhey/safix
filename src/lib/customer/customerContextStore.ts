/**
 * In-memory store for customer-level context.
 *
 * Holds setup information the customer provides about themselves so it can
 * pre-fill request flows (inquiry location, display name used in messages).
 *
 * Follows the same listener-notification pattern used by every other store in
 * this codebase (projectsStore, jobsStore, etc.).
 */

export type CustomerContext = {
  /** How the customer wants to be addressed in messages and the UI. */
  displayName: string
  /** City or district the customer is based in — pre-fills request location. */
  city: string
  /** Public URL of the customer's profile picture (null = no picture set). */
  avatarUrl: string | null
}

type Listener = () => void

const DEFAULT_CONTEXT: CustomerContext = {
  displayName: '',
  city: '',
  avatarUrl: null,
}

let context: CustomerContext = { ...DEFAULT_CONTEXT }
const listeners = new Set<Listener>()

function notify() {
  listeners.forEach((l) => l())
}

/** Subscribe to context changes. Returns an unsubscribe function. */
export function subscribeCustomerContext(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Read the current customer context snapshot. */
export function getCustomerContext(): CustomerContext {
  return context
}

/**
 * Merge partial updates into the customer context and notify listeners.
 * Accepts a partial object so callers can update only one field at a time.
 */
export function updateCustomerContext(
  updates: Partial<CustomerContext>
): void {
  context = { ...context, ...updates }
  notify()
}

/** Reset context to defaults and notify listeners. Call on logout / user switch. */
export function resetCustomerContext(): void {
  context = { ...DEFAULT_CONTEXT }
  notify()
}
