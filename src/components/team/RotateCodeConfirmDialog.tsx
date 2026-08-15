import { useEffect, useState, type ReactNode } from 'react'
import { deriveRotationConfirmationCopy } from '../../lib/company/codeRotationSelectors'

type Props = {
  open: boolean
  activeMemberCount: number
  rateLimitReached: boolean
  pending: boolean
  /** Optional warn-hint when stubs still wait for join — they need the new code. */
  pendingStubLabel?: string | null
  /**
   * When exactly one stub still waits for join AND has an email on file, the
   * caller passes that email here. The dialog then shows a primary combo
   * button "Rotieren & Mail an X" alongside the standard "Nur rotieren"
   * fallback. Without this prop only the rotate-only path renders.
   */
  comboMailEmail?: string | null
  onConfirm: () => void
  /** Required iff comboMailEmail is set. Triggers rotate + mail in one go. */
  onConfirmAndMail?: () => void
  onCancel: () => void
}

const COOLDOWN_SECONDS = 5

export default function RotateCodeConfirmDialog(props: Props): ReactNode {
  // Mount-on-open: secondsLeft initialises fresh on every open transition,
  // which avoids both `setState in effect` and ref-access-in-render lints.
  if (!props.open) return null
  return <DialogBody {...props} />
}

function DialogBody({
  activeMemberCount,
  rateLimitReached,
  pending,
  pendingStubLabel,
  comboMailEmail,
  onConfirm,
  onConfirmAndMail,
  onCancel,
}: Omit<Props, 'open'>): ReactNode {
  const showCombo = Boolean(comboMailEmail) && Boolean(onConfirmAndMail)
  const [secondsLeft, setSecondsLeft] = useState(COOLDOWN_SECONDS)

  useEffect(() => {
    const id = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  const copy = deriveRotationConfirmationCopy(activeMemberCount)
  const cooldownActive = secondsLeft > 0
  const buttonDisabled = pending || cooldownActive || rateLimitReached

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rotate-code-title"
      data-testid="rotate-code-confirm-dialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-sm sm:items-center"
    >
      <div className="w-full max-w-[420px] rounded-t-3xl bg-white p-6 shadow-[0_-12px_32px_-12px_rgba(2,6,23,0.18)] sm:rounded-3xl">
        <h2 id="rotate-code-title" className="text-[18px] font-semibold text-slate-900">
          {copy.title}
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-slate-600">{copy.body}</p>

        {rateLimitReached ? (
          <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
            Du hast das tägliche Rotations-Limit erreicht. Bitte morgen erneut versuchen.
          </p>
        ) : null}

        {pendingStubLabel ? (
          <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
            {pendingStubLabel} — schicke ihm direkt den neuen Code.
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-2">
          {showCombo ? (
            <button
              type="button"
              onClick={onConfirmAndMail}
              disabled={buttonDisabled}
              data-testid="rotate-code-confirm-and-mail-button"
              className="w-full rounded-full bg-rose-600 px-5 py-3 text-[14px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(225,29,72,0.6)] disabled:bg-slate-300 disabled:shadow-none"
            >
              {pending
                ? 'Rotiere & sende Mail…'
                : cooldownActive
                  ? `Rotieren & Mail an ${comboMailEmail} (${secondsLeft})`
                  : `Rotieren & Mail an ${comboMailEmail}`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onConfirm}
            disabled={buttonDisabled}
            data-testid="rotate-code-confirm-button"
            className={`w-full rounded-full px-5 py-3 text-[14px] font-semibold ${
              showCombo
                ? 'bg-slate-100 text-slate-700'
                : 'bg-rose-600 text-white shadow-[0_10px_24px_-12px_rgba(225,29,72,0.6)] disabled:bg-slate-300 disabled:shadow-none'
            }`}
          >
            {pending && !showCombo
              ? 'Rotiere…'
              : cooldownActive
                ? `${showCombo ? 'Nur rotieren' : copy.cta} (${secondsLeft})`
                : showCombo
                  ? 'Nur rotieren'
                  : copy.cta}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="w-full rounded-full px-5 py-3 text-[14px] font-semibold text-slate-500 disabled:opacity-50"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
