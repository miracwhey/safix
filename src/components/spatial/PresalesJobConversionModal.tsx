/**
 * Spatial · Presales · PresalesJobConversionModal (V1.5 · Phase B-P3)
 *
 * Modal opened from the PresalesProjectsScreen card "Als Projekt anlegen" CTA
 * (and from the spatial detail screen post-quote). Collects the customer-side
 * fields and triggers {@link createJobFromPresalesProject}.
 *
 * Drafts (`customer_*_draft`, `notes`) prefill the form. On success the host
 * navigates to the new job's spatial detail; idempotency is handled by the
 * workflow (`alreadyExisted` returns the existing jobId).
 *
 * Host contract: keep this MOUNTED and toggle `open`. Backdrop / Escape dismiss
 * are no-ops while submitting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { createJobFromPresalesProject } from '../../lib/presales/workflow/createJobFromPresalesProject'
import type { PresalesProject } from '../../domain/presales/presalesProjectTypes'
import { useToast } from '../../hooks/useToast'
import { useHaptics } from '../../hooks/useHaptics'
import { useFocusTrap } from '../../lib/spatial/hooks/useFocusTrap'

/**
 * Host contract: render conditionally — `{convertTarget && <Modal … />}`. The
 * modal seeds its form from `project` on mount; remounting on every open keeps
 * a transient draft from leaking across opens without a sync-effect.
 */
export interface PresalesJobConversionModalProps {
  project: PresalesProject
  onClose: () => void
  /** Called after the workflow returns ok=true. `alreadyExisted` flags an
   *  idempotent return so the host can show a softer toast / skip a redirect. */
  onSuccess: (jobId: string, alreadyExisted: boolean) => void
}

const MODAL_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.92)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 24px 60px rgba(15,23,42,0.28), 0 1px 0 rgba(255,255,255,0.6) inset',
}

interface FormState {
  customerName: string
  customerEmail: string
  customerPhone: string
  dateLabel: string
  description: string
  amount: string
}

function buildInitial(project: PresalesProject): FormState {
  return {
    customerName: project.customerNameDraft ?? '',
    customerEmail: project.customerEmailDraft ?? '',
    customerPhone: project.customerPhoneDraft ?? '',
    dateLabel: '',
    description: project.notes ?? '',
    amount: '',
  }
}

export function PresalesJobConversionModal({
  project,
  onClose,
  onSuccess,
}: PresalesJobConversionModalProps) {
  const toast = useToast()
  const haptics = useHaptics()
  const [form, setForm] = useState<FormState>(() => buildInitial(project))
  const [submitting, setSubmitting] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)
  const firstFieldCb = useCallback((node: HTMLInputElement | null) => {
    if (node) node.focus()
  }, [])
  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  // Escape dismisses unless submitting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [submitting, onClose])

  const onChange = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }))
      if (key === 'customerName' && nameError) setNameError(null)
    },
    [nameError],
  )

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (submitting) return
      const customerName = form.customerName.trim()
      if (!customerName) {
        setNameError('Kundenname ist erforderlich.')
        haptics.error()
        firstFieldRef.current?.focus()
        return
      }
      setSubmitting(true)
      const result = await createJobFromPresalesProject({
        presalesProjectId: project.id,
        customerName,
        customerEmail: form.customerEmail.trim() || undefined,
        customerPhone: form.customerPhone.trim() || undefined,
        dateLabel: form.dateLabel.trim() || undefined,
        description: form.description.trim() || undefined,
        amount: form.amount.trim() || undefined,
      })
      if (!result.ok) {
        setSubmitting(false)
        if (result.reason === 'invalid_input') {
          setNameError(result.message)
          firstFieldRef.current?.focus()
        } else {
          toast.error(result.message)
        }
        haptics.error()
        return
      }
      haptics.success()
      onSuccess(result.jobId, result.alreadyExisted)
      // Host closes (so the form doesn't reset before navigation).
    },
    [submitting, project, form, haptics, toast, onSuccess],
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(3px)' }}
      onClick={() => {
        if (!submitting) onClose()
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="presales-convert-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-[460px] flex-col rounded-t-[28px] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 sm:rounded-[24px]"
        style={MODAL_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15 sm:hidden" />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="presales-convert-title" className="text-[20px] font-bold tracking-tight text-slate-900">
              Als Projekt anlegen
            </h2>
            <p className="mt-0.5 truncate text-[12.5px] text-slate-500">
              Aufmaß: <span className="font-semibold text-slate-700">{project.title}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90 disabled:opacity-40"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
              <path d="M10 8.586 6.707 5.293 5.293 6.707 8.586 10l-3.293 3.293 1.414 1.414L10 11.414l3.293 3.293 1.414-1.414L11.414 10l3.293-3.293-1.414-1.414L10 8.586Z" />
            </svg>
          </button>
        </div>

        {/* B-P5 — DSGVO-Hinweis: Provider trägt potentiell Kunden-Daten ohne
            ausdrückliche Zustimmung ein. Rechtsgrundlage ist berechtigtes
            Interesse / Vertragsvorbereitung (DSGVO Art. 6 Abs. 1 lit. b/f).
            App-Store-Review-Hinweis: Hinweis muss vor dem Erfassen sichtbar
            sein. */}
        <div
          className="mt-3 flex items-start gap-2 rounded-xl bg-slate-100/80 px-3 py-2 text-[11.5px] leading-snug text-slate-600 ring-1 ring-slate-200"
          role="note"
        >
          <svg viewBox="0 0 20 20" className="mt-px size-3.5 shrink-0 text-slate-500" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M10 2.5a1.5 1.5 0 0 0-1.5 1.5v.7a6.5 6.5 0 0 0-3.55 11.31l-.7.7a.75.75 0 1 0 1.05 1.07l.74-.7A6.5 6.5 0 0 0 14 16.83l.7.7a.75.75 0 1 0 1.06-1.06l-.7-.7A6.5 6.5 0 0 0 11.5 4.7V4A1.5 1.5 0 0 0 10 2.5Zm-.75 5.75a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-1.5 0v-3ZM10 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"
              clipRule="evenodd"
            />
          </svg>
          <span>
            Eingetragene Kontaktdaten werden zur Vertragsvorbereitung gespeichert
            (DSGVO Art. 6 Abs. 1 lit. b / f). Informiere die Kundin oder den Kunden
            beim ersten Kontakt.
          </span>
        </div>

        <form onSubmit={onSubmit} className="mt-4 flex flex-1 flex-col gap-3 overflow-y-auto pr-0.5">
          <Field
            id="presales-convert-name"
            label="Kundenname"
            required
            error={nameError}
            inputRef={(node) => {
              firstFieldRef.current = node
              firstFieldCb(node)
            }}
            value={form.customerName}
            onChange={(v) => onChange('customerName', v)}
            autoComplete="name"
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              id="presales-convert-email"
              label="E-Mail (optional)"
              type="email"
              value={form.customerEmail}
              onChange={(v) => onChange('customerEmail', v)}
              autoComplete="email"
            />
            <Field
              id="presales-convert-phone"
              label="Telefon (optional)"
              type="tel"
              value={form.customerPhone}
              onChange={(v) => onChange('customerPhone', v)}
              autoComplete="tel"
            />
          </div>
          <Field
            id="presales-convert-date"
            label="Termin (optional)"
            placeholder="z. B. Mo, 27. Mai 2026"
            value={form.dateLabel}
            onChange={(v) => onChange('dateLabel', v)}
          />
          <Field
            id="presales-convert-amount"
            label="Betrag (optional)"
            placeholder="z. B. 1.250 €"
            value={form.amount}
            onChange={(v) => onChange('amount', v)}
            inputMode="decimal"
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="presales-convert-desc" className="text-[12px] font-semibold text-slate-600">
              Beschreibung (optional)
            </label>
            <textarea
              id="presales-convert-desc"
              value={form.description}
              onChange={(e) => onChange('description', e.target.value)}
              rows={3}
              className="min-h-[80px] resize-y rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-[13.5px] text-slate-900 outline-none ring-0 transition focus:border-slate-900/40 focus:bg-white"
              placeholder={project.notes ?? 'Was soll im Auftrag stehen?'}
            />
          </div>

          <div className="mt-2 flex items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-[13px] border border-slate-200 bg-white/80 py-3 text-[14px] font-semibold text-slate-700 active:scale-[0.98] disabled:opacity-40"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-[13px] bg-slate-900 py-3 text-[14px] font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-60"
            >
              {submitting ? 'Lege an …' : 'Als Projekt anlegen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface FieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  error?: string | null
  type?: 'text' | 'email' | 'tel'
  placeholder?: string
  autoComplete?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  inputRef?: React.Ref<HTMLInputElement>
}

function Field({
  id,
  label,
  value,
  onChange,
  required,
  error,
  type = 'text',
  placeholder,
  autoComplete,
  inputMode,
  inputRef,
}: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-semibold text-slate-600">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      <input
        ref={inputRef}
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        className={`h-11 rounded-xl border bg-white/80 px-3 text-[14px] text-slate-900 outline-none transition focus:bg-white ${
          error ? 'border-rose-400 focus:border-rose-500' : 'border-slate-200 focus:border-slate-900/40'
        }`}
      />
      {error && (
        <p id={`${id}-err`} className="text-[11.5px] font-medium text-rose-600">
          {error}
        </p>
      )}
    </div>
  )
}
