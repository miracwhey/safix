type CraftsmanInfoRowProps = {
  label: string;
  value: string;
};

export default function CraftsmanInfoRow({
  label,
  value,
}: CraftsmanInfoRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="max-w-[60%] text-right text-[15px] font-medium text-slate-900">
        {value}
      </div>
    </div>
  );
}
