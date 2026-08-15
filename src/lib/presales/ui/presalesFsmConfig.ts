/**
 * Presales · UI · FSM-Pill-Konfiguration (V1.5.1 · Phase L2-E)
 *
 * Shared status-meta für `PresalesProjectStatus` — gleicher Label-Stil wie der
 * existierende `StatusBadge` aus `CraftsmanPresalesProjectsScreen`, plus eine
 * Headline für den Detail-Screen-Header.
 *
 * Wording-Glossar-Lock (D-5 / L2-B): kein "Pre-Sales", "Konvertiert" → "Als
 * Projekt angelegt", "scanned" → "Gescannt".
 */

import type { PresalesProjectStatus } from '../../../domain/presales/presalesProjectTypes'

export interface PresalesFsmMeta {
  /** Kompaktes Pill-Label (Card + Header). */
  label: string
  /** Hex-Background des Pills. */
  bg: string
  /** Hex-Foreground (Text + Dot). */
  fg: string
  /** Längere Headline für den Detail-Screen-Untertitel. */
  headline: string
  /** 1-Satz-Erklärung dessen, was der Nutzer als Nächstes tun kann. */
  nextStep: string | null
}

const META: Readonly<Record<PresalesProjectStatus, PresalesFsmMeta>> = {
  draft: {
    label: 'Entwurf',
    bg: '#ECEFF4',
    fg: '#475569',
    headline: 'Aufmaß noch nicht aufgenommen',
    nextStep: 'Scan jetzt starten, um das Aufmaß zu speichern.',
  },
  scanned: {
    label: 'Gescannt',
    bg: '#E5EDFB',
    fg: '#2563EB',
    headline: 'Aufmaß gespeichert',
    nextStep: 'Du kannst es jetzt als Projekt anlegen oder ein Angebot vorbereiten.',
  },
  quoted: {
    label: 'Angebot',
    bg: '#FEF3C7',
    fg: '#B45309',
    headline: 'Angebot vorbereitet',
    nextStep: 'Sobald die Kundin zustimmt, lege das Aufmaß als Projekt an.',
  },
  converted: {
    label: 'Als Projekt angelegt',
    bg: '#D1FAE5',
    fg: '#047857',
    headline: 'Als Projekt angelegt',
    nextStep: 'Öffne den Auftrag, um Pins, Termine und Rechnungen zu verwalten.',
  },
  archived: {
    label: 'Archiv',
    bg: '#ECEFF4',
    fg: '#94A3B8',
    headline: 'Archiviert',
    nextStep: null,
  },
}

export function getPresalesFsmMeta(status: PresalesProjectStatus): PresalesFsmMeta {
  return META[status]
}

/** Reihenfolge im Pipeline-Hint (links → rechts). */
export const PRESALES_PIPELINE: readonly PresalesProjectStatus[] = [
  'draft',
  'scanned',
  'quoted',
  'converted',
]
