import type { ChatChannelType } from '../../lib/chat'
import { channelStyle } from './chatChannelStyle'

export function ChannelBadge({ channelType }: { channelType: ChatChannelType }) {
  const s = channelStyle(channelType)
  return (
    <span
      className={`shrink-0 text-[9.5px] font-bold tracking-[0.04em] px-[6px] py-[2px] rounded-full uppercase ${s.pillBgClass} ${s.pillTextClass}`}
    >
      {s.label}
    </span>
  )
}
