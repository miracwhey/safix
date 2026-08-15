import { useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import {
  signInWithPassword,
  signUpWithPassword,
  signInWithMagicLink,
  sendPasswordResetEmail,
  signInWithApple,
  isAppleSignInCancelled,
} from '../lib/auth';
import { signalSignupTosAccepted, clearPendingTosAcceptance } from '../lib/session';
import { useSession } from '../hooks/useSession';
import AppShell from '../components/AppShell';
import * as pendingPushRoute from '../lib/notifications/pendingPushRoute';

type AuthMode = 'login' | 'signup' | 'reset';

/**
 * Maps Supabase/auth error messages (English) to user-friendly German strings.
 * Supabase error messages are not localized, so we match common patterns here.
 * @param e - The error thrown by the Supabase authentication call
 */
function mapLoginError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const normalizedMsg = msg.toLowerCase()

  if (normalizedMsg.includes('rate limit') || normalizedMsg.includes('too many') || normalizedMsg.includes('only request this after')) {
    return 'Bitte warte einen Moment und versuche es erneut.'
  }
  if (normalizedMsg.includes('invalid login credentials') || normalizedMsg.includes('invalid credentials')) {
    return 'Ungültige Anmeldedaten. Bitte prüfe E-Mail und Passwort.'
  }
  if (normalizedMsg.includes('email not confirmed')) {
    return 'Bitte bestätige zuerst deine E-Mail-Adresse.'
  }
  if (normalizedMsg.includes('user already registered')) {
    return 'Ein Konto mit dieser E-Mail existiert bereits. Bitte melde dich an.'
  }
  if (normalizedMsg.includes('password') && (normalizedMsg.includes('at least') || normalizedMsg.includes('too short') || normalizedMsg.includes('characters'))) {
    return 'Passwort muss mindestens 6 Zeichen lang sein.'
  }
  if (normalizedMsg.includes('invalid email') || normalizedMsg.includes('unable to validate email') || normalizedMsg.includes('invalid format')) {
    return 'Ungültige E-Mail-Adresse. Bitte prüfe deine Eingabe.'
  }
  if (normalizedMsg.includes('signup') && (normalizedMsg.includes('disabled') || normalizedMsg.includes('not allowed'))) {
    return 'Registrierung ist derzeit nicht verfügbar. Bitte versuche es später.'
  }
  if (normalizedMsg.includes('network') || normalizedMsg.includes('fetch') || normalizedMsg.includes('failed to fetch')) {
    return 'Keine Verbindung. Bitte prüfe deine Internetverbindung.'
  }
  return 'Anmeldung fehlgeschlagen. Bitte versuche es erneut.'
}

export default function LoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const [passwordResetSuccess] = useState(
    !!(location.state as { passwordResetSuccess?: boolean } | null)?.passwordResetSuccess
  );

  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [useMagicLink, setUseMagicLink] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [signupComplete, setSignupComplete] = useState(false);
  const [awaitingPostSignup, setAwaitingPostSignup] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [appleLoading, setAppleLoading] = useState(false);

  // Native Apple sign-in is only offered inside the iOS shell — the plugin's
  // ASAuthorization flow does not exist on web, and App Store guideline 4.8
  // only applies to the native app anyway.
  const showAppleSignIn = Capacitor.getPlatform() === 'ios';

  // If the user already has a validated session, redirect to /gate.
  // Uses the reactive session store (server-validated via getUser()) instead
  // of the local Supabase cache — prevents redirect loops where a stale JWT
  // sends the user to /gate only to be bounced back by gates that check
  // sessionValidated.
  //
  // This also handles the post-signup handoff: after signUpWithPassword()
  // succeeds with an immediate session (confirmations OFF), we keep the
  // loading spinner visible and wait for onAuthStateChange → forceRefreshSession
  // to complete. Once sessionValidated becomes true, we navigate to /gate
  // where HomeGate will route the user to role selection or the app.
  useEffect(() => {
    if (!session.loading && session.user && session.sessionValidated) {
      // Block 7.2 / B2 — wenn ein Push während des Login-Flows einen
      // pendingPushRoute gesetzt hat (z.B. User tippt Push aus Notification-
      // Center an, App ist noch nicht eingeloggt), navigiere direkt dorthin
      // statt auf /gate. AuthGate auf der Ziel-Route fängt etwaige Role-
      // Mismatches ab und bounced bei Bedarf zurück auf /gate.
      const pending = pendingPushRoute.consume()
      if (pending) {
        navigate(`${pending.path}${pending.search}`, { replace: true })
      } else {
        navigate('/gate', { replace: true })
      }
    }

    // If the session bootstrap finished without producing a validated session
    // after signup (e.g. an error occurred), reset the loading indicator so
    // the user can see the form and any error message.
    if (awaitingPostSignup && !session.loading && !session.sessionValidated) {
      setAwaitingPostSignup(false);
      setLoading(false);
      if (session.error) {
        // Post-signup bootstrap failed — the user was created in Supabase
        // but the session could not be fully established.  Show a classified
        // error message so the user understands what happened.
        const kind = session.errorKind;
        let msg: string;
        if (kind === 'profile_create_failed') {
          msg = 'Registrierung war erfolgreich, aber dein Profil konnte nicht erstellt werden. Bitte melde dich mit deinen Zugangsdaten an.';
        } else if (kind === 'profile_load_failed' || kind === 'profile_read_failed') {
          msg = 'Registrierung war erfolgreich, aber dein Profil konnte nicht geladen werden. Bitte melde dich mit deinen Zugangsdaten an.';
        } else if (kind === 'profile_schema_mismatch') {
          msg = 'Registrierung war erfolgreich, aber das Profilschema ist veraltet. Bitte melde dich mit deinen Zugangsdaten an.';
        } else if (kind === 'network_error') {
          msg = 'Registrierung war erfolgreich, aber es besteht keine Internetverbindung. Bitte prüfe deine Verbindung und melde dich an.';
        } else {
          msg = 'Registrierung war erfolgreich, aber die Sitzung konnte nicht geladen werden. Bitte melde dich mit deinen Zugangsdaten an.';
        }
        setError(msg);
      }
    }
  }, [session.loading, session.user, session.sessionValidated, session.error, session.errorKind, navigate, awaitingPostSignup]);

  // Screen-level safety net: if the SIGNED_IN event or forceRefreshSession
  // never resolve (e.g. network dropped immediately after signup submit on
  // mobile), abort the wait and surface a recoverable error.
  //
  // Budget breakdown (worst-case legitimate path):
  //   20 s  — AUTH_READ_TIMEOUT_MS for getSession (sequential)
  //   20 s  — AUTH_READ_TIMEOUT_MS for getUser (sequential, after resync wave)
  //   ~10 s — resyncRepositories wave that precedes forceRefreshSession
  //    5 s  — profile load retries + slow Supabase responses + overhead
  //   ----
  //   55 s  — conservative ceiling before declaring the bootstrap stuck
  //
  // The timer is cancelled automatically when awaitingPostSignup turns false
  // (either the normal success path or the session-error path above fires first).
  const POST_SIGNUP_SESSION_WATCHDOG_MS = 55_000
  useEffect(() => {
    if (!awaitingPostSignup) return
    const t = setTimeout(() => {
      setAwaitingPostSignup(false)
      setLoading(false)
      setError((prev) =>
        prev
          ? prev
          : 'Registrierung konnte nicht abgeschlossen werden. Bitte prüfe deine Verbindung und versuche es erneut.'
      )
    }, POST_SIGNUP_SESSION_WATCHDOG_MS)
    return () => clearTimeout(t)
  }, [awaitingPostSignup])

  const handleAppleSignIn = async () => {
    if (appleLoading || loading) return;
    try {
      setAppleLoading(true);
      setError(null);
      await signInWithApple();
      // Mirrors the password-login handoff: pending push route wins over /gate.
      // Session bootstrap continues via onAuthStateChange → forceRefreshSession;
      // first-time users hit the ToS gate + role selection behind /gate.
      const pending = pendingPushRoute.consume();
      if (pending) {
        navigate(`${pending.path}${pending.search}`, { replace: true });
      } else {
        navigate('/gate', { replace: true });
      }
    } catch (err: unknown) {
      if (!isAppleSignInCancelled(err)) {
        const raw = err instanceof Error ? err.message : String(err);
        const lower = raw.toLowerCase();
        console.error('[LoginScreen] Apple sign-in failed:', err);
        if (lower.includes('banned')) {
          setError('Dieses Konto ist derzeit gesperrt.');
        } else if (lower.includes('email not confirmed')) {
          // Occurs once "Confirm email" is enabled: an unconfirmed email
          // account with the same address blocks the id_token grant.
          setError('Bitte bestätige zuerst deine E-Mail-Adresse.');
        } else if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('load failed')) {
          setError('Keine Verbindung. Bitte prüfe deine Internetverbindung.');
        } else {
          // Keep the raw text as detail: unexpected failures here are either
          // the native layer (UNIMPLEMENTED = plugin missing from the binary,
          // ASAuthorization error 1000 = missing capability) or gotrue
          // (audience/nonce mismatch) — actionable only with the original text.
          setError(`Apple-Anmeldung fehlgeschlagen: ${raw}`);
        }
      }
    } finally {
      setAppleLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();

    if (!trimmedEmail) return;

    let keepLoading = false;

    try {
      setLoading(true);
      setError(null);

      if (authMode === 'reset') {
        // Supabase returns success for non-existent emails too — neutral
        // message prevents account enumeration. UI always shows the same
        // confirmation regardless of whether the email is registered.
        await sendPasswordResetEmail(trimmedEmail);
        setResetSent(true);
        return;
      }

      if (useMagicLink) {
        await signInWithMagicLink(trimmedEmail);
        setMagicLinkSent(true);
        return;
      }

      if (authMode === 'login') {
        await signInWithPassword(trimmedEmail, password);
        // Block 7.2 / B2 — Pending-Push-Route hat Vorrang vor /gate.
        // Spiegelt das Verhalten des Re-Direct-useEffect oben (siehe dort).
        const pending = pendingPushRoute.consume()
        if (pending) {
          navigate(`${pending.path}${pending.search}`, { replace: true })
        } else {
          navigate('/gate', { replace: true });
        }
      } else {
        // Signal ToS acceptance keyed to this signup email. refreshSession()
        // will only apply it if the validated user's email matches exactly.
        if (tosAccepted) signalSignupTosAccepted(trimmedEmail)
        const { needsConfirmation } = await signUpWithPassword(trimmedEmail, password);
        if (needsConfirmation) {
          setSignupComplete(true);
        } else {
          // Signup returned a usable session (confirmations OFF).
          // onAuthStateChange(SIGNED_IN) → forceRefreshSession() will
          // bootstrap the session in the background. Keep the loading
          // spinner visible; the useEffect above will navigate to /gate
          // once sessionValidated becomes true.
          keepLoading = true;
          setAwaitingPostSignup(true);
        }
      }
    } catch (err: unknown) {
      clearPendingTosAcceptance()
      setError(mapLoginError(err));
    } finally {
      if (!keepLoading) {
        setLoading(false);
      }
    }
  };

  const switchAuthMode = () => {
    setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'));
    setError(null);
    setSignupComplete(false);
    setMagicLinkSent(false);
    setTosAccepted(false);
    setResetSent(false);
  };

  const toggleMagicLink = () => {
    setUseMagicLink((prev) => !prev);
    setError(null);
    setMagicLinkSent(false);
    setSignupComplete(false);
  };

  const enterResetMode = () => {
    setAuthMode('reset');
    setUseMagicLink(false);
    setPassword('');
    setError(null);
    setMagicLinkSent(false);
    setSignupComplete(false);
    setResetSent(false);
  };

  const exitResetMode = () => {
    setAuthMode('login');
    setError(null);
    setResetSent(false);
  };

  return (
    <AppShell hideBottomNav>
      <section className="px-4 py-8">
        <div className="mx-auto w-full max-w-[420px]">
        <div className="flex flex-col items-center text-center">
          <div className="h-16 w-16 rounded-[18px] bg-[#2563EB] shadow-[0_10px_30px_rgba(37,99,235,0.25)] flex items-center justify-center">
            <span className="text-white text-2xl font-extrabold">F</span>
          </div>

          <h1 className="mt-4 text-[22px] font-semibold text-slate-900">
            {authMode === 'reset'
              ? 'Passwort zurücksetzen'
              : authMode === 'login'
                ? 'Bei SaFix anmelden'
                : 'Bei SaFix registrieren'}
          </h1>
          <p className="mt-1 text-[14px] text-slate-500">
            {authMode === 'reset'
              ? 'Wir senden dir einen Link zum Zurücksetzen deines Passworts.'
              : useMagicLink
                ? 'Wir senden dir einen Magic Link per E-Mail.'
                : authMode === 'login'
                  ? 'Melde dich mit E-Mail und Passwort an.'
                  : 'Erstelle ein neues Konto mit E-Mail und Passwort.'}
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          autoComplete="on"
          className="mt-8 rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_32px_-20px_rgba(2,6,23,0.35)]"
        >
          <label className="block text-sm font-medium text-slate-700">
            E-Mail
          </label>

          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            name="email"
            id="login-email"
            enterKeyHint="send"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="deine@email.de"
            required
            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none"
          />

          {!useMagicLink && authMode !== 'reset' && (
            <>
              <label className="mt-4 block text-sm font-medium text-slate-700">
                Passwort
              </label>

              <input
                type="password"
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                name="password"
                id="login-password"
                enterKeyHint="send"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={authMode === 'login'
                  ? 'Dein Passwort'
                  : 'Neues Passwort (mind. 6 Zeichen)'}
                required
                minLength={6}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none"
              />

              {authMode === 'login' && (
                <div className="mt-2 text-right">
                  <button
                    type="button"
                    onClick={enterResetMode}
                    className="text-xs font-medium text-[#2563EB] hover:underline"
                  >
                    Passwort vergessen?
                  </button>
                </div>
              )}
            </>
          )}

          {authMode === 'signup' && !useMagicLink && (
            <label className="mt-4 flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600"
              />
              <span className="text-xs text-slate-500 leading-relaxed">
                Ich habe die{' '}
                <Link to="/legal" className="font-medium text-blue-600 underline" target="_blank">
                  AGB und Datenschutzerklärung
                </Link>{' '}
                gelesen und akzeptiere sie.
              </span>
            </label>
          )}

          {error ? (
            <p className="mt-3 text-xs text-red-600">{error}</p>
          ) : null}

          {magicLinkSent ? (
            <p className="mt-3 text-xs text-emerald-600">
              Magic Link gesendet. Öffne die Mail und komme danach automatisch zurück.
            </p>
          ) : null}

          {signupComplete ? (
            <p className="mt-3 text-xs text-emerald-600">
              Registrierung erfolgreich! Bitte bestätige deine E-Mail-Adresse.
            </p>
          ) : null}

          {resetSent ? (
            <p className="mt-3 text-xs text-emerald-600">
              Wenn zu dieser E-Mail ein Konto existiert, haben wir dir einen Link
              zum Zurücksetzen des Passworts gesendet. Bitte prüfe dein Postfach.
            </p>
          ) : null}

          {passwordResetSuccess ? (
            <p className="mt-3 text-xs text-emerald-600">
              Passwort erfolgreich geändert. Bitte melde dich mit deinem neuen Passwort an.
            </p>
          ) : null}

          <button
            type="submit"
            disabled={loading || (!useMagicLink && authMode === 'signup' && !tosAccepted)}
            className="mt-4 w-full rounded-2xl bg-[#2563EB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading
              ? 'Lade...'
              : authMode === 'reset'
                ? 'Link senden'
                : useMagicLink
                  ? 'Magic Link senden'
                  : authMode === 'login'
                    ? 'Anmelden'
                    : 'Registrieren'}
          </button>

          {authMode !== 'reset' && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={toggleMagicLink}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                {useMagicLink
                  ? 'Stattdessen mit Passwort anmelden'
                  : 'Stattdessen Magic Link senden'}
              </button>
            </div>
          )}

          {authMode === 'reset' && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={exitResetMode}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Zurück zur Anmeldung
              </button>
            </div>
          )}
        </form>

        {showAppleSignIn && authMode !== 'reset' && (
          <div className="mt-4">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400">oder</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>
            <button
              type="button"
              onClick={handleAppleSignIn}
              disabled={appleLoading || loading}
              className="mt-4 w-full flex items-center justify-center gap-2.5 rounded-2xl bg-black px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              <svg viewBox="0 0 814 1000" className="h-4 w-4 fill-current" aria-hidden="true">
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
              </svg>
              {appleLoading ? 'Lade...' : 'Mit Apple fortfahren'}
            </button>
            <p className="mt-2 text-center text-[11px] text-slate-400">
              Mit der Anmeldung akzeptierst du beim ersten Mal unsere{' '}
              <Link to="/legal" className="underline" target="_blank">
                AGB und Datenschutzerklärung
              </Link>
              .
            </p>
          </div>
        )}

        {!useMagicLink && authMode !== 'reset' && (
          <p className="mt-4 text-center text-xs text-slate-500">
            {authMode === 'login' ? (
              <>
                Noch kein Konto?{' '}
                <button
                  type="button"
                  onClick={switchAuthMode}
                  className="font-medium text-[#2563EB] hover:underline"
                >
                  Jetzt registrieren
                </button>
              </>
            ) : (
              <>
                Bereits ein Konto?{' '}
                <button
                  type="button"
                  onClick={switchAuthMode}
                  className="font-medium text-[#2563EB] hover:underline"
                >
                  Anmelden
                </button>
              </>
            )}
          </p>
        )}
        </div>
      </section>
    </AppShell>
  );
}
