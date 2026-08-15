import type { FeatureFlag, FeatureFlagsRepository } from '../types'

/**
 * In-memory feature-flags repository (in-memory data source + tests).
 *
 * Holds an optional static flag set; with none injected every flag resolves as
 * absent, so isFlagEnabled fail-closes and the chat-cutover adapter falls back
 * to its env default — i.e. dev/in-memory behaves exactly as before flags
 * existed. `setFlags` lets tests seed specific flags.
 */
export class InMemoryFeatureFlagsRepository implements FeatureFlagsRepository {
  private flags = new Map<string, FeatureFlag>()
  private hydrated = false
  private readonly listeners = new Set<() => void>()

  constructor(seed: FeatureFlag[] = []) {
    for (const flag of seed) this.flags.set(flag.key, flag)
  }

  initialize(): Promise<void> {
    this.hydrated = true
    return Promise.resolve()
  }

  getFlag(key: string): FeatureFlag | undefined {
    return this.flags.get(key)
  }

  getAllFlags(): FeatureFlag[] {
    return [...this.flags.values()]
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isHydrated(): boolean {
    return this.hydrated
  }

  /** Test/seed helper — replace the flag set and notify subscribers. */
  setFlags(flags: FeatureFlag[]): void {
    this.flags = new Map(flags.map((f) => [f.key, f]))
    this.hydrated = true
    this.listeners.forEach((l) => l())
  }
}
