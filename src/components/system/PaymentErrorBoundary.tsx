/**
 * PaymentErrorBoundary
 *
 * Local React Error Boundary for the payment / funding subtree.
 *
 * Catches render-time exceptions in payment components (Stripe Elements,
 * CustomerEscrowFundingCard, etc.) and shows a payment-specific fallback
 * instead of letting the whole route go blank.
 */

import React from 'react'
import { logError } from '../../lib/observability'
import { intentionalReload } from '../../lib/lifecycle/killDetection'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  errorMessage?: string
}

export default class PaymentErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMessage: error.message }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[PaymentErrorBoundary] payment subtree threw:', error.message)
    logError('payment.render_error', error, {
      componentStack: info.componentStack ?? undefined,
      timestamp: Date.now(),
    })
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, errorMessage: undefined })
  }

  handleReload = (): void => {
    // Deliberate recovery reload — must not be misreported as a WebView
    // memory kill by the next boot's kill detection.
    intentionalReload()
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-testid="payment-error-boundary"
          className="flex min-h-[300px] flex-col items-center justify-center rounded-[28px] bg-white p-6 text-center shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-red-200/80"
        >
          <div className="text-[32px]">⚠️</div>
          <h2 className="mt-3 text-[17px] font-semibold text-slate-800">
            Zahlungsansicht konnte nicht geladen werden
          </h2>
          <p className="mt-2 max-w-xs text-[13px] leading-relaxed text-slate-500">
            Beim Laden der Zahlungskomponente ist ein Fehler aufgetreten.
            Bitte versuche es erneut.
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-2xl bg-amber-500 px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-amber-600 active:bg-amber-700"
            >
              Erneut versuchen
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-2xl border border-slate-200 px-4 py-2.5 text-[14px] font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              Seite neu laden
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
