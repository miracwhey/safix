/**
 * Store-review prompt (SKStoreReviewController / Google Play In-App Review)
 * via @capacitor-community/in-app-review.
 *
 * The OS decides whether the dialog actually appears (Apple caps at 3
 * prompts per 365 days per app; Play has its own quota) — requestReview()
 * resolving says nothing about visibility. On top of the OS throttle we
 * keep our own cooldown so the plugin is not called on every qualifying
 * event, and callers gate on a positive in-app signal (e.g. a 4★+ job
 * rating) so only satisfied users are ever prompted.
 *
 * Safe to call anywhere: no-op on web, never throws.
 */
import { InAppReview } from '@capacitor-community/in-app-review';
import { isNative } from '../platform';
import { logWarning } from '../observability';

const COOLDOWN_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const LAST_PROMPT_KEY = 'fixup.app_review.last_prompt_at';

function readLastPromptAt(): number {
  try {
    const raw = window.localStorage.getItem(LAST_PROMPT_KEY);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    // Storage unavailable (private mode / WebView edge) — treat as never
    // prompted; the OS quota still bounds worst-case prompt frequency.
    return 0;
  }
}

export async function maybeRequestStoreReview(): Promise<void> {
  if (!isNative()) return;

  const last = readLastPromptAt();
  if (last > 0 && Date.now() - last < COOLDOWN_MS) return;

  // Stamp BEFORE the plugin call: a failing call (e.g. UNIMPLEMENTED on an
  // app build that predates the plugin) must not be retried on every
  // qualifying event — conservative is correct here.
  try {
    window.localStorage.setItem(LAST_PROMPT_KEY, String(Date.now()));
  } catch {
    // Non-persistable cooldown is acceptable; OS quota is the backstop.
  }

  try {
    await InAppReview.requestReview();
  } catch (err) {
    logWarning('appReview.request_failed', { error: String(err) });
  }
}
