/**
 * Test utility: generates guaranteed unique IDs for test isolation.
 *
 * Problem: If crypto.randomUUID() is ever mocked with a fixed value
 * (e.g., for snapshot testing), media upload tests will fail with
 * duplicate primary key violations because multiple uploads in the same
 * test would share the same ID.
 *
 * Solution: This utility wraps crypto.randomUUID() with a counter suffix
 * when running in tests, ensuring every call returns a unique value.
 *
 * Usage: Import and call `uniqueTestId()` instead of `crypto.randomUUID()`
 * in test helper functions that create media uploads or other entities
 * with UUID primary keys.
 *
 * Note: This is ONLY for test helpers. Production code should continue
 * using crypto.randomUUID() directly.
 */

let counter = 0

/**
 * Generates a unique UUID-format ID for use in tests.
 * Each call increments a counter to guarantee uniqueness.
 */
export function uniqueTestId(): string {
  const base = crypto.randomUUID()
  counter++
  // Append counter as a suffix while maintaining UUID format
  // Replace last 4 characters with zero-padded counter
  const suffix = counter.toString(16).padStart(4, '0').slice(-4)
  return base.slice(0, -4) + suffix
}

/**
 * Resets the counter. Call in beforeEach to ensure test isolation.
 */
export function resetUniqueIdCounter(): void {
  counter = 0
}
