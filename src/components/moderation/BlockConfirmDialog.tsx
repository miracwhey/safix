import { useState } from 'react';
import { blockUser, unblockUser } from '../../lib/moderation/moderationService';

interface Props {
  targetUserId: string;
  targetLabel?: string;
  isBlocked: boolean;
  onClose: () => void;
  onToggled?: (blocked: boolean) => void;
}

export default function BlockConfirmDialog({ targetUserId, targetLabel, isBlocked, onClose, onToggled }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    setSubmitting(true);
    setError(null);
    try {
      if (isBlocked) {
        await unblockUser(targetUserId);
        onToggled?.(false);
      } else {
        await blockUser(targetUserId);
        onToggled?.(true);
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" onClick={onClose}>
      <div
        className="w-full max-w-[360px] rounded-[24px] bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[16px] font-semibold text-slate-900">
          {isBlocked ? 'Nutzer entblocken?' : 'Nutzer blockieren?'}
        </h3>
        {targetLabel && (
          <p className="mt-1 text-[13px] text-slate-500">{targetLabel}</p>
        )}
        <p className="mt-3 text-[13px] leading-relaxed text-slate-600">
          {isBlocked
            ? 'Dieser Nutzer kann dich wieder kontaktieren und wird in deinen Konversationen angezeigt.'
            : 'Dieser Nutzer kann dich nicht mehr kontaktieren. Bestehende Nachrichten bleiben erhalten.'}
        </p>

        {error && (
          <div className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-[13px] text-rose-700 ring-1 ring-rose-200">
            {error}
          </div>
        )}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-2xl bg-slate-100 px-4 py-3 text-[14px] font-semibold text-slate-700"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => void handleToggle()}
            disabled={submitting}
            className={`flex-1 rounded-2xl px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50 ${
              isBlocked ? 'bg-blue-600' : 'bg-rose-600'
            }`}
          >
            {submitting
              ? 'Bitte warten…'
              : isBlocked
                ? 'Entblocken'
                : 'Blockieren'}
          </button>
        </div>
      </div>
    </div>
  );
}
