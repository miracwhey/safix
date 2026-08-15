import CraftsmanSectionCard from '../CraftsmanSectionCard'
import CraftsmanModuleCard from '../CraftsmanModuleCard'

type Props = {
  jobsCount: number
  openInvoicesCount: number
}

export default function InvoiceLinkSection({
  jobsCount,
  openInvoicesCount,
}: Props) {
  return (
    <CraftsmanSectionCard
      eyebrow="Verknüpfung"
      title="Nächste Schritte"
      subtitle="Als Nächstes koppeln wir Rechnungen an Payments, damit Invoice-Status und Zahlungsstatus nicht getrennt laufen."
    >
      <div className="grid grid-cols-2 gap-4">
        <CraftsmanModuleCard
          to="/craftsman/jobs"
          icon="📦"
          title="Aufträge"
          subtitle="Quelle prüfen"
          badge={`${jobsCount} Jobs`}
          footer="Zur Jobliste"
          accent="bg-orange-50 text-orange-600"
        />

        <CraftsmanModuleCard
          to="/craftsman/finance"
          icon="💳"
          title="Finanzen"
          subtitle="Zahlungen koppeln"
          badge={`${openInvoicesCount} offen`}
          footer="Zu Finanzen"
          accent="bg-emerald-50 text-emerald-600"
        />
      </div>
    </CraftsmanSectionCard>
  )
}
