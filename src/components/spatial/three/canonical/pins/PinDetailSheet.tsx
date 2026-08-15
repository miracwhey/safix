/**
 * Spatial · Canonical · Pins · PinDetailSheet (Day 17)
 *
 * Bottom-sheet that opens when a pin is tapped. Renders inside the HTML
 * overlay (NOT the r3f canvas) so accessibility + scrolling work
 * natively. Reads the pin from the canonical store using `selectedPinId`.
 *
 * The Day-17 spike ships only the read-only view (title, type badge,
 * severity, linked-photo/note/task counts). Phase-2 (Day 24+) wires the
 * edit-system to mutate the pin via override commands.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore'
import type { Pin } from '../../../../../lib/spatial/canonical/types/annotations'

interface PinDetailSheetProps {
  selectedPinId: string | null
  onClose: () => void
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const TYPE_LABEL: Record<Pin['pin_type'], string> = {
  damage: 'Schaden',
  wish: 'Wunsch',
  task: 'Aufgabe',
  material: 'Material',
  note: 'Notiz',
  measurement: 'Maß',
  photo: 'Foto',
}

export function PinDetailSheet({ selectedPinId, onClose }: PinDetailSheetProps): ReactElement | null {
  const resolved = useCanonicalSceneStore((s) => s.resolved)
  const pin = useMemo(
    () => resolved?.pins.find((p) => p.id === selectedPinId) ?? null,
    [resolved, selectedPinId],
  )

  // Focus management: remember whichever element opened the sheet so we can
  // restore focus on close (screen-reader users expect to land where they
  // came from), focus the dialog itself on mount, trap Tab/Shift+Tab inside,
  // and close on ESC. Guarded by `pin` so the effect only attaches while
  // the sheet is mounted.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!pin) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.focus()

    function onKeyDown(e: KeyboardEvent): void {
      if (!dialog) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'))
      if (focusables.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [pin, onClose])

  if (!pin) return null

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Pin Detail: ${pin.title ?? TYPE_LABEL[pin.pin_type]}`}
      tabIndex={-1}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        background: '#fafafa',
        color: '#1a1a1d',
        borderTop: '1px solid #2a2a2e',
        padding: '20px 16px 28px',
        boxShadow: '0 -12px 32px rgba(0,0,0,0.18)',
        zIndex: 100,
        maxHeight: '50vh',
        overflowY: 'auto',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span
          style={{
            background: colorFor(pin.pin_type),
            color: '#fafafa',
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {TYPE_LABEL[pin.pin_type]}
        </span>
        {pin.severity && (
          <span style={{ fontSize: 12, opacity: 0.6 }}>Severity: {pin.severity}</span>
        )}
        <button
          onClick={onClose}
          aria-label="Schließen"
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 22,
            color: '#1a1a1d',
          }}
        >
          ×
        </button>
      </header>
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>
        {pin.title ?? 'Ohne Titel'}
      </h2>
      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
        Anchored to {pin.anchor_surface_type} · UV ({pin.anchor_uv.u.toFixed(2)}, {pin.anchor_uv.v.toFixed(2)})
      </div>
      <ul style={{ paddingLeft: 16, margin: 0, fontSize: 14 }}>
        <li>{pin.linked_photo_ids.length} Foto(s)</li>
        <li>{pin.linked_note_ids.length} Notiz(en)</li>
        <li>{pin.linked_task_ids.length} Aufgabe(n)</li>
        {pin.linked_material_id && <li>Material: {pin.linked_material_id}</li>}
      </ul>
    </div>
  )
}

function colorFor(type: Pin['pin_type']): string {
  return {
    damage: '#b8536c',
    wish: '#5a8a4d',
    task: '#3a82ff',
    material: '#f5a623',
    note: '#4a90c2',
    measurement: '#4caf50',
    photo: '#c79b4a',
  }[type] ?? '#666666'
}
