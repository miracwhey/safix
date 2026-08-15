import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReportReason } from '../../lib/moderation/types';
import { reportUser } from '../../lib/moderation/moderationService';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';

interface Props {
  targetUserId: string;
  targetLabel?: string;
  /** UGC surface this report originates from (e.g. 'explore_reel', 'portfolio_comment', 'review'). */
  contextType?: string;
  /** Id of the reported content on that surface. */
  contextId?: string;
  onClose: () => void;
  onReported?: () => void;
}

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'harassment', label: 'Belästigung' },
  { value: 'spam', label: 'Spam' },
  { value: 'fraud', label: 'Betrug' },
  { value: 'inappropriate', label: 'Unangemessener Inhalt' },
  { value: 'other', label: 'Sonstiges' },
];

export default function ReportUserSheet({ targetUserId, targetLabel, contextType, contextId, onClose, onReported }: Props) {
  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [context, setContext] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lift the sheet above the on-screen keyboard when the "Sonstiges" textarea
  // is focused (shared chat keyboard rig).
  useKeyboardInset();

  // Dismiss on Escape. Without this, when the sheet is opened nested inside the
  // comments panel, the panel's document-level Escape listener would tear down
  // the whole panel instead of just this report. The panel yields Escape while a
  // report is open, so this handler closes only the report.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  async function handleSubmit() {
    if (!selectedReason) return;
    setSubmitting(true);
    setError(null);
    try {
      await reportUser(targetUserId, selectedReason, {
        details: context || undefined,
        contextType,
        contextId,
      });
      setSuccess(true);
      onReported?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Meldung fehlgeschlagen.');
    } finally {
      setSubmitting(false);
    }
  }

  // Portal to <body>: when opened from a reel card (inside the feed's
  // momentum-scroll <main>), a plain `position: fixed` is trapped by iOS
  // WKWebView and painted under the bottom nav. As a body child it is truly
  // viewport-fixed across every consumer.
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40"
      // Stop the backdrop dismiss from bubbling through the body portal up the
      // React tree. When this sheet is hoisted inside the comments panel's
      // backdrop (also onClick={onClose}), an unguarded tap here would fire the
      // panel's onClose too and close the whole comment thread underneath.
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{ paddingBottom: 'var(--keyboard-height, 0px)' }}
    >
      <div
        data-kb-pinned-composer
        className="w-full max-w-[430px] rounded-t-[24px] bg-white px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        // Stop touches from bubbling through the body portal up the React tree to
        // a host swipe handler (e.g. ExploreReelCard's asset/tab swipe). Mirrors
        // the sibling SaveToFolderSheet so both reel sheets harden consistently.
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-300" />

        {success ? (
          <div className="space-y-4 pb-2">
            <div className="text-center">
              <div className="text-[32px]">✓</div>
              <h3 className="mt-1 text-[16px] font-semibold text-slate-900">
                Meldung gesendet
              </h3>
              <p className="mt-1 text-[13px] text-slate-500">
                Vielen Dank. Wir prüfen deine Meldung.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-[14px] font-semibold text-white"
            >
              Schließen
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <h3 className="text-[16px] font-semibold text-slate-900">
                Nutzer melden
              </h3>
              {targetLabel && (
                <p className="mt-0.5 text-[13px] text-slate-500">{targetLabel}</p>
              )}
            </div>

            <div className="space-y-2">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setSelectedReason(r.value)}
                  className={`w-full rounded-2xl px-4 py-3 text-left text-[14px] font-medium transition ${
                    selectedReason === r.value
                      ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-500'
                      : 'bg-slate-50 text-slate-700 ring-1 ring-slate-200'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {selectedReason === 'other' && (
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Beschreibe das Problem…"
                rows={3}
                className="w-full rounded-2xl bg-slate-50 px-4 py-3 text-[14px] text-slate-700 ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}

            {error && (
              <div className="rounded-2xl bg-rose-50 px-4 py-3 text-[13px] text-rose-700 ring-1 ring-rose-200">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl bg-slate-100 px-4 py-3 text-[14px] font-semibold text-slate-700"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!selectedReason || submitting}
                className="flex-1 rounded-2xl bg-rose-600 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50"
              >
                {submitting ? 'Wird gesendet…' : 'Melden'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
