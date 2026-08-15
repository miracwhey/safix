import type { ComponentType } from 'react'
import type { LegalSection } from './legalSections'

/**
 * Single source of truth for the legal documents. Rendered standalone on the
 * public detail screens (/legal/agb etc.), embedded into TosGateScreen for the
 * gated documents (AGB, Datenschutz, EULA), and listed in LegalScreen/LegalSheet.
 *
 * If a copy here changes, every surface auto-picks it up — there is no 2nd copy.
 *
 * Operator (Einzelunternehmer, Kleinunternehmer § 19 UStG):
 *   Leon Karim Valentin – SaFix, Ihmepassage 6, 30449 Hannover.
 * Brand in legal copy is "SaFix" (locked); app-wide rename is tracked under E5.
 *
 * Payment posture: SaFix tritt nicht als Treuhänder/Verwahrer auf; Zahlungen
 * werden über den Zahlungsdienstleister Stripe abgewickelt und abgesichert.
 */

const SECTION_HEADING = 'text-[14px] font-semibold text-slate-800'
const SECTION_BODY = 'mt-1 text-[13px] leading-relaxed text-slate-600'
const LIST = `${SECTION_BODY} list-disc space-y-1 pl-5`
const SUPPORT_EMAIL = 'team@safix.digital'

function SupportMail() {
  return (
    <a
      href={`mailto:${SUPPORT_EMAIL}`}
      className="font-medium text-blue-600 underline"
    >
      {SUPPORT_EMAIL}
    </a>
  )
}

export function LegalAgbContent() {
  return (
    <div className="space-y-3">
      <p className={SECTION_BODY}>
        Diese Allgemeinen Geschäftsbedingungen (AGB) gelten für die Nutzung der
        SaFix-Plattform durch Kunden (Verbraucher). Für Handwerksbetriebe
        (Anbieter) gelten ergänzend die gesonderten Anbieterbedingungen.
      </p>

      <h3 className={SECTION_HEADING}>§ 1 Geltungsbereich und Begriffe</h3>
      <p className={SECTION_BODY}>
        Anbieter dieser Plattform ist Leon Karim Valentin – SaFix, Ihmepassage
        6, 30449 Hannover („SaFix"). „Anbieter" sind die über die Plattform
        tätigen Handwerksbetriebe, „Kunde" ist der die Plattform nutzende
        Verbraucher. „Hauptvertrag" ist der Vertrag über die Handwerksleistung
        zwischen Anbieter und Kunde.
      </p>

      <h3 className={SECTION_HEADING}>§ 2 Rolle von SaFix; Vertragsbeziehungen</h3>
      <p className={SECTION_BODY}>
        SaFix betreibt eine Online-Vermittlungsplattform und stellt hierfür
        ausschließlich die technische Infrastruktur (Profil- und
        Angebotsanzeige, Anfrage- und Vermittlungsfunktion, Nachrichten/Chat,
        Zahlungsabwicklung) bereit. Der Hauptvertrag über die Handwerksleistung
        kommt ausschließlich zwischen dem Anbieter und dem Kunden zustande.
        SaFix wird nicht Vertragspartei dieses Vertrags und schuldet weder die
        Erbringung der Handwerksleistung noch deren Mangelfreiheit,
        Rechtzeitigkeit oder sonstige Erfüllung. Mängelansprüche und
        Gewährleistung richten sich ausschließlich gegen den Anbieter. SaFix
        macht sich die Inhalte und Angebote der Anbieter nicht zu eigen.
      </p>

      <h3 className={SECTION_HEADING}>§ 3 Registrierung und Nutzerkonto</h3>
      <p className={SECTION_BODY}>
        Die Nutzung setzt ein Nutzerkonto voraus. Der Kunde macht bei der
        Registrierung wahre und vollständige Angaben und hält seine
        Zugangsdaten geheim. Das Mindestalter beträgt 16 Jahre.
      </p>

      <h3 className={SECTION_HEADING}>§ 4 Vermittlung und Zustandekommen von Verträgen</h3>
      <p className={SECTION_BODY}>
        Mit der Registrierung kommt zwischen dem Kunden und SaFix ein
        unentgeltlicher Plattform-Nutzungsvertrag über die in § 2 beschriebenen
        Leistungen zustande. Der Hauptvertrag mit einem Anbieter kommt
        zustande, wenn der Kunde ein verbindliches Angebot des Anbieters über
        die Plattform annimmt. Unverbindliche Schätzungen und Kostenvoranschläge
        begründen keinen Vertrag.
      </p>

      <h3 className={SECTION_HEADING}>§ 5 Zahlungsabwicklung</h3>
      <p className={SECTION_BODY}>
        Zahlungen auf Aufträge werden über unseren Zahlungsdienstleister Stripe
        abgewickelt und abgesichert. Der Kunde zahlt den vereinbarten Betrag
        nach Annahme des Angebots; die Auszahlung an den Anbieter erfolgt nach
        Maßgabe des Leistungsfortschritts und der Freigabe durch den Kunden. Die
        von SaFix erhobene Plattformgebühr wird vom Anbieter getragen und ist im
        vom Kunden zu zahlenden Betrag bereits enthalten. SaFix tritt nicht als
        Treuhänder oder Verwahrer von Kundengeldern auf.
      </p>

      <h3 className={SECTION_HEADING}>
        § 5a Rolle von SaFix bei Meinungsverschiedenheiten
      </h3>
      <p className={SECTION_BODY}>
        SaFix ist kein Schiedsrichter und trifft keine Entscheidung darüber, wer
        im Streit zwischen Kunde und Anbieter im Recht ist. SaFix beurteilt
        insbesondere nicht, ob die Handwerksleistung mangelhaft ist oder ob eine
        Zahlung berechtigt einbehalten wird. SaFix wirkt ausschließlich als
        neutraler technischer Vollzieher und setzt nur Ergebnisse um, die (1) von
        beiden Parteien in der App bestätigt wurden, (2) aus einer vorab in diesen
        Bedingungen vereinbarten Regel (§ 5d) folgen, oder (3) aus einer
        rechtskräftigen gerichtlichen Entscheidung resultieren. Eine eigene
        inhaltliche Bewertung des Anspruchs nimmt SaFix nicht vor.
      </p>

      <h3 className={SECTION_HEADING}>§ 5b Streitbeilegung in Stufen</h3>
      <p className={SECTION_BODY}>
        Bei Meinungsverschiedenheiten über eine Leistung oder die Freigabe einer
        Zahlung gilt folgender Ablauf:
      </p>
      <ul className={LIST}>
        <li>
          <strong>Stufe 1 – Einigung (Konsens):</strong> Kunde und Anbieter
          versuchen zunächst, sich über die App-Funktionen (z. B. Vorschlag einer
          Teil- oder Vollfreigabe bzw. einer Teil- oder Vollrückzahlung) zu
          einigen. Bestätigen beide Parteien einen Vorschlag, führt SaFix
          ausschließlich dieses Ergebnis technisch aus.
        </li>
        <li>
          <strong>Stufe 2 – Default-Regel (Regel, kein Urteil):</strong> Kommt
          innerhalb der in § 5d genannten Frist keine Einigung zustande und greift
          auch keine Partei den Rechtsweg auf, gilt die vorab vereinbarte
          Default-Regel nach § 5d. Diese ist keine Entscheidung über Bestehen oder
          Höhe eines Anspruchs, sondern eine zuvor vereinbarte, neutrale
          Auffangregel für den Zahlungsfluss.
        </li>
        <li>
          <strong>Stufe 3 – Rechtsweg (Vorbehalt):</strong> Der ordentliche
          Rechtsweg bleibt jederzeit unberührt. Jede Partei kann ihre Ansprüche
          unabhängig von Stufe 1 und 2 vor den ordentlichen Gerichten geltend
          machen; eine in Stufe 2 ausgeführte vorläufige Freigabe oder Rückzahlung
          präjudiziert das gerichtliche Verfahren nicht (§ 5e).
        </li>
      </ul>

      <h3 className={SECTION_HEADING}>
        § 5c Zahlungsablauf und Einbehalt im Streitfall
      </h3>
      <p className={SECTION_BODY}>
        Der Zahlungsablauf ist in der App transparent dargestellt: Nach Annahme
        des Angebots zahlt der Kunde den vereinbarten Betrag; dieser wird über den
        Zahlungsdienstleister Stripe abgesichert und für die Abwicklung des
        Auftrags reserviert. Die Auszahlung an den Anbieter erfolgt gestaffelt
        nach Leistungsfortschritt: in der Regel 25 % bei dokumentiertem
        Arbeitsbeginn und 75 % nach Abnahme durch den Kunden bzw. nach Ablauf der
        vereinbarten Abnahmefrist, sofern kein Mangel gerügt ist. Rügt der Kunde
        einen Mangel oder kommt es zu einem Streit, wird die noch nicht
        ausgezahlte Zahlung bis zur Klärung einbehalten. Mängel-,
        Zurückbehaltungs- und sonstige Rechte des Kunden aus dem Hauptvertrag
        bleiben unberührt.
      </p>

      <h3 className={SECTION_HEADING}>
        § 5d Vorläufige Default-Regel nach 80 Tagen
      </h3>
      <p className={SECTION_BODY}>
        Bleibt ein Streit über einen abgesicherten Betrag 80 Tage lang ohne
        Einigung (§ 5b Stufe 1) und ohne dass eine Partei den Rechtsweg
        eingeleitet und SaFix dies mitgeteilt hat offen, so greift als vorläufige
        Default-Regel die Rückerstattung des noch abgesicherten, nicht
        ausgezahlten Betrags an den Kunden (in der Regel die erst nach Abnahme
        fällige Rate von 75 %). Der bereits zu dokumentiertem Arbeitsbeginn an den
        Anbieter ausgezahlte Abschlag (in der Regel 25 %) bleibt hiervon unberührt
        und wird nicht zurückgefordert; er trägt der bereits begonnenen Leistung
        Rechnung (Abschlagsgedanke des § 632a BGB). Diese Regel gilt ausdrücklich
        vorläufig und provisorisch und steht unter Rechtsweg-Vorbehalt:
      </p>
      <ul className={LIST}>
        <li>
          Sie ist keine Entscheidung darüber, ob der Kunde die Rückzahlung
          materiell beanspruchen kann oder ob die Leistung mangelhaft war.
        </li>
        <li>
          Sie verschiebt lediglich den Zahlungsfluss in einen vorhersehbaren
          Ruhezustand, weil eine unbegrenzte Blockade des Betrags für keine Seite
          zumutbar ist und der Zahlungsdienstleister technische Fristen vorgibt
          (§ 5f).
        </li>
        <li>
          Der materielle Anspruch des Anbieters auf Vergütung bleibt unberührt; er
          kann ihn weiterhin außergerichtlich und gerichtlich geltend machen.
        </li>
        <li>
          Die Frist beginnt mit dem maßgeblichen Anker-Zeitpunkt der Zahlung
          (Absicherung des Betrags). Lässt sich dieser Zeitpunkt technisch nicht
          eindeutig bestimmen, wird die Default-Regel nicht automatisch ausgelöst,
          sondern der Fall manuell geprüft.
        </li>
      </ul>

      <h3 className={SECTION_HEADING}>
        § 5e Keine Präjudizwirkung für den Zivilrechtsweg
      </h3>
      <p className={SECTION_BODY}>
        Eine nach § 5b oder § 5d ausgeführte vorläufige Freigabe, Teilzahlung oder
        Rückerstattung präjudiziert den Zivilrechtsweg nicht und stellt kein
        Anerkenntnis einer Partei dar. Beide Parteien können den ordentlichen
        Rechtsweg beschreiten; eine gerichtliche Entscheidung geht der vorläufigen
        Regel vor. Auf Grundlage eines rechtskräftigen Titels stellt SaFix den
        entsprechenden Zahlungsfluss technisch wieder her, soweit dies über den
        Zahlungsdienstleister möglich ist.
      </p>

      <h3 className={SECTION_HEADING}>
        § 5f Technische Fristen des Zahlungsdienstleisters
      </h3>
      <p className={SECTION_BODY}>
        Die in § 5c und § 5d genannten Fristen orientieren sich auch an den
        technischen Vorgaben des Zahlungsdienstleisters Stripe, der für Zuordnung,
        Auszahlung und Rückabwicklung von Zahlungen eigene Fristen vorsieht. Damit
        eine Zahlung nicht durch Zeitablauf in einen technisch nicht mehr
        steuerbaren Zustand gerät, muss innerhalb dieser Fenster eine Entscheidung
        über den Zahlungsfluss getroffen werden. Die 80-Tage-Frist liegt bewusst
        vor dem Ablauf dieser technischen Fenster.
      </p>

      <h3 className={SECTION_HEADING}>§ 6 SaFix Pro (Abonnement)</h3>
      <p className={SECTION_BODY}>
        Bestimmte Zusatzfunktionen können über das kostenpflichtige Abonnement
        „SaFix Pro" freigeschaltet werden. Das Abonnement wird als In-App-Kauf
        über den App Store abgeschlossen; Vertragspartner des Abonnements ist
        SaFix. Zahlungsabwicklung, automatische Verlängerung und etwaige
        Erstattungen erfolgen über das App-Store-Konto nach Maßgabe der
        Apple-Media-Services-Bedingungen. Das Abonnement verlängert sich
        automatisch um die gewählte Laufzeit, sofern es nicht spätestens 24
        Stunden vor Ablauf in den Einstellungen des App-Store-Kontos gekündigt
        wird. Die jeweils geltenden Preise werden im App Store angezeigt.
      </p>

      <h3 className={SECTION_HEADING}>§ 7 Pflichten des Kunden</h3>
      <p className={SECTION_BODY}>
        Der Kunde nutzt die Plattform nur im Rahmen der geltenden Gesetze und
        dieser AGB, macht wahrheitsgemäße Angaben und umgeht die
        Zahlungsabwicklung der Plattform nicht. Für das Verhalten im Chat und
        bei geteilten Inhalten gelten zusätzlich die Nutzungs- und
        Community-Richtlinien.
      </p>

      <h3 className={SECTION_HEADING}>§ 8 Inhalte und Nutzungsrechte</h3>
      <p className={SECTION_BODY}>
        An den vom Kunden hochgeladenen Inhalten (z. B. Fotos, Beschreibungen)
        räumt der Kunde SaFix ein einfaches, räumlich und zeitlich auf den
        Plattformbetrieb beschränktes Nutzungsrecht ein, soweit dies zur
        Bereitstellung der Leistung erforderlich ist. Die Rechte am Inhalt
        verbleiben beim Kunden.
      </p>

      <h3 className={SECTION_HEADING}>§ 9 Haftung</h3>
      <p className={SECTION_BODY}>
        SaFix haftet unbeschränkt für Schäden aus der Verletzung des Lebens, des
        Körpers oder der Gesundheit sowie bei Vorsatz und grober Fahrlässigkeit.
        Bei einfacher Fahrlässigkeit haftet SaFix nur bei Verletzung einer
        wesentlichen Vertragspflicht (Kardinalpflicht) – das ist eine Pflicht,
        deren Erfüllung die ordnungsgemäße Durchführung des Vertrags überhaupt
        erst ermöglicht und auf deren Einhaltung der Kunde regelmäßig vertrauen
        darf – und der Höhe nach begrenzt auf den vorhersehbaren,
        vertragstypischen Schaden. Eine weitergehende Haftung ist
        ausgeschlossen. Die Haftung nach dem Produkthaftungsgesetz und aus einer
        übernommenen Garantie bleibt unberührt. Für Ansprüche aus dem
        Hauptvertrag zwischen Anbieter und Kunde haftet allein der Anbieter.
      </p>

      <h3 className={SECTION_HEADING}>§ 10 Laufzeit, Kündigung, Sperrung</h3>
      <p className={SECTION_BODY}>
        Der Kunde kann den Plattform-Nutzungsvertrag jederzeit durch Löschung
        seines Kontos beenden. SaFix kann das Konto bei Verstößen gegen diese
        AGB oder die Community-Richtlinien verwarnen, Inhalte entfernen, das
        Konto vorübergehend sperren oder dauerhaft schließen; dabei werden die
        berechtigten Interessen des Kunden berücksichtigt.
      </p>

      <h3 className={SECTION_HEADING}>§ 11 Widerrufsrecht</h3>
      <p className={SECTION_BODY}>
        Verbrauchern steht beim kostenpflichtigen Abonnement ein gesetzliches
        Widerrufsrecht zu. Einzelheiten ergeben sich aus der gesonderten
        Widerrufsbelehrung.
      </p>

      <h3 className={SECTION_HEADING}>§ 12 Verbraucherstreitbeilegung</h3>
      <p className={SECTION_BODY}>
        SaFix ist nicht bereit und nicht verpflichtet, an
        Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
        teilzunehmen.
      </p>

      {/*
        § 13 Änderungs-/Zustimmungsmechanismus folgt der BGH-Rechtsprechung zu
        AGB-Änderungsklauseln (BGH, Urteil v. 27.04.2021 – XI ZR 26/20): wesent-
        liche Änderungen (Hauptleistung/Entgelt) nur mit ausdrücklicher Zustimmung,
        sonstige mit qualifizierter Widerspruchslösung + gesondertem Hinweis. Das
        Aktenzeichen wird bewusst nicht in den Verbrauchertext aufgenommen.
      */}
      <h3 className={SECTION_HEADING}>§ 13 Änderungen dieser Bedingungen</h3>
      <p className={SECTION_BODY}>
        SaFix kann diese AGB mit Wirkung für die Zukunft ändern, soweit dies aus
        triftigem Grund (geänderte Rechtslage oder Rechtsprechung, geänderte
        technische oder wirtschaftliche Rahmenbedingungen) erforderlich ist und
        der Kunde nicht unangemessen benachteiligt wird. Über Änderungen wird
        der Kunde mindestens sechs Wochen vor Inkrafttreten in Textform
        informiert. Änderungen wesentlicher Bestandteile (insbesondere
        Hauptleistungspflichten oder Entgelte) werden nur mit ausdrücklicher
        Zustimmung wirksam. Bei sonstigen Änderungen gilt die Zustimmung als
        erteilt, wenn der Kunde nicht innerhalb von sechs Wochen widerspricht;
        hierauf wird er gesondert hingewiesen. Im Falle des Widerspruchs kann
        jede Partei den Vertrag zum Zeitpunkt des Inkrafttretens der Änderung
        kündigen.
      </p>

      <h3 className={SECTION_HEADING}>§ 14 Schlussbestimmungen</h3>
      <p className={SECTION_BODY}>
        Es gilt deutsches Recht. Zwingende Verbraucherschutzvorschriften des
        Staates, in dem der Kunde seinen gewöhnlichen Aufenthalt hat, bleiben
        unberührt. Sollte eine Bestimmung unwirksam sein, bleibt die Wirksamkeit
        der übrigen Bestimmungen unberührt; an die Stelle der unwirksamen
        Regelung tritt die gesetzliche Regelung.
      </p>
    </div>
  )
}

export function LegalAnbieterAgbContent() {
  return (
    <div className="space-y-3">
      <p className={SECTION_BODY}>
        Diese Anbieterbedingungen gelten für gewerbliche Handwerksbetriebe
        („Anbieter"), die die SaFix-Plattform zur Vermittlung von Aufträgen
        nutzen. Ergänzend gelten die Allgemeinen Geschäftsbedingungen.
      </p>

      <h3 className={SECTION_HEADING}>§ 1 Geltungsbereich</h3>
      <p className={SECTION_BODY}>
        Anbieter ist, wer die Plattform zu gewerblichen Zwecken zur Erbringung
        von Handwerksleistungen nutzt. Anbieter handeln als Unternehmer im Sinne
        des § 14 BGB.
      </p>

      <h3 className={SECTION_HEADING}>§ 2 Plattformleistungen und Rolle von SaFix</h3>
      <p className={SECTION_BODY}>
        SaFix stellt die technische Infrastruktur zur Darstellung des
        Anbieterprofils, zur Vermittlung von Anfragen, zur Kommunikation und zur
        Zahlungsabwicklung bereit. Der Hauptvertrag über die Handwerksleistung
        kommt ausschließlich zwischen Anbieter und Kunde zustande; SaFix ist
        reiner Vermittler und nicht Vertragspartei.
      </p>

      <h3 className={SECTION_HEADING}>§ 3 Registrierung und Angaben des Anbieters</h3>
      <p className={SECTION_BODY}>
        Der Anbieter macht wahre und vollständige Angaben zu seinem Betrieb
        (insbesondere Firmenname und Gewerk) und hält sie aktuell. Der Anbieter
        ist verpflichtet, ein etwaig erforderliches eigenes Impressum sowie alle
        gewerbe- und handwerksrechtlichen Voraussetzungen seiner Tätigkeit
        eigenverantwortlich zu erfüllen. Für Auszahlungen ist ein Onboarding
        beim Zahlungsdienstleister Stripe (einschließlich der dort erforderlichen
        Identitätsprüfung) erforderlich.
      </p>

      <h3 className={SECTION_HEADING}>§ 4 Provision und Entgelte</h3>
      <p className={SECTION_BODY}>
        Für erfolgreich vermittelte und abgewickelte Aufträge erhält SaFix eine
        Plattformprovision. Diese beträgt 5 % des Auftragswerts, wenn der
        Anbieter den Kunden selbst eingebracht hat, und andernfalls 9 %. Der
        maßgebliche Satz wird bei Vertragsschluss festgelegt und ist für den
        jeweiligen Auftrag unveränderlich. Die Provision trägt der Anbieter; sie
        wird bei der Auszahlung einbehalten. Zusatzfunktionen können über das
        kostenpflichtige Abonnement „SaFix Pro" freigeschaltet werden.
      </p>

      <h3 className={SECTION_HEADING}>§ 5 Zahlungsabwicklung und Auszahlung</h3>
      <p className={SECTION_BODY}>
        Die Zahlungsabwicklung erfolgt über den Zahlungsdienstleister Stripe.
        Die Auszahlung an den Anbieter erfolgt nach Maßgabe des
        Leistungsfortschritts und der Freigabe durch den Kunden, abzüglich der
        Plattformprovision. Bei Streitigkeiten kann die Auszahlung bis zur
        Klärung zurückgehalten werden.
      </p>

      <h3 className={SECTION_HEADING}>
        § 5a Streitbeilegung, vorläufige Default-Regel und Rolle von SaFix
      </h3>
      <p className={SECTION_BODY}>
        Für Meinungsverschiedenheiten zwischen Anbieter und Kunde über eine
        Leistung oder die Freigabe einer Zahlung gilt das in den Kunden-AGB
        beschriebene Stufenverfahren (Einigung – vorläufige Default-Regel –
        Rechtsweg) entsprechend. SaFix wirkt dabei als neutraler technischer
        Vollzieher und entscheidet nicht inhaltlich über den Streit. Der Anbieter
        erkennt insbesondere an, dass bei einem ungelösten Streit nach Ablauf von
        80 Tagen als vorläufige Default-Regel die Rückerstattung des noch
        abgesicherten, nicht ausgezahlten Betrags (in der Regel 75 %) an den
        Kunden erfolgen kann; der bereits zu Arbeitsbeginn ausgezahlte Abschlag
        (in der Regel 25 %, Abschlagsgedanke des § 632a BGB) verbleibt beim
        Anbieter und wird im Default-Fall nicht zurückgefordert. Diese Regel ist
        vorläufig, steht unter Rechtsweg-Vorbehalt und lässt den
        Vergütungsanspruch des Anbieters aus dem Hauptvertrag unberührt; der
        Anbieter kann diesen Anspruch außergerichtlich und gerichtlich
        weiterverfolgen.
      </p>

      <h3 className={SECTION_HEADING}>
        § 5b Einwilligung in die Rückholung bereits ausgezahlter Beträge
      </h3>
      <p className={SECTION_BODY}>
        Voraussetzung für die Teilnahme an der Plattform und der
        Zahlungsabwicklung ist die folgende ausdrückliche Einwilligung des
        Anbieters:
      </p>
      <ul className={LIST}>
        <li>
          Der Anbieter willigt ein, dass SaFix bzw. der Zahlungsdienstleister
          bereits an den Anbieter ausgezahlte Beträge ganz oder teilweise
          zurückholen kann, soweit dies zur Umsetzung eines beidseitig
          bestätigten Einigungsergebnisses oder einer gerichtlichen bzw.
          gleichwertigen Entscheidung erforderlich ist. Die vorläufige
          Default-Regel nach 80 Tagen (§ 5a; § 5d der Kunden-AGB) löst für sich
          genommen keine solche Rückholung aus: Sie erstattet ausschließlich den
          noch abgesicherten, nicht ausgezahlten Betrag und lässt den bereits
          ausgezahlten Abschlag unberührt.
        </li>
        <li>
          Die Rückholung kann insbesondere durch Rückbuchung bereits ausgeführter
          Transfers, durch Verrechnung mit künftigen Auszahlungen und durch
          Belastung des mit dem Anbieter verbundenen Zahlungs-/Connect-Kontos
          erfolgen.
        </li>
        <li>
          Reicht das Guthaben des Anbieters beim Zahlungsdienstleister zur
          Rückholung nicht aus (negativer Saldo), willigt der Anbieter ein, dass
          der ausstehende Betrag über das hinterlegte Zahlungsmittel eingezogen
          wird (z. B. per SEPA-Lastschrift). Ein darüber hinausgehender
          Ausgleichsanspruch bleibt unberührt.
        </li>
        <li>
          Der Anbieter hält sein verbundenes Zahlungs-/Bankkonto so lange aktiv
          und gedeckt, wie Rückholungen aus laufenden oder strittigen Aufträgen
          noch möglich sind.
        </li>
      </ul>

      <h3 className={SECTION_HEADING}>§ 6 Pflichten des Anbieters</h3>
      <p className={SECTION_BODY}>
        Der Anbieter erbringt seine Leistungen fachgerecht und im Verhältnis zum
        Kunden auf eigene Verantwortung; Gewährleistung und Haftung für die
        Handwerksleistung treffen allein den Anbieter. Der Anbieter führt
        anfallende Steuern und Abgaben selbst ab und hält die Plattform- sowie
        Community-Regeln ein.
      </p>

      <h3 className={SECTION_HEADING}>§ 7 Daten von Mitarbeitern; Auftragsverarbeitung</h3>
      <p className={SECTION_BODY}>
        Soweit der Anbieter über die App personenbezogene Daten seiner
        Mitarbeiter (insbesondere Name, Telefonnummer, E-Mail-Adresse, Rolle,
        Arbeitszeiten sowie Einsatz- und Zeitdaten) erfasst oder verarbeitet,
        bleibt der Anbieter hierfür datenschutzrechtlich Verantwortlicher; SaFix
        handelt insoweit als Auftragsverarbeiter nach Maßgabe des
        Auftragsverarbeitungsvertrags (Anlage zu diesen Bedingungen). Der
        Anbieter sichert zu, dass er für diese Verarbeitung über eine gültige
        Rechtsgrundlage verfügt und seine Mitarbeiter rechtzeitig und
        vollständig nach Art. 13/14 DSGVO informiert hat – insbesondere, wenn er
        Mitarbeiterdaten anlegt, bevor der Mitarbeiter ein eigenes Konto
        besitzt. Der Anbieter stellt SaFix von Ansprüchen Dritter
        (insbesondere betroffener Mitarbeiter und Aufsichtsbehörden) frei, die
        aus einem Verstoß gegen die vorstehenden Pflichten resultieren. Bei
        Widersprüchen zwischen diesen Bedingungen und dem
        Auftragsverarbeitungsvertrag gehen die Regelungen des
        Auftragsverarbeitungsvertrags vor.
      </p>

      <h3 className={SECTION_HEADING}>§ 8 Ranking und Transparenz</h3>
      <p className={SECTION_BODY}>
        Die Reihenfolge, in der Anbieter angezeigt werden, richtet sich
        insbesondere nach Relevanz für die Anfrage (Gewerk, Standort,
        Verfügbarkeit), Vollständigkeit des Profils und Kundenbewertungen. Eine
        gegen Entgelt erkaufte Bevorzugung im Ranking findet nicht statt; sollte
        ein Abonnement das Ranking beeinflussen, wird dies gesondert
        offengelegt.
      </p>

      <h3 className={SECTION_HEADING}>§ 9 Sperrung und Kündigung</h3>
      <p className={SECTION_BODY}>
        Der Anbieter kann den Vertrag jederzeit beenden. Beschränkt oder beendet
        SaFix die Plattformnutzung eines Anbieters, teilt SaFix dem Anbieter die
        Gründe in Textform mit; eine Beendigung erfolgt mit einer Frist von 30
        Tagen, sofern nicht eine sofortige Maßnahme aus wichtigem Grund
        (insbesondere bei schwerwiegenden oder wiederholten Verstößen oder
        gesetzlicher Verpflichtung) erforderlich ist.
      </p>

      <h3 className={SECTION_HEADING}>§ 10 Haftung</h3>
      <p className={SECTION_BODY}>
        SaFix haftet unbeschränkt für Schäden aus der Verletzung des Lebens, des
        Körpers oder der Gesundheit sowie bei Vorsatz und grober Fahrlässigkeit.
        Im Übrigen haftet SaFix bei einfacher Fahrlässigkeit nur für die
        Verletzung wesentlicher Vertragspflichten und der Höhe nach begrenzt auf
        den vorhersehbaren, vertragstypischen Schaden. Eine weitergehende
        Haftung ist ausgeschlossen.
      </p>

      <h3 className={SECTION_HEADING}>§ 11 Änderungen</h3>
      <p className={SECTION_BODY}>
        Änderungen dieser Bedingungen werden dem Anbieter mindestens sechs
        Wochen vor Inkrafttreten in Textform mitgeteilt. Widerspricht der
        Anbieter nicht innerhalb dieser Frist, gelten die Änderungen als
        angenommen; hierauf wird er gesondert hingewiesen.
      </p>

      <h3 className={SECTION_HEADING}>§ 12 Schlussbestimmungen</h3>
      <p className={SECTION_BODY}>
        Es gilt deutsches Recht. Ausschließlicher Gerichtsstand für
        Streitigkeiten mit Anbietern, die Kaufleute sind, ist – soweit
        gesetzlich zulässig – Hannover. Sollte eine Bestimmung unwirksam sein,
        bleibt die Wirksamkeit der übrigen Bestimmungen unberührt.
      </p>
    </div>
  )
}

export function LegalAvvContent() {
  return (
    <div className="space-y-3">
      <p className={SECTION_BODY}>
        Diese Vereinbarung zur Auftragsverarbeitung (AVV) ist Anlage zu den
        Anbieterbedingungen und gilt zwischen dem Handwerksbetrieb
        (Verantwortlicher) und Leon Karim Valentin – SaFix (Auftragsverarbeiter)
        nach Art. 28 DSGVO. Bei Widersprüchen zu den Anbieterbedingungen geht
        diese AVV vor.
      </p>

      <h3 className={SECTION_HEADING}>§ 1 Gegenstand, Art und Zweck</h3>
      <p className={SECTION_BODY}>
        SaFix verarbeitet im Auftrag des Betriebs personenbezogene Daten, soweit
        dies zur Bereitstellung der Plattformfunktionen erforderlich ist —
        insbesondere die vom Betrieb eingegebenen Mitarbeiterdaten sowie die im
        Rahmen der Auftragsabwicklung anfallenden Kundendaten. Die Verarbeitung
        erfolgt für die Dauer des Nutzungsvertrags.
      </p>

      <h3 className={SECTION_HEADING}>§ 2 Weisungsgebundenheit</h3>
      <p className={SECTION_BODY}>
        SaFix verarbeitet die Daten ausschließlich auf dokumentierte Weisung des
        Betriebs. Die Nutzung der Plattformfunktionen durch den Betrieb gilt als
        Weisung. SaFix informiert den Betrieb, wenn eine Weisung nach Auffassung
        von SaFix gegen Datenschutzrecht verstößt.
      </p>

      <h3 className={SECTION_HEADING}>§ 3 Betroffene und Datenarten</h3>
      <p className={SECTION_BODY}>
        Betroffene: Mitarbeiter des Betriebs sowie Kunden im Auftragskontext.
        Datenarten: Name, Kontaktdaten, Rolle, Arbeits- und Einsatzzeiten,
        Auftrags- und Kommunikationsdaten.
      </p>

      <h3 className={SECTION_HEADING}>§ 4 Technische und organisatorische Maßnahmen (Art. 32)</h3>
      <p className={SECTION_BODY}>
        Verschlüsselung der Übertragung (TLS) und der Speicherung,
        zugriffsbeschränkte Datenbank mit zeilenbasierten Sicherheitsregeln
        (Row-Level-Security), Pseudonymisierung von Kennungen in Hilfsdiensten,
        regelmäßige Sicherungen sowie Hosting der Datenbank in der Europäischen
        Union (Irland).
      </p>

      <h3 className={SECTION_HEADING}>§ 5 Unter-Auftragsverarbeiter</h3>
      <p className={SECTION_BODY}>
        Der Betrieb erteilt die allgemeine Genehmigung zum Einsatz folgender
        Unter-Auftragsverarbeiter: Supabase (Hosting/Datenbank, EU/Irland),
        Vercel (Anwendungs-Hosting), Stripe (Zahlungsabwicklung), Sentry
        (Fehlerdiagnose), RevenueCat (Abo-Verwaltung), Resend (E-Mail-Versand),
        Apple (Push/Käufe) und Upstash (Rate-Limiting). SaFix informiert über
        beabsichtigte Änderungen und räumt ein Widerspruchsrecht ein.
      </p>

      <h3 className={SECTION_HEADING}>§ 6 Unterstützung und Meldepflichten</h3>
      <p className={SECTION_BODY}>
        SaFix unterstützt den Betrieb angemessen bei der Erfüllung von
        Betroffenenrechten (Art. 12–23 DSGVO) sowie bei Pflichten nach Art. 32–36
        DSGVO und meldet Verletzungen des Schutzes personenbezogener Daten
        unverzüglich.
      </p>

      <h3 className={SECTION_HEADING}>§ 7 Löschung und Rückgabe</h3>
      <p className={SECTION_BODY}>
        Nach Beendigung des Vertrags löscht SaFix die im Auftrag verarbeiteten
        Daten oder gibt sie zurück, soweit keine gesetzliche
        Aufbewahrungspflicht besteht.
      </p>

      <h3 className={SECTION_HEADING}>§ 8 Nachweise und Kontrollen</h3>
      <p className={SECTION_BODY}>
        SaFix stellt dem Betrieb die zum Nachweis der Einhaltung erforderlichen
        Informationen zur Verfügung (Art. 28 Abs. 3 lit. h DSGVO).
      </p>
    </div>
  )
}

export function LegalWiderrufContent() {
  return (
    <div className="space-y-3">
      <p className={SECTION_BODY}>
        Die folgende Widerrufsbelehrung gilt für das kostenpflichtige
        Abonnement „SaFix Pro" (Vertrag zwischen dem Kunden und SaFix). Für die
        Handwerksleistung selbst ist der jeweilige Anbieter Vertragspartner; ein
        etwaiges Widerrufsrecht gegenüber dem Anbieter richtet sich nach dessen
        Belehrung.
      </p>

      <h3 className={SECTION_HEADING}>Widerrufsrecht</h3>
      <p className={SECTION_BODY}>
        Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen
        diesen Vertrag zu widerrufen. Die Widerrufsfrist beträgt vierzehn Tage
        ab dem Tag des Vertragsschlusses.
      </p>
      <p className={SECTION_BODY}>
        Um Ihr Widerrufsrecht auszuüben, müssen Sie uns
      </p>
      <p className={SECTION_BODY}>
        Leon Karim Valentin – SaFix, Ihmepassage 6, 30449 Hannover,
        <br />
        E-Mail: <SupportMail />
      </p>
      <p className={SECTION_BODY}>
        mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter
        Brief oder eine E-Mail) über Ihren Entschluss, diesen Vertrag zu
        widerrufen, informieren. Sie können dafür das beigefügte
        Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.
        Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung
        über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist
        absenden.
      </p>
      <p className={SECTION_BODY}>
        Innerhalb der App können Sie Ihren Widerruf zum Abonnement direkt über
        die Schaltfläche „Vertrag widerrufen" unter „Abo verwalten" erklären. Den
        Eingang bestätigen wir Ihnen unverzüglich per E-Mail.
      </p>

      <h3 className={SECTION_HEADING}>Folgen des Widerrufs</h3>
      <p className={SECTION_BODY}>
        Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die
        wir von Ihnen erhalten haben, unverzüglich und spätestens binnen
        vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über
        Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese
        Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der
        ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde
        ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen
        dieser Rückzahlung Entgelte berechnet.
      </p>
      <p className={SECTION_BODY}>
        Haben Sie verlangt, dass die Dienstleistung während der Widerrufsfrist
        beginnen soll, so haben Sie uns einen angemessenen Betrag zu zahlen, der
        dem Anteil der bis zu dem Zeitpunkt, zu dem Sie uns von der Ausübung des
        Widerrufsrechts hinsichtlich dieses Vertrags unterrichten, bereits
        erbrachten Dienstleistungen im Vergleich zum Gesamtumfang der im Vertrag
        vorgesehenen Dienstleistungen entspricht.
      </p>

      <h3 className={SECTION_HEADING}>Muster-Widerrufsformular</h3>
      <p className={SECTION_BODY}>
        (Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses
        Formular aus und senden Sie es zurück.)
      </p>
      <ul className={LIST}>
        <li>
          An: Leon Karim Valentin – SaFix, Ihmepassage 6, 30449 Hannover,
          E-Mail: {SUPPORT_EMAIL}
        </li>
        <li>
          Hiermit widerrufe(n) ich/wir den von mir/uns abgeschlossenen Vertrag
          über die Erbringung der folgenden Dienstleistung: SaFix Pro
          Abonnement
        </li>
        <li>Bestellt am</li>
        <li>Name des/der Verbraucher(s)</li>
        <li>Anschrift des/der Verbraucher(s)</li>
        <li>Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier)</li>
        <li>Datum</li>
      </ul>
    </div>
  )
}

export function LegalEulaContent() {
  return (
    <div className="space-y-3">
      <p className={SECTION_BODY}>
        Diese Nutzungs- und Community-Richtlinien gelten für alle von Nutzern
        erstellten Inhalte und für das Verhalten auf der SaFix-Plattform.
      </p>

      <h3 className={SECTION_HEADING}>
        Null-Toleranz für anstößige Inhalte und missbräuchliches Verhalten
      </h3>
      <p className={SECTION_BODY}>
        SaFix verfolgt eine Null-Toleranz-Politik gegenüber anstößigen,
        rechtswidrigen, belästigenden, bedrohlichen, diskriminierenden,
        gewaltverherrlichenden, sexuell expliziten oder anderweitig
        missbräuchlichen Inhalten. Dies gilt für alle von Nutzern erstellten
        Inhalte, insbesondere Nachrichten im In-App-Chat, geteilte Inhalte,
        Fotos und 3D-Raumaufnahmen.
      </p>
      <p className={SECTION_BODY}>
        Mit der Nutzung von SaFix verpflichten Sie sich, keine derartigen
        Inhalte zu erstellen, zu senden, hochzuladen oder zu teilen und sich
        nicht missbräuchlich gegenüber anderen Nutzern zu verhalten.
      </p>

      <h3 className={SECTION_HEADING}>Maßnahmen bei Verstößen</h3>
      <p className={SECTION_BODY}>
        Verstöße können ohne Vorankündigung zur Entfernung der betreffenden
        Inhalte sowie zur sofortigen Sperrung oder dauerhaften Entfernung des
        verantwortlichen Nutzerkontos führen. Gemeldete Verstöße prüfen und
        bearbeiten wir innerhalb von 24 Stunden; bestätigte verletzende Inhalte
        werden entfernt und verantwortliche Nutzer von der Plattform
        ausgeschlossen.
      </p>

      <h3 className={SECTION_HEADING}>Inhalte melden und Nutzer blockieren</h3>
      <p className={SECTION_BODY}>
        In jedem Chat und bei jedem geteilten Inhalt können Sie anstößige
        Inhalte über die Funktion „Melden" an uns übermitteln. Nutzer, die sich
        missbräuchlich verhalten, können Sie jederzeit über „Blockieren" sperren;
        geblockte Nutzer können Ihnen keine Nachrichten oder Inhalte mehr
        senden.
      </p>

      <h3 className={SECTION_HEADING}>Kontakt</h3>
      <p className={SECTION_BODY}>
        Bei Fragen oder zur Meldung von Missbrauch erreichen Sie uns unter{' '}
        <SupportMail />.
      </p>
    </div>
  )
}

export function LegalDatenschutzContent() {
  return (
    <div className="space-y-3">
      <h3 className={SECTION_HEADING}>1. Verantwortlicher</h3>
      <p className={SECTION_BODY}>
        Verantwortlich für die Datenverarbeitung im Sinne der DSGVO ist:
        <br />
        Leon Karim Valentin – SaFix, Ihmepassage 6, 30449 Hannover,
        Deutschland.
        <br />
        E‑Mail: <SupportMail />
      </p>
      <p className={SECTION_BODY}>
        Die Bestellung eines Datenschutzbeauftragten ist gesetzlich nicht
        erforderlich.
      </p>

      <h3 className={SECTION_HEADING}>2. Welche Daten wir verarbeiten</h3>
      <p className={SECTION_BODY}>
        Je nach Nutzung verarbeiten wir folgende Kategorien personenbezogener
        Daten:
      </p>
      <ul className={LIST}>
        <li>
          Konto- und Anmeldedaten: E‑Mail-Adresse, Passwort (verschlüsselt).
        </li>
        <li>
          Profildaten: Name, Standort, Gewerk, Telefonnummer, bei
          Handwerksbetrieben zusätzlich Firmen- und Geschäftsanschrift.
        </li>
        <li>
          Auftrags- und Projektdaten, Angebote, Rechnungen, Terminplanung.
        </li>
        <li>Nachrichten und Inhalte aus dem In-App-Chat.</li>
        <li>
          Hochgeladene Fotos und Videos sowie 3D-Raumaufnahmen (Raum-Scans),
          die Innenräume privater Wohnungen abbilden können.
        </li>
        <li>
          Zahlungs- und Auszahlungsdaten: Beträge und Zahlungsstatus; beim
          Auszahlungs-Onboarding von Handwerksbetrieben werden Identitäts-,
          Bank- (IBAN), Geburts- und Steuerdaten unmittelbar durch unseren
          Zahlungsdienstleister Stripe erhoben.
        </li>
        <li>
          Gesundheitsdaten (besondere Kategorie nach Art. 9 DSGVO): Wenn ein
          Betrieb die Funktion zur Hinterlegung von Arbeitsunfähigkeits-
          bescheinigungen (Krankmeldungen) seiner Mitarbeiter nutzt, werden die
          entsprechenden Dokumente verarbeitet.
        </li>
        <li>
          Technische Daten: Geräte-/Installations-Informationen,
          Push-Geräte-Token, Diagnosedaten bei Fehlern.
        </li>
      </ul>

      <h3 className={SECTION_HEADING}>3. Zwecke und Rechtsgrundlagen</h3>
      <p className={SECTION_BODY}>
        Die Verarbeitung erfolgt zur Bereitstellung der Plattform und zur
        Durchführung der über sie geschlossenen Verträge (Art. 6 Abs. 1 lit. b
        DSGVO), auf Grundlage Ihrer Einwilligung (Art. 6 Abs. 1 lit. a DSGVO,
        z. B. Push-Mitteilungen) sowie zur Wahrung berechtigter Interessen an
        Sicherheit, Stabilität und Missbrauchsvermeidung (Art. 6 Abs. 1 lit. f
        DSGVO). Gesundheitsdaten (Krankmeldungen) verarbeiten wir im Auftrag des
        jeweiligen Betriebs auf Grundlage von Art. 9 Abs. 2 lit. b DSGVO in
        Verbindung mit dem Arbeitsrecht.
      </p>

      <h3 className={SECTION_HEADING}>4. Empfänger und Auftragsverarbeiter</h3>
      <p className={SECTION_BODY}>
        Soweit folgende Dienstleister personenbezogene Daten in unserem Auftrag
        verarbeiten, geschieht dies auf Grundlage von Verträgen zur
        Auftragsverarbeitung nach Art. 28 DSGVO:
      </p>
      <ul className={LIST}>
        <li>
          <strong>Supabase</strong> (Backend, Datenbank, Datei-Speicher) –
          Konto, Datenspeicherung, Medien. Server-Standort Europäische Union
          (Irland).
        </li>
        <li>
          <strong>Stripe Payments Europe, Ltd.</strong> (Irland) –
          Zahlungsabwicklung, Absicherung der Zahlungen und Auszahlungen,
          Connect-Onboarding.
        </li>
        <li>
          <strong>RevenueCat, Inc.</strong> (USA) – Verwaltung der
          In-App-Abonnements; pseudonyme Nutzerkennung sowie Kauf- und
          Abostatus.
        </li>
        <li>
          <strong>Resend</strong> (USA) – Versand von Transaktions-E-Mails;
          Empfänger-E-Mail-Adresse.
        </li>
        <li>
          <strong>Sentry</strong> (Functional Software, Inc., USA) – Fehler- und
          Absturzdiagnose; pseudonyme Nutzerkennung. Inhalte und IP-Adressen
          werden nicht standardmäßig übertragen.
        </li>
        <li>
          <strong>Apple</strong> (APNs, StoreKit, App Store) –
          Push-Benachrichtigungen (Geräte-Token) und Abwicklung der
          In-App-Käufe.
        </li>
        <li>
          <strong>Upstash</strong> – technisches Rate-Limiting; pseudonyme
          Nutzerkennung.
        </li>
        <li>
          <strong>Vercel</strong> (USA) – Hosting der Web-Anwendung und der
          API-Endpunkte.
        </li>
      </ul>

      <h3 className={SECTION_HEADING}>5. Datenübermittlung in Drittländer</h3>
      <p className={SECTION_BODY}>
        Einzelne der genannten Dienstleister (insbesondere RevenueCat, Resend,
        Sentry, Apple, Vercel) verarbeiten Daten in den USA. Soweit diese
        Empfänger unter dem EU-US Data Privacy Framework zertifiziert sind,
        erfolgt die Übermittlung auf Grundlage des Angemessenheitsbeschlusses
        der EU-Kommission vom 10. Juli 2023 (Art. 45 DSGVO). Ergänzend stützen
        wir uns auf die Standardvertragsklauseln der EU-Kommission (Art. 46
        Abs. 2 lit. c DSGVO). Eine Kopie der Garantien stellen wir auf Anfrage
        bereit.
      </p>

      <h3 className={SECTION_HEADING}>6. Push-Benachrichtigungen</h3>
      <p className={SECTION_BODY}>
        Wenn Sie Push-Mitteilungen aktivieren, verarbeiten wir einen
        Geräte-Push-Token (über den Apple Push Notification service), um Ihnen
        Benachrichtigungen zu Aufträgen und Nachrichten zu senden.
        Rechtsgrundlage ist Ihre Einwilligung über die Systemabfrage (Art. 6
        Abs. 1 lit. a DSGVO), für vertragsbezogene Mitteilungen Art. 6 Abs. 1
        lit. b DSGVO. Sie können Push-Mitteilungen jederzeit in den
        Geräteeinstellungen deaktivieren.
      </p>

      <h3 className={SECTION_HEADING}>7. Lokale Speicherung</h3>
      <p className={SECTION_BODY}>
        SaFix speichert ein Authentifizierungs-Token (JWT) im lokalen Speicher
        Ihres Geräts, um Ihre Sitzung aufrechtzuerhalten. Wir verwenden keine
        Tracking-Cookies und kein Fingerprinting.
      </p>

      <h3 className={SECTION_HEADING}>8. Speicherdauer und Löschung</h3>
      <p className={SECTION_BODY}>
        Wir speichern personenbezogene Daten nur so lange, wie es für die
        genannten Zwecke erforderlich ist oder gesetzliche Aufbewahrungsfristen
        es verlangen.
      </p>
      <p className={SECTION_BODY}>
        Konto-Löschung: Sie können Ihr Konto jederzeit unter Profil → „Konto
        löschen" löschen. Dabei werden Ihre personenbezogenen Nutzerdaten,
        Profilangaben, Medien, Chat-Inhalte und Raum-Scans gelöscht.
      </p>
      <p className={SECTION_BODY}>
        Solange für Sie eine über unseren Zahlungsdienstleister Stripe
        abgesicherte Zahlung läuft, eine Auszahlung aussteht oder ein
        Zahlungsstreit nicht abgeschlossen ist, kann das Konto aus Abrechnungs-
        und Sicherheitsgründen nicht gelöscht werden; bitte schließen Sie diese
        Vorgänge zuvor ab.
      </p>
      <p className={SECTION_BODY}>
        Steuer- und abrechnungsrelevante Unterlagen — insbesondere ausgestellte
        Rechnungen — bewahren wir auch nach der Konto-Löschung gemäß gesetzlichen
        Aufbewahrungspflichten auf (§ 147 AO, § 257 HGB; Rechnungsinhalte nach
        § 14 UStG, regelmäßig bis zu 10 Jahre). Die Verarbeitung dieser Daten wird
        nach der Löschung auf das gesetzlich Erforderliche eingeschränkt (gesperrt)
        und nach Fristablauf gelöscht (Art. 17 Abs. 3 lit. b DSGVO).
      </p>
      <p className={SECTION_BODY}>
        Damit verbundene Geschäftsvorgänge (z. B. abgeschlossene Aufträge) bleiben
        als anonymisierte Datensätze erhalten; Ihr Name wird darin entfernt bzw.
        durch „Gelöschter Nutzer" ersetzt.
      </p>

      <h3 className={SECTION_HEADING}>9. Daten von Mitarbeitern eines Betriebs</h3>
      <p className={SECTION_BODY}>
        Legt ein Handwerksbetrieb Daten seiner Mitarbeiter in der App an oder
        verarbeitet er sie über die App (z. B. Name, Kontaktdaten, Rolle,
        Arbeitszeiten), bleibt der Betrieb hierfür datenschutzrechtlich
        Verantwortlicher; SaFix handelt insoweit als Auftragsverarbeiter (Art. 28
        DSGVO). Die Information der betroffenen Mitarbeiter nach Art. 13/14 DSGVO
        obliegt dem Betrieb. Für die eigenen Konto- und Anmeldedaten eines
        Mitarbeiters, der sich selbst registriert, ist SaFix eigener
        Verantwortlicher.
      </p>

      <h3 className={SECTION_HEADING}>10. Mindestalter</h3>
      <p className={SECTION_BODY}>
        SaFix richtet sich an Personen ab 16 Jahren (Art. 8 DSGVO).
      </p>

      <h3 className={SECTION_HEADING}>
        11. Keine automatisierte Entscheidungsfindung
      </h3>
      <p className={SECTION_BODY}>
        Eine ausschließlich automatisierte Entscheidungsfindung einschließlich
        Profiling im Sinne des Art. 22 DSGVO findet nicht statt.
      </p>

      <h3 className={SECTION_HEADING}>12. Ihre Rechte</h3>
      <p className={SECTION_BODY}>
        Sie haben das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16),
        Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18),
        Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO). Erteilte
        Einwilligungen können Sie jederzeit mit Wirkung für die Zukunft
        widerrufen (Art. 7 Abs. 3 DSGVO); die Rechtmäßigkeit der bis zum Widerruf
        erfolgten Verarbeitung bleibt unberührt. Zur Ausübung Ihrer Rechte
        erreichen Sie uns unter <SupportMail />.
      </p>
      <p className={SECTION_BODY}>
        Unbeschadet anderer Rechtsbehelfe haben Sie das Recht, sich bei einer
        Aufsichtsbehörde zu beschweren (Art. 77 DSGVO). Für uns zuständig ist:
        Die Landesbeauftragte für den Datenschutz Niedersachsen,
        Prinzenstraße 5, 30159 Hannover.
      </p>
    </div>
  )
}

export function LegalImpressumContent() {
  return (
    <div className="space-y-3">
      <h3 className={SECTION_HEADING}>Angaben gemäß § 5 DDG</h3>
      <p className={SECTION_BODY}>
        Leon Karim Valentin – SaFix
        <br />
        Ihmepassage 6
        <br />
        30449 Hannover
        <br />
        Deutschland
      </p>
      <p className={SECTION_BODY}>
        E‑Mail: <SupportMail />
        <br />
        Telefon: +49 1517 2162496
      </p>
      <p className={SECTION_BODY}>
        Verantwortlich für den Inhalt: Leon Karim Valentin
      </p>
      <h3 className={SECTION_HEADING}>Umsatzsteuer</h3>
      <p className={SECTION_BODY}>
        Als Kleinunternehmer im Sinne von § 19 UStG wird keine Umsatzsteuer
        ausgewiesen; eine Umsatzsteuer-Identifikationsnummer besteht daher
        nicht.
      </p>
      <h3 className={SECTION_HEADING}>Verbraucherstreitbeilegung</h3>
      <p className={SECTION_BODY}>
        Wir sind nicht bereit und nicht verpflichtet, an
        Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle
        teilzunehmen.
      </p>
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const LEGAL_CONTENT: Record<LegalSection, ComponentType> = {
  agb: LegalAgbContent,
  anbieter_agb: LegalAnbieterAgbContent,
  avv: LegalAvvContent,
  datenschutz: LegalDatenschutzContent,
  widerruf: LegalWiderrufContent,
  eula: LegalEulaContent,
  impressum: LegalImpressumContent,
}
