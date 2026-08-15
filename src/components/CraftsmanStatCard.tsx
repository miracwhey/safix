type CraftsmanStatCardProps = {
  title: string;
  value: string;
  subtitle: string;
  highlight?: boolean;
};

export default function CraftsmanStatCard({
  title,
  value,
  subtitle,
  highlight = false,
}: CraftsmanStatCardProps) {
  return (
    <div
      className={[
        'rounded-[28px] p-5 ring-1 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.35)]',
        highlight
          ? 'bg-[#2563EB] text-white ring-[#2563EB]/40'
          : 'bg-white text-slate-900 ring-slate-200/70',
      ].join(' ')}
    >
      <div
        className={[
          'text-[12px] font-semibold uppercase tracking-[0.18em]',
          highlight ? 'text-white/75' : 'text-slate-400',
        ].join(' ')}
      >
        {title}
      </div>

      <div className="mt-4 text-[22px] font-semibold leading-none">{value}</div>

      <div
        className={[
          'mt-3 text-[14px]',
          highlight ? 'text-white/80' : 'text-slate-500',
        ].join(' ')}
      >
        {subtitle}
      </div>
    </div>
  );
}
