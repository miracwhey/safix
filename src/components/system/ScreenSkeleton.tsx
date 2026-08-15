type Props = {
  /** Layout variant matching the screen being loaded. */
  variant?: 'detail' | 'list' | 'chat'
  /** Optional eyebrow label shown above the shimmer bars. */
  eyebrow?: string
  /** Number of shimmer lines in the primary card (detail variant only). */
  lines?: number
}

/**
 * Structure-retaining loading skeleton for corridor screens.
 *
 * Does NOT wrap in AppShell — the calling screen provides that.
 *
 * Shimmer is the canonical diagonal sweep (`.fx-skeleton`, Loading-Patterns
 * handoff) — one system instead of the old `animate-pulse` + 3 parallel
 * shimmer keyframes. Placeholder blocks use the shared `--skel-base` token;
 * reduced-motion falls back to a static tint (handled in index.css).
 */

/** A single grey placeholder block. Color comes from the shared skel token. */
function Bar({ className }: { className?: string }) {
  return <div className={`rounded-lg bg-[var(--skel-base)] ${className ?? ''}`} />
}

/** Card shell that clips + hosts the shimmer sweep. */
function SkeletonCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`fx-skeleton relative overflow-hidden rounded-[28px] bg-white ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ${className ?? ''}`}
    >
      {children}
    </div>
  )
}

function DetailSkeleton({ eyebrow, lines = 3 }: { eyebrow?: string; lines?: number }) {
  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4">
      <SkeletonCard className="p-5">
        {eyebrow && (
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {eyebrow}
          </div>
        )}
        <div className="space-y-3">
          {Array.from({ length: lines }, (_, i) => (
            <Bar
              key={i}
              className={`h-3 ${i === 0 ? 'w-3/4' : i === lines - 1 ? 'w-2/3' : 'w-full'}`}
            />
          ))}
        </div>
      </SkeletonCard>
      <SkeletonCard className="p-5">
        <Bar className="mb-3 h-4 w-1/2" />
        <Bar className="mb-2 h-3 w-full" />
        <Bar className="h-3 w-5/6" />
      </SkeletonCard>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[420px] space-y-3">
      {[0, 1, 2].map((i) => (
        <SkeletonCard key={i} className="flex items-center gap-3 p-4">
          <Bar className="h-10 w-10 shrink-0 !rounded-full" />
          <div className="flex-1 space-y-2">
            <Bar className="h-3.5 w-2/3" />
            <Bar className="h-3 w-full" />
          </div>
        </SkeletonCard>
      ))}
    </div>
  )
}

function ChatSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[420px]">
      <SkeletonCard className="flex flex-col gap-3 p-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Bar className="h-9 w-9 shrink-0 !rounded-full" />
          <Bar className="h-4 w-32" />
        </div>
        {/* Message bubbles */}
        <div className="space-y-3 pt-2">
          <Bar className="ml-auto h-10 w-3/5 !rounded-[18px]" />
          <Bar className="h-14 w-4/5 !rounded-[18px]" />
          <Bar className="ml-auto h-10 w-2/5 !rounded-[18px]" />
        </div>
        {/* Input bar */}
        <Bar className="mt-2 h-11 w-full !rounded-full" />
      </SkeletonCard>
    </div>
  )
}

export default function ScreenSkeleton({ variant = 'detail', eyebrow, lines }: Props) {
  return (
    <section className="px-4 pt-6 pb-8" role="status" aria-label="Wird geladen…">
      {variant === 'list' && <ListSkeleton />}
      {variant === 'chat' && <ChatSkeleton />}
      {variant === 'detail' && <DetailSkeleton eyebrow={eyebrow} lines={lines} />}
    </section>
  )
}
