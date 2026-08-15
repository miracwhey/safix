import type { ReactNode } from 'react';

type CraftsmanDetailActionCardProps = {
  title: string;
  subtitle: string;
  children?: ReactNode;
};

export default function CraftsmanDetailActionCard({
  title,
  subtitle,
  children,
}: CraftsmanDetailActionCardProps) {
  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      <h3 className="text-[18px] font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-[14px] text-slate-500">{subtitle}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </section>
  );
}
