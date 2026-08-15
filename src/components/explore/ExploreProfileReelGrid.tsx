import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import type { ExploreReel } from '../../lib/explore/exploreTypes'

type Props = {
  reels: ExploreReel[]
}

export default function ExploreProfileReelGrid({ reels }: Props) {
  return (
    <div className="grid grid-cols-3 gap-[2px]">
      {reels.map((reel) => (
        <Link
          key={reel.id}
          to={`/explore?reel=${reel.id}`}
          className="relative bg-slate-900"
        >
          <div className="aspect-[3/4]">
            <img
              src={reel.thumbnailUrl}
              alt={reel.title}
              className="h-full w-full object-cover"
            />

            <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,rgba(0,0,0,0)_0%,rgba(0,0,0,0.45)_100%)] px-2 pb-1.5 pt-6">
              <div className="flex items-center gap-1">
                <Play size={12} fill="white" className="text-white" aria-hidden />
                <span className="text-[11px] font-semibold text-white">
                  {reel.likes >= 1000 ? `${(reel.likes / 1000).toFixed(1)}K` : reel.likes}
                </span>
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
