import { useState } from 'react'

type AvatarSize = 'sm' | 'md' | 'lg'

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'h-9 w-9 text-[12px]',
  md: 'h-11 w-11 text-[13px]',
  lg: 'h-14 w-14 text-[15px]',
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  const compact = name.replace(/\s+/g, '')
  return (compact.slice(0, 2) || '?').toUpperCase()
}

type Props = {
  src?: string | null
  name: string
  size?: AvatarSize
  className?: string
}

export default function Avatar({
  src,
  name,
  size = 'md',
  className = '',
}: Props) {
  const [loadFailed, setLoadFailed] = useState(false)
  const showImage = Boolean(src) && !loadFailed
  const sizeClass = sizeClasses[size]

  if (showImage) {
    return (
      <img
        src={src ?? undefined}
        alt={name}
        onError={() => setLoadFailed(true)}
        className={[
          'rounded-full object-cover ring-1 ring-slate-200/70',
          sizeClass,
          className,
        ].join(' ')}
      />
    )
  }

  const initials = getInitials(name || '?')

  return (
    <div
      className={[
        'flex items-center justify-center rounded-full bg-slate-100 text-slate-600 ring-1 ring-slate-200/70 font-semibold uppercase',
        sizeClass,
        className,
      ].join(' ')}
      aria-label={`Avatar für ${name}`}
    >
      <span className="leading-none">{initials}</span>
    </div>
  )
}
