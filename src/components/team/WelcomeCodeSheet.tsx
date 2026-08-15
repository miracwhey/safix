import { useState, type ReactNode } from 'react'

type Props = {
  code: string
  onSendEmail: () => Promise<{ ok: true; maskedEmail: string } | { ok: false; error: string }>
}

type CopyState = 'idle' | 'copied' | 'failed'
type EmailState = 'idle' | 'pending' | 'sent' | 'failed'

export default function WelcomeCodeSheet({ code, onSendEmail }: Props): ReactNode {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [emailState, setEmailState] = useState<EmailState>('idle')
  const [emailFeedback, setEmailFeedback] = useState<string | null>(null)

  async function handleCopy(): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 2000)
      return
    }
    try {
      await navigator.clipboard.writeText(code)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 2000)
    }
  }

  async function handleEmail(): Promise<void> {
    setEmailState('pending')
    setEmailFeedback(null)
    const result = await onSendEmail()
    if (result.ok) {
      setEmailState('sent')
      setEmailFeedback(`Code gesendet an ${result.maskedEmail}`)
    } else {
      setEmailState('failed')
      setEmailFeedback(result.error)
    }
  }

  return (
    <section
      className="rounded-3xl bg-[#EFF6FF] p-5 ring-1 ring-[#BFDBFE]"
      data-testid="welcome-code-sheet"
    >
      <p className="text-[11px] font-semibold text-[#1E40AF] text-center uppercase tracking-widest">
        Mitarbeiter einladen
      </p>
      <p
        className="mt-2 text-[30px] font-extrabold text-[#1D4ED8] tracking-[0.35em] text-center font-mono"
        data-testid="welcome-code-value"
      >
        {code}
      </p>
      <p className="mt-2 text-[12px] text-slate-500 text-center leading-relaxed">
        Teile diesen Code mit deinen Mitarbeitern. Sie geben ihn beim Registrieren in der SaFix-App ein.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={handleCopy}
          data-testid="welcome-code-copy"
          className="flex-1 rounded-full bg-white py-3 text-[14px] font-semibold text-[#1D4ED8] ring-1 ring-[#BFDBFE]"
        >
          {copyState === 'copied'
            ? 'Kopiert ✓'
            : copyState === 'failed'
              ? 'Kopieren fehlgeschlagen'
              : 'Code kopieren'}
        </button>
        <button
          type="button"
          onClick={handleEmail}
          disabled={emailState === 'pending'}
          data-testid="welcome-code-email"
          className="flex-1 rounded-full bg-[#1D4ED8] py-3 text-[14px] font-semibold text-white disabled:opacity-60"
        >
          {emailState === 'pending'
            ? 'Sende…'
            : emailState === 'sent'
              ? 'Gesendet ✓'
              : 'Per E-Mail senden'}
        </button>
      </div>

      {emailFeedback ? (
        <p
          className={`mt-3 text-center text-[12px] ${
            emailState === 'failed' ? 'text-rose-600' : 'text-slate-500'
          }`}
          data-testid="welcome-code-email-feedback"
        >
          {emailFeedback}
        </p>
      ) : null}
    </section>
  )
}
