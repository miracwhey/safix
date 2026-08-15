import './lib/sentry';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import App from './App';
import './index.css';
import AppBootstrap from './components/AppBootstrap';
import AppErrorBoundary from './components/system/AppErrorBoundary';
import ToastProvider from './components/system/ToastProvider';
import { bootstrapNativePlatform } from './lib/native/bootstrap';
import { applyChatCutoverUrlOverride } from './lib/chat/featureFlags';
import { applyTabPerfUrlOverride } from './lib/debug/tabPerf';

// Initialise native Capacitor plugins (no-op on web).
void bootstrapNativePlatform();

// Recovery hook: ?chat_cutover_<persona>=on|off|clear in any URL flips the
// localStorage flag before any chat hook reads it, so a broken cutover state
// can be unstuck without a rebuild or DevTools.
applyChatCutoverUrlOverride();

// Opt-in bottom-tab tap latency instrumentation (Step 0). No-op unless armed
// with ?tabperf=on on-device. See src/lib/debug/tabPerf.ts.
applyTabPerfUrlOverride();

// Data router — required for useBlocker (used on payment and change-order
// screens). The catch-all route preserves the existing <Routes>/<Route>
// structure in App.tsx without any changes to route declarations.
const router = createBrowserRouter([
  {
    path: '*',
    // AppErrorBoundary is the innermost React error boundary so it catches
    // route render errors (Sentry + logError + custom fallback) before the
    // data router's own default error element can consume them silently.
    element: (
      <AppErrorBoundary>
        <ToastProvider>
          <AppBootstrap>
            <App />
          </AppBootstrap>
        </ToastProvider>
      </AppErrorBoundary>
    ),
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  </React.StrictMode>
);
