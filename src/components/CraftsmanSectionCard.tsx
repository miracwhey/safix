// @deprecated — use ContentSection from src/components/primitives
import type { ReactNode } from 'react';

type CraftsmanSectionCardProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  children?: ReactNode;
};

export default function CraftsmanSectionCard({
  eyebrow,
  title,
  subtitle,
  headerRight,
  children,
}: CraftsmanSectionCardProps) {
  return (
    <section className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)]">
      {eyebrow ? (
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          {eyebrow}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <h2 className="text-[22px] font-semibold text-slate-900">{title}</h2>
        {headerRight ?? null}
      </div>

      {subtitle ? (
        <p className="mt-2 text-[14px] text-slate-500">{subtitle}</p>
      ) : null}

      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}
