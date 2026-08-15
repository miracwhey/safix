import { supabase } from './supabase';
import { retryOnAuthLockStolen } from './auth/authSingleFlight';
import { getAuthRedirectUrl } from './platform';
import { apiUrl } from './api/baseUrl';
import { sweepAllDraftKeys } from '../hooks/useDraftPersistence';
import { recordAnalyticsEvent, isoWeek } from './analytics';

export async function getCurrentUser() {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) throw sessionError;
  if (!session?.user) return null;

  return session.user;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<void> {
  // The auth-js navigator.locks 'fixup.auth' lock can be stolen by a concurrent
  // background getSession (repo inits, analytics, RevenueCat) when the user taps
  // login while a slow cold boot is still settling — most likely on a
  // memory/thermal-pressured device. The first sign-in then rejects with an
  // AbortError "Lock was stolen by another request" and the user sees a spurious
  // "Anmeldung fehlgeschlagen" even though nothing is wrong. retryOnAuthLockStolen
  // re-runs the sign-in exactly once after a short backoff — the same mitigation
  // getUser / messages / chat already use. A genuine auth error (wrong password,
  // unconfirmed email, …) comes back as a RESOLVED { error } (not a rejection),
  // so it is never retried and still surfaces to the caller.
  const { error } = await retryOnAuthLockStolen(() =>
    supabase.auth.signInWithPassword({ email, password }),
  );
  if (error) throw error;
}

export async function signUpWithPassword(
  email: string,
  password: string,
): Promise<{ needsConfirmation: boolean }> {
  const redirectTo = getAuthRedirectUrl();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectTo },
  });
  if (error) throw error;

  // When Supabase "Confirm email" is enabled, the session will be null
  // even on a successful signup. The user must click the confirmation link
  // in their email before they can sign in.
  const needsConfirmation = !!data.user && !data.session;

  // Funnel signal — recorded directly (not via track()) because the session
  // has not hydrated yet on the signup path, so we key it off the freshly
  // returned auth user. Fire-and-forget: recordAnalyticsEvent never throws.
  if (data.user) {
    recordAnalyticsEvent({
      eventType: 'signup',
      entityType: 'user',
      entityId: data.user.id,
      actorUserId: data.user.id,
      metadata: {
        needsConfirmation,
        ...(isoWeek(data.user.created_at) ? { cohortWeek: isoWeek(data.user.created_at) } : {}),
      },
    });
  }

  return { needsConfirmation };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Native Sign in with Apple (iOS only — the button is rendered only on the
 * iOS shell, so this never runs on web).
 *
 * Nonce contract: Apple receives the SHA-256 hash of a fresh random nonce and
 * embeds that hash as the `nonce` claim in the returned identity token.
 * Supabase gets the RAW nonce via signInWithIdToken, hashes it itself and
 * compares against the claim — a mismatch (replayed token) is rejected.
 *
 * First-time Apple users are created by the same `handle_new_user` trigger as
 * email signups (INSERT profiles(id) ON CONFLICT DO NOTHING); ToS consent is
 * NOT auto-signaled here — the TosGateScreen enforces explicit consent on
 * first entry, matching the email-signup guarantees.
 */
export async function signInWithApple(): Promise<void> {
  const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');

  const rawNonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hashedNonce = toHex(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawNonce)),
  );

  const result = await SignInWithApple.authorize({
    // On native iOS the ASAuthorization flow keys off the app's bundle ID;
    // clientId/redirectURI are required by the plugin's option type but only
    // used by its web/Android paths.
    clientId: 'app.fixup.main',
    redirectURI: 'https://app.safix.digital/auth/callback',
    scopes: 'email name',
    nonce: hashedNonce,
  });

  const identityToken = result.response?.identityToken;
  if (!identityToken) {
    throw new Error('Apple Sign-In lieferte kein Identity-Token.');
  }

  // Same lock-stolen mitigation as signInWithPassword — the tap can race a
  // slow cold-boot getSession on memory-pressured devices.
  const { data, error } = await retryOnAuthLockStolen(() =>
    supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: identityToken,
      nonce: rawNonce,
    }),
  );
  if (error) throw error;

  // Funnel parity with signUpWithPassword: an Apple sign-in that just created
  // the user counts as a signup. Supabase does not flag "new user" on this
  // path, so key it off created_at being within the last minute.
  const user = data?.user;
  if (user?.created_at && Date.now() - new Date(user.created_at).getTime() < 60_000) {
    recordAnalyticsEvent({
      eventType: 'signup',
      entityType: 'user',
      entityId: user.id,
      actorUserId: user.id,
      metadata: {
        provider: 'apple',
        ...(isoWeek(user.created_at) ? { cohortWeek: isoWeek(user.created_at) } : {}),
      },
    });
  }
}

/**
 * True when the thrown error is the user simply dismissing the native Apple
 * sheet (ASAuthorizationError.canceled = 1001) — callers should swallow it
 * instead of surfacing an error banner.
 */
export function isAppleSignInCancelled(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('1001') || msg.includes('cancel');
}

export async function signInWithMagicLink(email: string) {
  const redirectTo = getAuthRedirectUrl();

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
    },
  });

  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  // Resume-Robustness Block 3: persisted composer drafts are user-private.
  // Sweep them only AFTER a successful sign-out (a failed sign-out keeps the
  // session — the user must not lose their drafts) so a draft typed by this
  // account never surfaces for the next account on this device.
  sweepAllDraftKeys();
}

/**
 * Sends a password-reset email.
 *
 * The link lands on a dedicated /auth/reset-password route — NOT the generic
 * /auth/callback — so the recovery-session handoff is bound to a screen that
 * requires a new password before letting the user into the app. Supabase's
 * client auto-processes the URL fragment via detectSessionInUrl, establishes
 * a recovery session, and the reset screen then calls updateUser({ password }).
 *
 * Supabase returns success for BOTH existing and non-existent emails — this
 * is intentional to prevent account enumeration. The UI must show a neutral
 * success message rather than confirming whether the email is registered.
 */
export async function sendPasswordResetEmail(email: string): Promise<void> {
  const redirectTo = getAuthRedirectUrl('/auth/reset-password');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw error;
}

/**
 * Updates the current (recovery) session's password. Only callable while a
 * Supabase session exists — the recovery link establishes one automatically
 * on /auth/reset-password.
 */
export async function updateUserPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function deleteAccount(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? null;

  if (!token) {
    throw new Error('Nicht angemeldet.');
  }

  let res: Response;
  try {
    res = await fetch(apiUrl('/api/delete-account'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // iOS WKWebView rejects the fetch with "Load failed" (sometimes with the
    // host appended) for CORS / offline / timeout, before any response exists.
    // Never surface that raw to the user.
    throw new Error(
      'Verbindung fehlgeschlagen. Bitte Internetverbindung prüfen und erneut versuchen.'
    );
  }

  if (!res.ok) {
    // A platform 5xx/timeout page is HTML, not JSON — guard the parse so the
    // user sees a clean message instead of a JSON SyntaxError.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'Konto konnte nicht gelöscht werden.');
  }

  await supabase.auth.signOut();
  // Account is gone — its drafts must not linger for the next user.
  sweepAllDraftKeys();
}
