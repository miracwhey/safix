// @deprecated — use Surface + StickyBottomAction from src/components/primitives
type ActionCardProps = {
  titleTop: string;
  titleBottom: string;
  subtitle: string;
  buttonText: string;
};

export default function ActionCard({
  titleTop,
  titleBottom,
  subtitle,
  buttonText,
}: ActionCardProps) {
  return (
    <div
      className="
        relative overflow-hidden rounded-[28px]
        bg-white
        ring-1 ring-slate-200/70
        shadow-soft-xl
        transition-transform duration-200
        active:scale-[0.99]
      "
      style={{
        boxShadow:
          "0 18px 40px -28px rgba(2,6,23,0.55), 0 2px 10px -6px rgba(2,6,23,0.18)",
      }}
    >
      {/* Material highlight + subtle depth */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-slate-50/80 via-white to-white opacity-90" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-slate-100/40" />

      {/* subtle left accent (premium contrast without being loud) */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-blue-500/70 via-blue-500/30 to-transparent" />

      <div className="relative p-4">
        <div className="flex items-center gap-4">
          {/* Icon */}
          <div
            className="
              flex h-14 w-14 items-center justify-center
              rounded-2xl bg-blue-600
              ring-1 ring-white/20
            "
            style={{
              boxShadow:
                "0 18px 34px -22px rgba(37,99,235,0.95), 0 6px 16px -12px rgba(2,6,23,0.35)",
            }}
          >
            <span className="text-[22px] text-white">🧾</span>
          </div>

          {/* Text */}
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-extrabold leading-[1.05] text-slate-950">
              {titleTop}
              <br />
              {titleBottom}
            </div>
            <div className="mt-1.5 text-[13px] leading-snug text-slate-600">
              {subtitle}
            </div>
          </div>

          {/* CTA + Arrow */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="
                rounded-xl bg-[#0b1220] px-4 py-2
                text-[12px] font-extrabold tracking-[0.18em] text-white
                ring-1 ring-white/10
                transition-transform duration-200
                active:scale-[0.98]
              "
              style={{
                boxShadow:
                  "0 14px 28px -18px rgba(2,6,23,0.75), 0 2px 10px -8px rgba(2,6,23,0.25)",
              }}
            >
              {buttonText}
            </button>

            <span className="text-slate-300 text-[20px] leading-none">›</span>
          </div>
        </div>
      </div>
    </div>
  );
}
