/**
 * Channel-cue mapping (ADR D-2). Cue lives in avatar-ring + channel-pill +
 * 3 px stripe — not in bubble background. App stays SaFix-blue-coherent.
 */

import type { ChatChannelType } from '../../lib/chat'

export interface ChannelStyle {
  ringClass: string
  pillBgClass: string
  pillTextClass: string
  stripeClass: string
  avatarClass: string
  label: string
}

const STYLES: Record<ChatChannelType, ChannelStyle> = {
  customer: {
    ringClass: 'ring-blue-400',
    pillBgClass: 'bg-blue-50',
    pillTextClass: 'text-blue-700',
    stripeClass: 'bg-blue-400',
    avatarClass: 'bg-gradient-to-br from-blue-100 to-blue-300 text-blue-900',
    label: 'Kunde',
  },
  office: {
    ringClass: 'ring-slate-400',
    pillBgClass: 'bg-slate-100',
    pillTextClass: 'text-slate-600',
    stripeClass: 'bg-slate-400',
    avatarClass: 'bg-slate-100 text-slate-600',
    label: 'Büro',
  },
  team: {
    ringClass: 'ring-emerald-400',
    pillBgClass: 'bg-emerald-50',
    pillTextClass: 'text-emerald-700',
    stripeClass: 'bg-emerald-400',
    avatarClass: 'bg-emerald-50 text-emerald-700',
    label: 'Team',
  },
  assignment: {
    ringClass: 'ring-amber-400',
    pillBgClass: 'bg-amber-50',
    pillTextClass: 'text-amber-700',
    stripeClass: 'bg-amber-400',
    avatarClass: 'bg-amber-50 text-amber-800',
    label: 'Einsatz',
  },
  dispute: {
    ringClass: 'ring-rose-400',
    pillBgClass: 'bg-rose-50',
    pillTextClass: 'text-rose-700',
    stripeClass: 'bg-rose-400',
    avatarClass: 'bg-red-50 text-red-700',
    label: 'Streit',
  },
  direct: {
    ringClass: 'ring-indigo-400',
    pillBgClass: 'bg-indigo-50',
    pillTextClass: 'text-indigo-700',
    stripeClass: 'bg-indigo-400',
    avatarClass: 'bg-gradient-to-br from-indigo-100 to-blue-300 text-indigo-900',
    label: 'Direkt',
  },
}

export function channelStyle(channel: ChatChannelType): ChannelStyle {
  return STYLES[channel]
}
