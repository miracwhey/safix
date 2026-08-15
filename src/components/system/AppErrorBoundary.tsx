/**
 * AppErrorBoundary
 *
 * Global React Error Boundary that catches any unhandled component-level
 * exceptions in the application tree.
 *
 * On error:
 *  - Reports the exception to Sentry via captureException
 *  - Emits a structured observability event (`ui.runtime_error_captured`)
 *  - Renders a user-friendly fallback UI instead of crashing the app
 *  - Prevents infinite error loops via a stable `hasError` state guard
 */

import React from 'react'
import * as Sentry from '@sentry/react'
import { logError } from '../../lib/observability'
import { intentionalReload, markIntentionalNavigation } from '../../lib/lifecycle/killDetection'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export default class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info.componentStack ?? undefined
    const timestamp = Date.now()

    // Report to Sentry with component context
    Sentry.captureException(error, {
      extra: {
        componentStack,
        timestamp,
      },
    })

    // Emit structured observability event
    logError('ui.runtime_error_captured', error, {
      componentStack,
      timestamp,
    })
  }

  handleReload = (): void => {
    this.setState({ hasError: false }, () => {
      // Deliberate recovery reload — must not be misreported as a WebView
      // memory kill by the next boot's kill detection.
      intentionalReload()
    })
  }

  handleGoHome = (): void => {
    // Deliberate full-document navigation — suppress the pagehide marker so
    // the post-navigation boot is not misreported as a WebView kill.
    markIntentionalNavigation()
    window.location.href = '/'
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6 text-center">
          <div className="max-w-sm">
            <div className="mb-4 flex justify-center">
              <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <h1 className="mb-2 text-xl font-semibold text-slate-800">
              Etwas ist schiefgelaufen
            </h1>
            <p className="mb-6 text-sm text-slate-500">
              Die Seite konnte nicht korrekt geladen werden.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={this.handleReload}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                Seite neu laden
              </button>
              <button
                onClick={this.handleGoHome}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Zur Startseite
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
