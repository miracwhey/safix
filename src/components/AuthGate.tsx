import { type ReactNode, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { refreshSession } from '../lib/session';
import { signOut } from '../lib/auth';
import type { Role } from '../lib/profile';
import ScreenSkeleton from './system/ScreenSkeleton';
import ScreenError from './system/ScreenError';

type AuthGateProps = {
  children: ReactNode;
  /** When set, the user must also have this role to pass through. */
  requiredRole?: Role;
  /**
   * When true, the gate does NOT redirect users with a missing/null role to
   * role selection.  Used exclusively for the role-selection onboarding route
   * itself — every other authenticated route requires a role.
   */
  allowMissingRole?: boolean;
};

export default function AuthGate({ children, requiredRole, allowMissingRole }: AuthGateProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const location = useLocation();
  const { user, role, tosAcceptedAt, loading, sessionValidated, error, errorKind } = useSession();

  async function handleRetry() {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await refreshSession();
    } finally {
      setIsRetrying(false);
    }
  }

  if (loading && !sessionValidated) return <ScreenSkeleton />;

  // Profile errors always get the full-screen error: session.ts sets
  // sessionValidated:true together with role:null AND tosAcceptedAt:null for
  // these kinds — falling through here would bounce the user into the
  // /tos-gate onboarding against a broken/missing profile row.
  // Transient errors (network/unknown) only block while the session has
  // never been server-validated (cold start failure). A warm, already-
  // validated session must keep its children mounted on a transient error
  // (e.g. getUser network failure on resume) — unmounting here would destroy
  // in-progress screen state such as a half-typed chat draft. Error
  // communication for the warm case is handled by SyncStatusBar / the
  // resume recovery cycle.
  if (
    error &&
    (errorKind === 'profile_create_failed' ||
      errorKind === 'profile_load_failed' ||
      errorKind === 'profile_schema_mismatch' ||
      (!sessionValidated && (errorKind === 'network_error' || errorKind === 'unknown_error')))
  ) {
    return (
      <ScreenError
        description={error}
        onRetry={handleRetry}
        retrying={isRetrying}
        onLogout={() => void signOut()}
      />
    );
  }

  // Redirect to login when there is no user OR when the session has not been
  // validated by the server.  Cached user data alone must never grant access
  // to authenticated routes.
  if (!user || !sessionValidated) return <Navigate to="/login" state={{ from: location }} replace />;

  // ToS gate: every authenticated user must accept Terms of Service before
  // accessing the app. Redirects to /tos-gate which persists acceptance.
  if (!tosAcceptedAt) {
    return <Navigate to="/tos-gate" replace />;
  }

  // Role gate: unless the route explicitly opts out (allowMissingRole), a
  // missing/null role always redirects to role selection.  This prevents any
  // authenticated route from rendering role-dependent content before the
  // user has chosen a role.
  if (!allowMissingRole && role == null) {
    return <Navigate to="/onboarding/role" replace />;
  }

  if (requiredRole && role !== requiredRole) {
    // Forward role-mismatches straight to HomeGate at "/". HomeGate reads the
    // session context and routes to the user's real home (customer home,
    // craftsman dashboard, worker shell) in a single hop — avoids the
    // previous two-step /search → /gate → / flicker that looked like a
    // dead-end to App-Store reviewers on customer-only routes.
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
