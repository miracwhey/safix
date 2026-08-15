import type { RuntimeDiagnostic } from '../lib/diagnostics'

type Props = {
  diagnostic: RuntimeDiagnostic | null
}

export default function DiagnosticDebugBlock({ diagnostic }: Props) {
  if (!diagnostic) return null
  if (!import.meta.env.DEV) return null

  return (
    <div className="mt-2 rounded-[14px] bg-slate-900 px-3.5 py-3 text-[11px] text-slate-50 ring-1 ring-slate-800/80">
      <div className="flex items-center justify-between text-[11px] font-semibold">
        <span>Debug</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-amber-200">
          {diagnostic.source}
        </span>
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-snug text-slate-200">
        <DebugRow label="Step" value={diagnostic.step} />
        {diagnostic.name && <DebugRow label="Name" value={diagnostic.name} />}
        <DebugRow label="Message" value={diagnostic.message} />
        {diagnostic.code != null && <DebugRow label="Code" value={String(diagnostic.code)} />}
        {diagnostic.details !== undefined && diagnostic.details !== null && (
          <DebugRow label="Details" value={stringifyMaybeObject(diagnostic.details)} />
        )}
        {diagnostic.hint && <DebugRow label="Hint" value={diagnostic.hint} />}
        <DebugRow label="Raw" value={diagnostic.raw} />
      </div>
    </div>
  )
}

function DebugRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <span className="break-words text-left text-[11px] text-slate-100">{value}</span>
    </div>
  )
}

function stringifyMaybeObject(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
