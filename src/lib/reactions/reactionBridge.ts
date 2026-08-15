import { subscribeTimeline, getTimelineSignals } from '../timeline'
import { REACTION_CATEGORY_MAP } from './reactionCategoryMap'
import { emitReactionEvent } from './reactionStore'

let seenSignalIds = new Set<string>()
let unsubscribe: (() => void) | undefined

/**
 * Starts the reaction bridge.
 *
 * Subscribes to the timeline store and emits a DomainReactionEvent for every
 * new timeline signal whose type is covered by REACTION_CATEGORY_MAP.
 *
 * Pre-existing timeline signals are recorded as already-seen so that they do
 * not trigger handlers registered after the bridge starts.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startReactionBridge(): void {
  if (unsubscribe) return

  // Record signals already present so they are not re-emitted.
  const existing = getTimelineSignals()
  for (const signal of existing) {
    seenSignalIds.add(signal.id)
  }

  unsubscribe = subscribeTimeline(() => {
    const current = getTimelineSignals()
    for (const signal of current) {
      if (!seenSignalIds.has(signal.id)) {
        seenSignalIds.add(signal.id)
        const category = REACTION_CATEGORY_MAP[signal.type]
        if (category) {
          emitReactionEvent({
            id: `reaction-${signal.type}-${signal.id}`,
            jobId: signal.jobId,
            type: signal.type,
            category,
            occurredAt: signal.occurredAt,
          })
        }
      }
    }
  })
}

/**
 * Stops the reaction bridge and resets internal state.
 * Primarily useful for testing.
 */
export function stopReactionBridge(): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = undefined
  }
  seenSignalIds = new Set()
}
