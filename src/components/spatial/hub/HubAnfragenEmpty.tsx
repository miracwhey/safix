/**
 * L2-C · Anfragen-Tab Empty-State.
 *
 * Surfaces the gap between "I have aufmaße" and "a customer is attached". A
 * Privat-Aufmaß becomes an Anfrage automatically as soon as the provider
 * fills any draft customer field on the Pre-Sales project (`hasCustomerData`
 * in the hub hook). The CTA points back to the existing Pre-Sales list so
 * the provider can edit an existing row, since L2-C doesn't expose an inline
 * "add customer details" surface.
 */

import { MailOpen } from 'lucide-react'

export interface HubAnfragenEmptyProps {
  onOpenPresalesList: () => void
}

export function HubAnfragenEmpty({ onOpenPresalesList }: HubAnfragenEmptyProps) {
  return (
    <div className="flex flex-col items-center px-6 pt-10 text-center">
      <div className="mb-5 flex h-[112px] w-[112px] items-center justify-center rounded-[28px] border border-[#D4E0F7] bg-gradient-to-br from-[#EEF2FB] to-[#E0E9FB]">
        <MailOpen size={46} className="text-brand" strokeWidth={1.5} />
      </div>
      <h2 className="text-[20px] font-bold tracking-tight text-ink">
        Noch keine Kunden-Anfragen
      </h2>
      <p className="mt-2 max-w-[280px] text-[13px] text-ink-sub">
        Sobald du einem Privat-Aufmaß Kunden-Daten zuordnest, taucht es hier
        auf. Aktuell sind alle Aufmaße noch ohne Kunden-Anker.
      </p>
      <button
        type="button"
        onClick={onOpenPresalesList}
        className="mt-6 text-[13px] font-semibold text-brand"
      >
        Alle Aufmaße ansehen
      </button>
    </div>
  )
}
