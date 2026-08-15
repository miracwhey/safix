/**
 * TabErrorBoundary
 *
 * Tab-scoped React error boundary for the persistent bottom-nav tab shell.
 *
 * The tab screens are code-split (`lazyWithRetry`). A dynamic `import()` that
 * still rejects after its retries — most often a stale-chunk 404 after a web
 * redeploy — throws during render. Without a local boundary that throw would
 * propagate to the app-wide `AppErrorBoundary` (main.tsx) and replace the WHOLE
 * authenticated shell with the global error screen. This boundary contains the
 * blast radius to the single failing tab and, crucially, keeps the chrome
 * (BottomNav) on screen by rendering its fallback INSIDE an `AppShell`, so the
 * user can switch to a working tab or reload.
 *
 * Recovery is a full reload via `intentionalReload()` (suppresses kill
 * detection): only a fresh `index.html` resolves a stale-chunk 404, and React
 * caches the rejected lazy promise so an in-place "retry" cannot re-run the
 * import anyway.
 */

import React from 'react'
import { AlertTriangle } from 'lucide-react'
import AppShell from '../AppShell'
import type { BottomNavItem } from '../BottomNav'
import { logError } from '../../lib/observability'
import { intentionalReload } from '../../lib/lifecycle/killDetection'

interface Props {
  /** Highlights the matching nav item while the fallback chrome is shown. */
  active?: BottomNavItem
  /** Tab path, for error attribution. */
  tabPath: string
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export default class TabErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[TabErrorBoundary] tab "${this.props.tabPath}" failed to load:`, error.message)
    logError('tab.chunk_load_error', error, {
      tabPath: this.props.tabPath,
      componentStack: info.componentStack ?? undefined,
      timestamp: Date.now(),
    })
  }

  handleReload = (): void => {
    intentionalReload()
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <AppShell active={this.props.active}>
          <div
            data-testid="tab-error-boundary"
            className="mx-auto flex min-h-[60vh] max-w-sm flex-col items-center justify-center px-6 text-center"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500 ring-1 ring-amber-200/80">
              <AlertTriangle size={26} strokeWidth={1.8} />
            </div>
            <h2 className="mt-4 text-[17px] font-semibold text-slate-800">
              Dieser Tab konnte nicht geladen werden
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
              Vermutlich wurde die App im Hintergrund aktualisiert. Ein Neuladen
              behebt das.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-5 rounded-2xl bg-brand px-5 py-2.5 text-[14px] font-semibold text-white transition-colors active:scale-[0.98]"
            >
              Neu laden
            </button>
          </div>
        </AppShell>
      )
    }

    return this.props.children
  }
}
