/**
 * ProBadge — Block 6
 *
 * Minimal inline badge indicating a Pro-gated action.
 * Shows contextual hint based on effective state.
 */

import type { EffectiveSubscriptionStatus } from '../../lib/subscription/types'

type Props = {
  effectiveState: EffectiveSubscriptionStatus | null
}

export default function ProBadge({ effectiveState }: Props) {
  if (!effectiveState) return null

  if (effectiveState === 'trial_active' || effectiveState === 'active' || effectiveState === 'grace' || effectiveState === 'canceled') {
    return null // no badge when access is full
  }

  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#2563EB]/10 px-2 py-0.5 text-[10px] font-semibold text-[#2563EB]">
      PRO
    </span>
  )
}
