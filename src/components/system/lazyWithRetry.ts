import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * `React.lazy` with a bounded auto-retry on a failed dynamic `import()`.
 *
 * A code-split chunk fetch can reject for two reasons:
 *   1. A transient network blip (flaky mobile connection) — a short retry
 *      usually succeeds.
 *   2. A stale-chunk 404: a redeploy rotated the hashed chunk filenames, but
 *      the running tab still holds the previous `index.html` referencing the
 *      old URL. Re-importing the same URL keeps 404-ing — only a full reload
 *      of `index.html` recovers it. That reload is offered by the nearest
 *      `TabErrorBoundary` once this factory finally throws.
 *
 * React caches the lazy factory's settled promise, so a rejected import cannot
 * be re-attempted by simply re-rendering the component — the retry must live
 * INSIDE the factory. After `retries` failed attempts the error propagates to
 * the tab-scoped error boundary (NOT the app-wide one), so a single failed
 * tab chunk never blanks the whole authenticated shell.
 *
 * Native (Capacitor) bundles chunks locally, so this path effectively only
 * ever fires on web.
 */
// `ComponentType<any>` mirrors React's own `lazy` signature — screens have
// heterogeneous (all-optional) prop shapes and `unknown` props are not
// contravariantly assignable, so a narrower type rejects valid components.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  { retries = 2, delayMs = 400 }: { retries?: number; delayMs?: number } = {},
): LazyExoticComponent<T> {
  return lazy(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await factory()
      } catch (error) {
        lastError = error
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
        }
      }
    }
    throw lastError
  })
}
