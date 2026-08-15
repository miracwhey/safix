import { useNavigate } from 'react-router-dom'
import BottomSheet from '../ui/BottomSheet'
import { LEGAL_SECTIONS, type LegalSection } from '../../lib/legal/legalSections'

type Props = {
  open: boolean
  onClose: () => void
}

/**
 * Bottom-sheet index over the three legal documents. The sheet itself only
 * lists the sections — tapping an item navigates to the dedicated full-screen
 * detail route (/legal/agb etc.) and closes the sheet, so we never stack a
 * sheet on top of a detail screen.
 *
 * Used post-login from ProfileActionsCard. Pre-login the existing
 * `target="_blank"` link in LoginScreen routes to the standalone /legal index
 * (same look, but in its own tab so the sign-up form keeps its state).
 */
export default function LegalSheet({ open, onClose }: Props) {
  const navigate = useNavigate()

  const handleSelect = (section: LegalSection) => {
    onClose()
    navigate(`/legal/${section}`)
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Rechtliches"
      description="Wähle ein Dokument."
    >
      <div className="mt-4 space-y-2">
        {LEGAL_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => handleSelect(section.id)}
            className="flex w-full items-center justify-between rounded-2xl bg-slate-50 px-4 py-3 text-left text-[14px] font-medium text-slate-900 transition active:scale-[0.98] hover:bg-slate-100"
          >
            <span>{section.title}</span>
            <span className="text-slate-400">›</span>
          </button>
        ))}
      </div>
    </BottomSheet>
  )
}
