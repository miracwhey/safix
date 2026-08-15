import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useScrollSafeClicks } from './lib/ui/useScrollSafeClicks'
import { useAndroidBackButton } from './hooks/useAndroidBackButton'
import RoleGate from './components/RoleGate'
import AuthGate from './components/AuthGate'
import HomeGate from './components/HomeGate'
import OwnerRouteGate from './components/OwnerRouteGate'
import ProScreenGuard from './components/subscription/ProScreenGuard'
import EmployeeRouteGate from './components/EmployeeRouteGate'
import ScreenSkeleton from './components/system/ScreenSkeleton'
import SyncStatusBar from './components/system/SyncStatusBar'
import StatusBarController from './components/system/StatusBarController'
import PersistentTabs from './components/PersistentTabs'
import TosGateScreen from './screens/TosGateScreen'
import { isTabRoute, TAB_COLD_START_HOLD_PATHS } from './lib/navigation/tabRoutes'
import { useSession } from './hooks/useSession'
import { resolveAppContext, type AppContext } from './lib/access'
import { useCraftsmanProfileReady } from './hooks/useCraftsmanProfileReady'
import { isPasswordRecoveryActive } from './lib/session'
import { usePendingPushRouteConsume } from './components/usePendingPushRouteConsume'
import PushActionReplayModal from './components/notifications/PushActionReplayModal'
import { setBridgeSessionProvider } from './lib/notifications/pushNotificationBridge'
import { startPhotoUploadQueueRunner } from './lib/worker/photoUploadQueueRunner'
import { initializeRevenueCat } from './lib/subscription/revenueCat'

// Route-level code splitting — each non-tab screen is loaded on demand.
const ExploreCraftsmanProfileScreen = lazy(() => import('./screens/ExploreCraftsmanProfileScreen'))
const LoginScreen = lazy(() => import('./screens/LoginScreen'))
const AuthCallbackScreen = lazy(() => import('./screens/AuthCallbackScreen'))
const PasswordResetScreen = lazy(() => import('./screens/PasswordResetScreen'))
const MessageThreadScreen = lazy(() => import('./screens/MessageThreadScreen'))
const RoleSelectionScreen = lazy(() => import('./screens/RoleSelectionScreen'))
const CraftsmanRoleSelectionScreen = lazy(() => import('./screens/CraftsmanRoleSelectionScreen'))
const CraftsmanJobsScreen = lazy(() => import('./screens/CraftsmanJobsScreen'))
const CraftsmanJobDetailScreen = lazy(() => import('./screens/CraftsmanJobDetailScreen'))
const CraftsmanSpatialHubScreen = lazy(() => import('./screens/CraftsmanSpatialHubScreen'))
const CraftsmanPresalesProjectsScreen = lazy(
  () => import('./screens/CraftsmanPresalesProjectsScreen'),
)
const CraftsmanPresalesDetailScreen = lazy(
  () => import('./screens/CraftsmanPresalesDetailScreen'),
)
const CraftsmanJobSpatialDetailScreen = lazy(
  () => import('./screens/CraftsmanJobSpatialDetailScreen'),
)
const CustomerSpatialRescanScreen = lazy(
  () => import('./screens/CustomerSpatialRescanScreen'),
)
const WorkerFieldWalkScreen = lazy(() => import('./screens/WorkerFieldWalkScreen'))
const CraftsmanRequestDetailScreen = lazy(() => import('./screens/CraftsmanRequestDetailScreen'))
const CraftsmanRequestsScreen = lazy(() => import('./screens/CraftsmanRequestsScreen'))
const CraftsmanMessageThreadScreen = lazy(() => import('./screens/CraftsmanMessageThreadScreen'))
const CraftsmanNachrichtenScreen = lazy(() => import('./screens/CraftsmanNachrichtenScreen'))
const CraftsmanNachrichtenThreadScreen = lazy(() => import('./screens/CraftsmanNachrichtenThreadScreen'))
const CraftsmanOperationsScreen = lazy(() => import('./screens/CraftsmanOperationsScreen'))
const CraftsmanFinanceScreen = lazy(() => import('./screens/CraftsmanFinanceScreen'))
const CraftsmanInvoicesScreen = lazy(() => import('./screens/CraftsmanInvoicesScreen'))
const DisputeCenterScreen = lazy(() => import('./screens/DisputeCenterScreen'))
const OperatorDashboardScreen = lazy(() => import('./screens/OperatorDashboardScreen'))
// DEV-only POC screens: gate the lazy import() behind import.meta.env.DEV so
// Rollup constant-folds it to false in production and tree-shakes the ~321KB
// three.js POC chunks out of the prod bundle. Routes (below) are already
// DEV-gated, so the () => null fallback never mounts in production.
const SpatialCanonicalPocScreen = import.meta.env.DEV ? lazy(() => import('./screens/dev/SpatialCanonicalPocScreen')) : (() => null)
const SpatialEditModePocScreen = import.meta.env.DEV ? lazy(() => import('./screens/dev/SpatialEditModePocScreen')) : (() => null)
const SpatialVerifyPocScreen = import.meta.env.DEV ? lazy(() => import('./screens/dev/SpatialVerifyPocScreen')) : (() => null)
const OperatorAttributionDLQScreen = lazy(() => import('./screens/OperatorAttributionDLQScreen'))
const WorkerHomeScreen = lazy(() => import('./screens/WorkerHomeScreen'))
const WorkerEinsaetzeScreen = lazy(() => import('./screens/WorkerEinsaetzeScreen'))
const WorkerEinsaetzeDetailScreen = lazy(() => import('./screens/WorkerEinsaetzeDetailScreen'))
const WorkerDokuScreen = lazy(() => import('./screens/WorkerDokuScreen'))
const WorkerDokuDetailScreen = lazy(() => import('./screens/WorkerDokuDetailScreen'))
const WorkerNachrichtenScreen = lazy(() => import('./screens/WorkerNachrichtenScreen'))
const WorkerNachrichtenThreadScreen = lazy(() => import('./screens/WorkerNachrichtenThreadScreen'))
const WorkerKontoScreen = lazy(() => import('./screens/WorkerKontoScreen'))
const WorkerSickHistoryScreen = lazy(() => import('./screens/WorkerSickHistoryScreen'))
const WorkerKorrekturenScreen = lazy(() => import('./screens/WorkerKorrekturenScreen'))
const WorkerKorrekturCreateScreen = lazy(() => import('./screens/WorkerKorrekturCreateScreen'))
const WorkerKorrekturDetailScreen = lazy(() => import('./screens/WorkerKorrekturDetailScreen'))
const CraftsmanKorrekturenScreen = lazy(() => import('./screens/CraftsmanKorrekturenScreen'))
const CraftsmanKorrekturDetailScreen = lazy(() => import('./screens/CraftsmanKorrekturDetailScreen'))
const CustomerProjectsScreen = lazy(() => import('./screens/CustomerProjectsScreen'))
const CustomerProjectDetailScreen = lazy(() => import('./screens/CustomerProjectDetailScreen'))
const NotificationCenterScreen = lazy(() => import('./screens/NotificationCenterScreen'))
const ProjectBuilderScreen = lazy(() => import('./screens/ProjectBuilderScreen'))
const CustomerSearchScreen = lazy(() => import('./screens/SearchScreen'))
const CraftsmanOnboardingProfileScreen = lazy(() => import('./screens/CraftsmanOnboardingProfileScreen'))
const HandleRedirectScreen = lazy(() => import('./screens/HandleRedirectScreen'))
const WorkerOnboardingScreen = lazy(() => import('./screens/WorkerOnboardingScreen'))
const CraftsmanOnboardingSuccessScreen = lazy(() => import('./screens/CraftsmanOnboardingSuccessScreen'))
const CraftsmanProfile = lazy(() => import('./screens/CraftsmanProfile'))
const HighlightManagerScreen = lazy(() => import('./screens/HighlightManagerScreen'))
const HighlightEditScreen = lazy(() => import('./screens/HighlightEditScreen'))
const ReconciliationCenterScreen = lazy(() => import('./screens/profile/ReconciliationCenterScreen'))
const ReconciliationDetailScreen = lazy(() => import('./screens/profile/ReconciliationDetailScreen'))
const SavedReelsScreen = lazy(() => import('./screens/profile/SavedReelsScreen'))
const SavedReelsFolderScreen = lazy(() => import('./screens/profile/SavedReelsFolderScreen'))
const SavedProvidersScreen = lazy(() => import('./screens/profile/SavedProvidersScreen'))
const CraftsmanTaxBankScreen = lazy(() => import('./screens/CraftsmanTaxBankScreen'))
const CraftsmanTeamHubScreen = lazy(() => import('./screens/CraftsmanTeamHubScreen'))
const CraftsmanTeamMemberDetailScreen = lazy(() => import('./screens/CraftsmanTeamMemberDetailScreen'))
const CraftsmanTeamMemberCreateScreen = lazy(() => import('./screens/CraftsmanTeamMemberCreateScreen'))
const PayoutSetupScreen = lazy(() => import('./screens/PayoutSetupScreen'))
const LegalScreen = lazy(() => import('./screens/LegalScreen'))
const LegalDetailScreen = lazy(() => import('./screens/LegalDetailScreen'))
const PayoutReturnScreen = lazy(() => import('./screens/PayoutReturnScreen'))
const QuoteDetailScreen = lazy(() => import('./screens/QuoteDetailScreen'))
const FundingEntryScreen = lazy(() => import('./screens/FundingEntryScreen'))
const CustomerBillingProfileScreen = lazy(() => import('./screens/CustomerBillingProfileScreen'))
const ChangeOrderComposerScreen = lazy(() => import('./screens/ChangeOrderComposerScreen'))
const ChangeOrderDetailScreen = lazy(() => import('./screens/ChangeOrderDetailScreen'))
const InvoiceDetailScreen = lazy(() => import('./screens/InvoiceDetailScreen'))
const SupplementaryFundingScreen = lazy(() => import('./screens/SupplementaryFundingScreen'))
const ProSubscriptionScreen = lazy(() => import('./screens/ProSubscriptionScreen'))
const WiderrufScreen = lazy(() => import('./screens/WiderrufScreen'))
const ProjectScanScreen = lazy(() => import('./screens/ProjectScanScreen'))
const CustomerSpatialHubScreen = lazy(() => import('./screens/CustomerSpatialHubScreen'))
const CustomerSpatialDetailScreen = lazy(() => import('./screens/CustomerSpatialDetailScreen'))
const CustomerSpatialExampleRoomsScreen = lazy(
  () => import('./screens/CustomerSpatialExampleRoomsScreen'),
)

function RouteFallback() {
  return <ScreenSkeleton variant="detail" />
}

/**
 * Cold-start hold for persistent-tab URLs (resume robustness, Block 2).
 *
 * After a WebView content-process kill Capacitor reloads the CURRENT URL,
 * but on the first renders the session is not yet validated (and for owners
 * the profile-readiness module cache is empty), so `onTab` is still false.
 * Without an explicit <Route> per tab path the '*' catch-all would replace
 * the URL with '/' BEFORE validation settles — destroying the user's
 * location (e.g. /craftsman/messages → dashboard).
 *
 * Two pending phases:
 *   1. `sessionPending` — validation in flight, PersistentTabs is still
 *      gated off (PersistentTabs.tsx:83) → render a skeleton.
 *   2. `ownerPending` — validated owner whose profile-readiness fetch is
 *      still loading. PersistentTabs is already mounted (it gates only on
 *      user + sessionValidated) and shows the active tab content when this
 *      URL is an owner tab path; a skeleton here would stack visibly below
 *      it, so hold the URL invisibly. Paths that are NOT a tab for the
 *      resolved context (e.g. owner deep-linked to /messages) have no
 *      visible tab content and keep the skeleton until settled.
 *
 * Once everything settles, either `onTab` flips true (the tab shell takes
 * over and the whole non-tab Routes block unmounts), or the path is NOT a
 * tab route for the resolved context (logged out, wrong context, employee,
 * owner profile incomplete/error, session error) and we fall back to the
 * exact pre-existing catch-all behavior: redirect to '/' where HomeGate
 * owns login-redirect / onboarding / error recovery.
 */
function TabRouteColdStartGate({
  sessionPending,
  ownerPending,
  context,
}: {
  sessionPending: boolean
  ownerPending: boolean
  context: AppContext
}) {
  const location = useLocation()
  if (sessionPending) return <ScreenSkeleton variant="detail" />
  if (ownerPending) {
    if (isTabRoute(location.pathname, context)) return null
    return <ScreenSkeleton variant="detail" />
  }
  return <Navigate to="/" replace />
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const session = useSession()
  const { user, sessionValidated, tosAcceptedAt, error } = session
  const context = resolveAppContext(session)

  // Global guard: cancel the WKWebView synthetic click that fires after a
  // scroll/carousel flick (tap-on-card-while-scrolling). Scroll-keyed, so it
  // never touches movement-driven gestures (3D dollhouse, sliders, drag).
  useScrollSafeClicks()

  // Android hardware/gesture back: navigate router history back, minimize on a
  // tab root. No-op on iOS/web. Overlays intercept via registerBackInterceptor.
  useAndroidBackButton(context)

  // Block 7.2 / B2 — Push-Tap Deep-Link-Routing.
  // Mountet React-Router an die Push-Bridge und konsumiert während
  // Cold-Start / Login-Pending gequeuete Routes nach Session-Restore.
  usePendingPushRouteConsume()

  // Block A · Push-Inline-Actions — Session-Provider für die Bridge.
  // Wenn iOS Lockscreen-APPROVE/REJECT feuert, ruft die Bridge den
  // Provider, um Role + UserId für die Validation-Chain zu bekommen.
  // Re-registriert bei jedem Session-Change, damit der Dispatcher
  // immer die aktuelle Rolle sieht (z.B. nach Account-Switch).
  useEffect(() => {
    setBridgeSessionProvider(() => ({
      userId: session.user?.id ?? null,
      role: session.role,
      craftsmanRole: session.craftsmanRole,
    }))
    return () => setBridgeSessionProvider(() => null)
  }, [session.user?.id, session.role, session.craftsmanRole])

  // Block E · RevenueCat — initialize once per session with Supabase user ID.
  // No-op on web (isNative() guard inside). Re-logs in user on session change.
  useEffect(() => {
    if (user?.id) {
      void initializeRevenueCat(user.id)
    }
  }, [user?.id])

  // Block FU-A · WorkerDoku Photo-Upload-Queue Runner.
  // Drained die Offline-Queue (`photoUploadQueue`) bei `online`-Event
  // und alle 15 s. Startet nur einmal pro Session — Runner ist intern
  // idempotent. Reagiert nicht auf Logout/Login-Wechsel, weil RLS auf
  // jedem Replay-Insert den eingeloggten User durchsetzt.
  useEffect(() => {
    const stop = startPhotoUploadQueueRunner()
    return stop
  }, [])

  const replaySession = user && sessionValidated
    ? {
        userId: user.id,
        role: session.role,
        craftsmanRole: session.craftsmanRole,
      }
    : null

  // ALL hooks must run unconditionally before any conditional return.
  // Owners must complete profile onboarding before entering the persistent tab
  // shell.  Without this gate, a direct URL to a tab route (e.g. bookmark,
  // reload) would bypass OwnerRouteGate and land in the main app.
  // The hook uses a global cache so subsequent renders resolve instantly.
  const [ownerProfileState] = useCraftsmanProfileReady(context === 'owner' && !!tosAcceptedAt && !error)
  const ownerReady = context !== 'owner' || ownerProfileState === 'ready'

  // Password-recovery short-circuit. A recovery session is a real Supabase
  // session but the only legitimate next action is updateUser({ password }).
  // Force the reset screen regardless of role / ToS / gate state — otherwise
  // the user would be routed into the app and silently bypass the password-set
  // step (this also defends against a misconfigured Supabase redirect-allowlist
  // that lands the recovery hash on /auth/callback or any other route).
  if (isPasswordRecoveryActive() && location.pathname !== '/auth/reset-password') {
    return <Navigate to="/auth/reset-password" replace />
  }

  // ToS gate: authenticated + session validated + no profile error + ToS not accepted.
  // Renders ONLY TosGateScreen — no PersistentTabs, no routes, no app shell, no side effects.
  // Skip when session.error is set — AuthGate handles profile-error recovery screens.
  if (user && sessionValidated && !tosAcceptedAt && !error) {
    return <TosGateScreen />
  }

  const onTab = !!user && sessionValidated && ownerReady && isTabRoute(location.pathname, context)

  // Cold-start tab-URL hold (see TabRouteColdStartGate). Phase 1: initial
  // session validation in flight (cold start / account switch — mirrors the
  // HomeGate `loading && !sessionValidated` producer contract; warm
  // re-validates keep loading=false via session.ts). Phase 2: validated
  // owner whose profile-readiness fetch is still loading (module cache is
  // empty after every reload). All settled non-tab outcomes — logged out,
  // session error, owner profile incomplete/error ('disabled' included),
  // wrong-context tab path — resolve both to false and redirect to '/'.
  const sessionColdStartPending = session.loading && !sessionValidated
  const ownerReadinessPending = context === 'owner' && ownerProfileState === 'loading'

  return (
    <>
      {/* Tab screens stay mounted across navigation — no unmount/remount */}
      <PersistentTabs />
      <SyncStatusBar />
      <StatusBarController />

      {/* Block A · Push-Action Replay-Modal: zeigt nach Auth-Ready ein
          Confirm-Modal, wenn der User im Vor-Login eine Lockscreen-Action
          getriggert hat. Kein Auto-Replay — User-Confirm Pflicht. */}
      <PushActionReplayModal session={replaySession} navigate={navigate} />

      {/* Non-tab routes render only when the user is NOT on a tab */}
      {!onTab && (
        <Suspense fallback={<RouteFallback />}>
          <Routes location={location}>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="/auth/callback" element={<AuthCallbackScreen />} />
            <Route path="/auth/reset-password" element={<PasswordResetScreen />} />
            <Route path="/gate" element={<RoleGate />} />

            <Route
              path="/onboarding/role"
              element={
                <AuthGate allowMissingRole>
                  <RoleSelectionScreen />
                </AuthGate>
              }
            />

            <Route
              path="/onboarding/craftsman-role"
              element={
                <AuthGate requiredRole="craftsman">
                  <CraftsmanRoleSelectionScreen />
                </AuthGate>
              }
            />

            <Route
              path="/onboarding/craftsman-profile"
              element={
                <AuthGate requiredRole="craftsman">
                  <CraftsmanOnboardingProfileScreen />
                </AuthGate>
              }
            />

            <Route
              path="/craftsman/profile/edit"
              element={<Navigate to="/craftsman/profile" replace />}
            />

            <Route
              path="/onboarding/worker"
              element={
                <AuthGate requiredRole="craftsman">
                  <WorkerOnboardingScreen />
                </AuthGate>
              }
            />

            <Route
              path="/onboarding/craftsman-success"
              element={
                <AuthGate requiredRole="craftsman">
                  <CraftsmanOnboardingSuccessScreen />
                </AuthGate>
              }
            />

            {/* HomeGate handles unauthenticated / role-redirect logic */}
            <Route path="/" element={<HomeGate />} />

            <Route
              path="/explore/craftsman/:craftsmanId"
              element={<ExploreCraftsmanProfileScreen />}
            />

            <Route path="/explore/@:handle" element={<HandleRedirectScreen />} />

            <Route
              path="/messages/:threadId"
              element={
                <AuthGate requiredRole="customer">
                  <MessageThreadScreen />
                </AuthGate>
              }
            />

            <Route
              path="/quotes/:offerId"
              element={
                <AuthGate requiredRole="customer">
                  <QuoteDetailScreen />
                </AuthGate>
              }
            />

            <Route
              path="/projects/new"
              element={
                <AuthGate requiredRole="customer">
                  <ProjectBuilderScreen />
                </AuthGate>
              }
            />

            <Route
              path="/projects"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerProjectsScreen />
                </AuthGate>
              }
            />

            <Route
              path="/projects/:projectId"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerProjectDetailScreen />
                </AuthGate>
              }
            />

            <Route
              path="/projects/:projectId/scan"
              element={
                <AuthGate>
                  <ProjectScanScreen />
                </AuthGate>
              }
            />

            <Route
              path="/funding/:fundingRequestId"
              element={
                <AuthGate requiredRole="customer">
                  <FundingEntryScreen />
                </AuthGate>
              }
            />

            <Route
              path="/account/billing-profile"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerBillingProfileScreen />
                </AuthGate>
              }
            />

            <Route
              path="/customer/spatial/list"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerSpatialHubScreen />
                </AuthGate>
              }
            />

            <Route
              path="/customer/spatial/scan/:scanId"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerSpatialDetailScreen />
                </AuthGate>
              }
            />

            <Route
              path="/customer/spatial/beispiel-raeume"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerSpatialExampleRoomsScreen />
                </AuthGate>
              }
            />

            <Route
              path="/supplementary-funding/:supplementaryPaymentId"
              element={
                <AuthGate requiredRole="customer">
                  <SupplementaryFundingScreen />
                </AuthGate>
              }
            />

            <Route
              path="/nachtrag/:changeOrderId"
              element={
                <AuthGate requiredRole="customer">
                  <ChangeOrderDetailScreen />
                </AuthGate>
              }
            />

            <Route
              path="/rechnung/:invoiceId"
              element={
                <AuthGate requiredRole="customer">
                  <InvoiceDetailScreen />
                </AuthGate>
              }
            />

            <Route
              path="/notifications"
              element={
                <AuthGate requiredRole="customer">
                  <NotificationCenterScreen />
                </AuthGate>
              }
            />

            <Route path="/legal" element={<LegalScreen />} />
            <Route path="/legal/:section" element={<LegalDetailScreen />} />
            <Route path="/tos-gate" element={<Navigate to="/" replace />} />

            {/* Spatial Canonical POC · dev-only · Phase-0c perf bench */}
            {import.meta.env.DEV && (
              <Route path="/dev/spatial-poc" element={<SpatialCanonicalPocScreen />} />
            )}

            {/* Spatial Edit-Mode POC · dev-only · Phase-2 Block 2.9-2.12 */}
            {import.meta.env.DEV && (
              <Route path="/dev/spatial-edit" element={<SpatialEditModePocScreen />} />
            )}

            {/* Spatial Verify POC · dev-only · Phase-3 5-Stage Customer-Verify-Flow */}
            {import.meta.env.DEV && (
              <Route path="/dev/spatial-verify" element={<SpatialVerifyPocScreen />} />
            )}

            {/* /craftsman/work-queue → unified Aufträge surface, focused on Handlungsbedarf.
             *  The legacy ActionQueue screen is absorbed into CraftsmanJobsScreen. */}
            <Route
              path="/craftsman/work-queue"
              element={<Navigate to="/craftsman/jobs?focus=handlungsbedarf" replace />}
            />

            <Route
              path="/craftsman/jobs"
              element={
                <OwnerRouteGate>
                  <CraftsmanJobsScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/jobs/:jobId"
              element={
                <OwnerRouteGate>
                  <CraftsmanJobDetailScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/spatial"
              element={
                <OwnerRouteGate>
                  <CraftsmanSpatialHubScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/spatial/presales"
              element={
                <OwnerRouteGate>
                  <CraftsmanPresalesProjectsScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/spatial/presales/:presalesProjectId"
              element={
                <OwnerRouteGate>
                  <CraftsmanPresalesDetailScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/jobs/:jobId/spatial"
              element={
                <OwnerRouteGate>
                  <CraftsmanJobSpatialDetailScreen />
                </OwnerRouteGate>
              }
            />

            {/* Customer-facing re-scan response — deep-linked from a push (C-7). */}
            <Route
              path="/spatial/rescan/:requestId"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerSpatialRescanScreen />
                </AuthGate>
              }
            />

            <Route
              path="/craftsman/requests"
              element={
                <OwnerRouteGate>
                  <CraftsmanRequestsScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/request/:projectId"
              element={
                <OwnerRouteGate>
                  <CraftsmanRequestDetailScreen />
                </OwnerRouteGate>
              }
            />

            {/* Craftsman thread routes deliberately span two distinct domains:
             *  - /craftsman/messages/:threadId  → customer↔craftsman conversations
             *    (messages repo, MessageThreadScreen, list = /craftsman/messages tab).
             *  - /craftsman/nachrichten[/:id]    → internal office/team/einsatz
             *    (internalMessages repo, own list + thread screens).
             * They are NOT duplicates — different data models, different actors,
             * different notification bridges. Do not merge. The language mix
             * mirrors the in-app IA: "Messages" = external (customer-facing tab
             * wording), "Nachrichten" = internal office/team communication. */}
            <Route
              path="/craftsman/messages/:threadId"
              element={
                <OwnerRouteGate>
                  <CraftsmanMessageThreadScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/nachrichten"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Interne Nachrichten" featureDescription="Kommuniziere mit deinem Team direkt aus dem Büro.">
                    <CraftsmanNachrichtenScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/nachrichten/:threadId"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Interne Nachrichten" featureDescription="Kommuniziere mit deinem Team direkt aus dem Büro.">
                    <CraftsmanNachrichtenThreadScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/quotes/:offerId"
              element={
                <OwnerRouteGate>
                  <QuoteDetailScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/operations"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Kalender & Einsatzplanung" featureDescription="Plane und disponiere dein Team, Aufträge und Termine.">
                    <CraftsmanOperationsScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            {/* /craftsman/schedule → canonical location is now Betrieb/Planung/Kalender */}
            <Route
              path="/craftsman/schedule"
              element={<Navigate to="/craftsman/operations" replace />}
            />
            {/* /craftsman/today → absorbed into Betrieb/Planung/Übersicht */}
            <Route
              path="/craftsman/today"
              element={<Navigate to="/craftsman/operations" replace />}
            />

            <Route
              path="/craftsman/finance"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Finance-Dashboard" featureDescription="GMV, Ledger, Auszahlungen und alle Finanzkennzahlen deines Betriebs.">
                    <CraftsmanFinanceScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/invoices"
              element={
                <OwnerRouteGate>
                  <CraftsmanInvoicesScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/profile"
              element={
                <OwnerRouteGate>
                  <CraftsmanProfile />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/highlights"
              element={
                <OwnerRouteGate>
                  <HighlightManagerScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/highlights/:id"
              element={
                <OwnerRouteGate>
                  <HighlightEditScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/profile/tax-bank"
              element={
                <OwnerRouteGate>
                  <CraftsmanTaxBankScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/subscription"
              element={
                <OwnerRouteGate>
                  <ProSubscriptionScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/subscription/widerruf"
              element={
                <OwnerRouteGate>
                  <WiderrufScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/profile/disputes"
              element={
                <OwnerRouteGate>
                  <ReconciliationCenterScreen role="craftsman" />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/profile/disputes/:akz"
              element={
                <OwnerRouteGate>
                  <ReconciliationDetailScreen role="craftsman" />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/customer/profile/disputes"
              element={
                <AuthGate requiredRole="customer">
                  <ReconciliationCenterScreen role="customer" />
                </AuthGate>
              }
            />

            <Route
              path="/customer/profile/disputes/:akz"
              element={
                <AuthGate requiredRole="customer">
                  <ReconciliationDetailScreen role="customer" />
                </AuthGate>
              }
            />

            <Route
              path="/profile/saved-reels"
              element={
                <AuthGate allowMissingRole>
                  <SavedReelsScreen />
                </AuthGate>
              }
            />

            <Route
              path="/profile/saved-reels/:folderId"
              element={
                <AuthGate allowMissingRole>
                  <SavedReelsFolderScreen />
                </AuthGate>
              }
            />

            <Route
              path="/profile/saved-providers"
              element={
                <AuthGate allowMissingRole>
                  <SavedProvidersScreen />
                </AuthGate>
              }
            />

            <Route
              path="/craftsman/team"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Team-Hub" featureDescription="Verwalte Mitarbeiter, Stunden, Krankmeldungen und Schichtpläne.">
                    <CraftsmanTeamHubScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/team-settings"
              element={<Navigate to="/craftsman/team" replace />}
            />

            <Route
              path="/craftsman/team/new"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Team-Hub" featureDescription="Verwalte Mitarbeiter, Stunden, Krankmeldungen und Schichtpläne.">
                    <CraftsmanTeamMemberCreateScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/team/:memberId"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Team-Hub" featureDescription="Verwalte Mitarbeiter, Stunden, Krankmeldungen und Schichtpläne.">
                    <CraftsmanTeamMemberDetailScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/payout-setup"
              element={
                <OwnerRouteGate>
                  {/* Free for all verified craftsmen (Apple 3.1.1):
                      receiving payouts is not a Pro feature. */}
                  <PayoutSetupScreen />
                </OwnerRouteGate>
              }
            />
            <Route
              path="/payout-return"
              element={<PayoutReturnScreen />}
            />
            <Route
              path="/payout-refresh"
              element={<PayoutReturnScreen />}
            />

            <Route
              path="/craftsman/notifications"
              element={
                <OwnerRouteGate>
                  <NotificationCenterScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/nachtrag/neu"
              element={
                <OwnerRouteGate>
                  {/* Free for all verified craftsmen (Apple 3.1.1):
                      change orders (Nachträge) extend a paid job's earnings. */}
                  <ChangeOrderComposerScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/nachtrag/:changeOrderId"
              element={
                <OwnerRouteGate>
                  <ChangeOrderDetailScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/rechnung/:invoiceId"
              element={
                <OwnerRouteGate>
                  <InvoiceDetailScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/disputes"
              element={
                <OwnerRouteGate>
                  <DisputeCenterScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/operator"
              element={
                <OwnerRouteGate>
                  <OperatorDashboardScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/operator/attribution-dlq"
              element={
                <OwnerRouteGate>
                  <OperatorAttributionDLQScreen />
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/korrekturen"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Korrekturen" featureDescription="Prüfe und genehmige Zeitkorrekturen deiner Mitarbeiter.">
                    <CraftsmanKorrekturenScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/craftsman/korrekturen/:id"
              element={
                <OwnerRouteGate>
                  <ProScreenGuard featureName="Korrekturen" featureDescription="Prüfe und genehmige Zeitkorrekturen deiner Mitarbeiter.">
                    <CraftsmanKorrekturDetailScreen />
                  </ProScreenGuard>
                </OwnerRouteGate>
              }
            />

            <Route
              path="/worker"
              element={
                <EmployeeRouteGate>
                  <WorkerHomeScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/einsaetze"
              element={
                <EmployeeRouteGate>
                  <WorkerEinsaetzeScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/einsaetze/:entryId"
              element={
                <EmployeeRouteGate>
                  <WorkerEinsaetzeDetailScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/jobs/:jobId/spatial-walk"
              element={
                <EmployeeRouteGate>
                  <WorkerFieldWalkScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/doku"
              element={
                <EmployeeRouteGate>
                  <WorkerDokuScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/doku/:caseId"
              element={
                <EmployeeRouteGate>
                  <WorkerDokuDetailScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/nachrichten"
              element={
                <EmployeeRouteGate>
                  <WorkerNachrichtenScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/nachrichten/:threadId"
              element={
                <EmployeeRouteGate>
                  <WorkerNachrichtenThreadScreen />
                </EmployeeRouteGate>
              }
            />
            <Route
              path="/worker/konto"
              element={
                <EmployeeRouteGate>
                  <WorkerKontoScreen />
                </EmployeeRouteGate>
              }
            />

            <Route
              path="/worker/konto/krankmeldungen"
              element={
                <EmployeeRouteGate>
                  <WorkerSickHistoryScreen />
                </EmployeeRouteGate>
              }
            />

            <Route
              path="/worker/korrekturen"
              element={
                <EmployeeRouteGate>
                  <WorkerKorrekturenScreen />
                </EmployeeRouteGate>
              }
            />

            <Route
              path="/worker/korrekturen/neu"
              element={
                <EmployeeRouteGate>
                  <WorkerKorrekturCreateScreen />
                </EmployeeRouteGate>
              }
            />

            <Route
              path="/worker/korrekturen/:id"
              element={
                <EmployeeRouteGate>
                  <WorkerKorrekturDetailScreen />
                </EmployeeRouteGate>
              }
            />

            <Route
              path="/search"
              element={
                <AuthGate requiredRole="customer">
                  <CustomerSearchScreen />
                </AuthGate>
              }
            />

            {/* Cold-start hold — keeps tab URLs alive while session validation
                is pending. Must stay directly above the '*' catch-all; exact
                static paths, so sub-routes like /messages/:threadId or
                /profile/saved-reels are never shadowed. */}
            {TAB_COLD_START_HOLD_PATHS.map((path) => (
              <Route
                key={path}
                path={path}
                element={
                  <TabRouteColdStartGate
                    sessionPending={sessionColdStartPending}
                    ownerPending={ownerReadinessPending}
                    context={context}
                  />
                }
              />
            ))}

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      )}
    </>
  )
}
