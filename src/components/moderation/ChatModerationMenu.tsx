import { useEffect, useState } from 'react';
import { isUserBlocked } from '../../lib/moderation/moderationService';
import ReportUserSheet from './ReportUserSheet';
import BlockConfirmDialog from './BlockConfirmDialog';

interface Props {
  targetUserId: string;
  targetLabel?: string;
}

/**
 * Overflow menu (⋯) for chat headers that provides Report and Block actions.
 * Self-contained: manages its own open/close state and moderation dialogs.
 */
export default function ChatModerationMenu({ targetUserId, targetLabel }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showBlock, setShowBlock] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    void isUserBlocked(targetUserId).then(setBlocked);
  }, [targetUserId]);

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[18px] text-slate-600"
        aria-label="Weitere Optionen"
      >
        ⋯
      </button>

      {/* Dropdown menu */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="absolute right-4 top-[72px] w-52 rounded-2xl bg-white py-2 shadow-xl ring-1 ring-slate-200/70"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setShowReport(true);
              }}
              className="w-full px-4 py-2.5 text-left text-[14px] text-slate-700 active:bg-slate-50"
            >
              Nutzer melden
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setShowBlock(true);
              }}
              className="w-full px-4 py-2.5 text-left text-[14px] text-rose-600 active:bg-rose-50"
            >
              {blocked ? 'Nutzer entblocken' : 'Nutzer blockieren'}
            </button>
          </div>
        </div>
      )}

      {/* Report sheet */}
      {showReport && (
        <ReportUserSheet
          targetUserId={targetUserId}
          targetLabel={targetLabel}
          onClose={() => setShowReport(false)}
        />
      )}

      {/* Block dialog */}
      {showBlock && (
        <BlockConfirmDialog
          targetUserId={targetUserId}
          targetLabel={targetLabel}
          isBlocked={blocked}
          onClose={() => setShowBlock(false)}
          onToggled={(nowBlocked) => setBlocked(nowBlocked)}
        />
      )}
    </>
  );
}
