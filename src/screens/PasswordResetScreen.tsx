import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { updateUserPassword, signOut } from '../lib/auth';
import { clearPasswordRecovery, isPasswordRecoveryActive } from '../lib/session';
import { supabase } from '../lib/supabase';
import Spinner from '../components/system/Spinner';

/**
 * Password-reset completion screen.
 *
 * Landing page for the Supabase password-reset email link. The Supabase
 * client auto-processes the URL fragment (detectSessionInUrl: true) and
 * establishes a recovery session. This screen then prompts for the new
 * password and calls supabase.auth.updateUser({ password }).
 *
 * Fail states:
 *   - No session arrives within 10 s → show retry + bounce to /login.
 *   - updateUser rejects → surface the error, keep the form.
 *
 * Success:
 *   - Navigate to /gate so the normal gate stack routes the user home.
 */
function mapUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.toLowerCase();
  if (msg.includes('should be different') || msg.includes('same password')) {
    return 'Das neue Passwort darf nicht identisch mit dem alten sein.';
  }
  if (msg.includes('at least') || msg.includes('too short') || msg.includes('characters')) {
    return 'Passwort muss mindestens 6 Zeichen lang sein.';
  }
  if (msg.includes('rate limit') || msg.includes('too many')) {
    return 'Zu viele Versuche. Bitte warte einen Moment.';
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to fetch')) {
    return 'Keine Verbindung. Bitte prüfe deine Internetverbindung.';
  }
  if (msg.includes('auth session missing') || msg.includes('not authenticated')) {
    return 'Der Zurücksetzen-Link ist abgelaufen. Bitte fordere einen neuen Link an.';
  }
  return 'Passwort konnte nicht aktualisiert werden. Bitte versuche es erneut.';
}

export default function PasswordResetScreen() {
  const navigate = useNavigate();
  const { user, loading, sessionValidated } = useSession();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  // Wait up to 20 s for the recovery session to materialize. The higher
  // ceiling covers native cold-start on slow mobile networks where the
  // stash-based setSession() exchange can take several seconds.
  useEffect(() => {
    if (user && sessionValidated) return;
    const timer = setTimeout(() => setTimedOut(true), 20_000);
    return () => clearTimeout(timer);
  }, [user, sessionValidated]);

  // When the timeout fires with no user, check whether Supabase has an in-flight
  // session before clearing the recovery flag. On slow mobile networks the
  // stash-based setSession() (triggered in session.ts restoreRecoveryHashIfStashed)
  // may still be completing after the 20 s UI timeout. Clearing the flag while a
  // session is about to materialise would drop the App.tsx recovery guard and let
  // the user enter the app in a recovery session without completing the reset.
  //
  // Uses getUser() (server-side validation), NOT getSession() (local cache only).
  // getSession() can be truthy for a revoked/expired JWT that is still cached in
  // localStorage, which would prevent clearPasswordRecovery() from running and
  // trap the user on this screen — App.tsx's recovery guard would keep redirecting
  // back here every time they try to leave.
  useEffect(() => {
    if (!timedOut || !!user) return;
    let live = true;
    void supabase.auth.getUser().then(({ data, error }) => {
      if (!live) return;
      if (!isPasswordRecoveryActive()) return;
      if (data.user) return; // valid recovery session — keep App.tsx guard

      // No user. Decide whether to clear the recovery flag based on the error type:
      //
      // Network/transport failures (fetch error, AuthRetryableFetchError, status 0):
      //   Cannot distinguish an expired link from a valid recovery session still
      //   exchanging tokens on a slow connection — leave flag active. The button
      //   handler (handleCancel) clears it + signs out when the user leaves.
      //
      // Auth-level errors (AuthSessionMissingError, etc.) or no error at all:
      //   Server confirmed there is no valid session — the link is genuinely
      //   expired or invalid. Clear the flag so App.tsx stops redirecting here.
      const isNetworkFailure = !!error && (
        (error instanceof TypeError && /fetch|network/i.test(error.message)) ||
        (typeof error === 'object' && error !== null && (
          (error as { name?: string }).name === 'AuthRetryableFetchError' ||
          (error as { status?: number }).status === 0
        ))
      );
      if (!isNetworkFailure) {
        clearPasswordRecovery();
      }
    });
    return () => { live = false; };
  }, [timedOut, user]);

  const canSubmit =
    !!user &&
    sessionValidated &&
    password.length >= 6 &&
    password === confirm &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateUserPassword(password);
      // Recovery session is single-purpose. Clear the recovery flag, sign the
      // user out, and route to /login so the new password is exercised on the
      // first real login — prevents the App.tsx recovery guard from bouncing
      // the user back here on the next render and gives a clean audit trail.
      clearPasswordRecovery();
      try { await signOut(); } catch { /* non-critical */ }
      navigate('/login', { replace: true, state: { passwordResetSuccess: true } });
    } catch (err: unknown) {
      setError(mapUpdateError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    // Leaving the reset flow signs out the recovery session so the user
    // returns to a clean /login — mirrors Supabase's "only for this link"
    // semantics and prevents an abandoned recovery session from lingering.
    clearPasswordRecovery();
    try { await signOut(); } catch { /* ignore */ }
    navigate('/login', { replace: true });
  };

  if ((loading || !sessionValidated) && !timedOut) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-[320px] rounded-[24px] bg-white p-6 text-center shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] ring-1 ring-slate-200/70">
          <div className="mb-4 flex justify-center">
            <Spinner size="lg" tone="brand" />
          </div>
          <p className="text-[14px] font-medium text-slate-700">
            Zurücksetzen-Link wird geprüft…
          </p>
        </div>
      </div>
    );
  }

  if (timedOut && !user) {
    // No recovery session materialised within the timeout window.
    // clearPasswordRecovery() is handled by the useEffect above (async session
    // check first) — do not clear inline here to avoid the race where setSession()
    // completes just after the timeout and the guard gets dropped prematurely.
    return (
      <section className="px-4 py-10">
        <div className="mx-auto w-full max-w-[420px] text-center">
          <h1 className="text-[22px] font-semibold text-slate-900">
            Link abgelaufen
          </h1>
          <p className="mt-2 text-[14px] text-slate-500">
            Der Zurücksetzen-Link ist ungültig oder abgelaufen. Bitte fordere
            einen neuen Link an.
          </p>
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="mt-6 rounded-2xl bg-[#2563EB] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Zurück zum Login
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 py-10">
      <div className="mx-auto w-full max-w-[420px]">
        <div className="flex flex-col items-center text-center">
          <div className="h-16 w-16 rounded-[18px] bg-[#2563EB] shadow-[0_10px_30px_rgba(37,99,235,0.25)] flex items-center justify-center">
            <span className="text-white text-2xl font-extrabold">F</span>
          </div>
          <h1 className="mt-4 text-[22px] font-semibold text-slate-900">
            Neues Passwort setzen
          </h1>
          <p className="mt-1 text-[14px] text-slate-500">
            Wähle ein neues Passwort für dein SaFix-Konto.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          autoComplete="on"
          className="mt-8 rounded-3xl bg-white p-5 ring-1 ring-slate-200/70 shadow-[0_12px_32px_-20px_rgba(2,6,23,0.35)]"
        >
          <label className="block text-sm font-medium text-slate-700">
            Neues Passwort
          </label>
          <input
            type="password"
            autoComplete="new-password"
            name="new-password"
            id="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mindestens 6 Zeichen"
            required
            minLength={6}
            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none"
          />

          <label className="mt-4 block text-sm font-medium text-slate-700">
            Passwort bestätigen
          </label>
          <input
            type="password"
            autoComplete="new-password"
            name="confirm-password"
            id="confirm-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Neues Passwort wiederholen"
            required
            minLength={6}
            className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none"
          />

          {password.length > 0 && confirm.length > 0 && password !== confirm && (
            <p className="mt-3 text-xs text-red-600">
              Die Passwörter stimmen nicht überein.
            </p>
          )}

          {error && (
            <p className="mt-3 text-xs text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-4 w-full rounded-2xl bg-[#2563EB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitting ? 'Wird gespeichert…' : 'Passwort speichern'}
          </button>

          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              Abbrechen
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
