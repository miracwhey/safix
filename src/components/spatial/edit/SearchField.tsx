/**
 * Spatial · Edit · SearchField (Mockup 42 §3 · persistent search)
 *
 * The always-visible search field of the Material-Picker. Focused state shows
 * a brand ring; a clear button appears only when there is text.
 */

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  onClear: () => void
  /** Scope-aware placeholder, e.g. "In Wand-Materials suchen". */
  placeholder: string
}

export function SearchField({ value, onChange, onClear, placeholder }: SearchFieldProps) {
  return (
    <div className="group flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-slate-900/10 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-600">
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="size-4 shrink-0 text-slate-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="9" cy="9" r="6" />
        <path d="m18 18-4.5-4.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-900 outline-none placeholder:text-slate-400 [&::-webkit-search-cancel-button]:hidden"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Suche löschen"
          className="shrink-0 rounded-full p-0.5 text-slate-400 active:scale-90 hover:text-slate-600"
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="currentColor">
            <path d="M10 8.586 6.707 5.293 5.293 6.707 8.586 10l-3.293 3.293 1.414 1.414L10 11.414l3.293 3.293 1.414-1.414L11.414 10l3.293-3.293-1.414-1.414L10 8.586Z" />
          </svg>
        </button>
      )}
    </div>
  )
}
