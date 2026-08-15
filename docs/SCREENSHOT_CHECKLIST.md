# SaFix — Screenshot Checkliste (App Store)

## Benötigte Größen

| Gerät | Auflösung | Status | Pflicht |
|---|---|---|---|
| iPhone 6.7" (iPhone 15 Pro Max, 16 Pro Max) | 1290 × 2796 px | ☐ | **Ja** |
| iPhone 6.5" (iPhone 11 Pro Max, XS Max) | 1242 × 2688 px | ☐ | Ja (Backward Compat) |

> Apple akzeptiert seit iOS 15+ nur noch 6.7" als Pflichtgröße.
> 6.5" bleibt empfohlen für ältere Geräte-Unterstützung.
> iPad-Screenshots optional (App ist primär iPhone-optimiert).

---

## Screenshot-Set (5 Shots)

### Screenshot 1 — Home / Projektübersicht (Kunden-Sicht)

**Route**: `/` (Customer Home, Session A: review-customer@fixup.app)  
**Zustand**: Mindestens 1 aktives Projekt + Finanzierungsstatus sichtbar  
**Was zeigen**: Projekt-Karten, Status-Badges, CTA  
**Simulator-Schritt**:
1. Login als review-customer@fixup.app
2. Home-Tab ist aktiv
3. Screenshot

**Dateiname**: `01_customer_home_<size>.png`  
**Status**: ☐ 6.7" | ☐ 6.5"

---

### Screenshot 2 — Handwerkerprofil (Explore-Sicht)

**Route**: `/explore/craftsman/<id>` (Explore Feed → Profil antippen)  
**Zustand**: Vollständiges Profil mit Avatar, Gewerk, Bewertungen sichtbar  
**Was zeigen**: Profil-Header, Bewertungs-Sterne, Portfolio-Preview  
**Simulator-Schritt**:
1. Login als review-customer@fixup.app
2. Explore-Tab → ersten Handwerker antippen
3. Screenshot auf Profil-Detail

**Dateiname**: `02_craftsman_profile_<size>.png`  
**Status**: ☐ 6.7" | ☐ 6.5"

---

### Screenshot 3 — Chat mit Angebots-Attachment

**Route**: `/messages/<threadId>` (aktiver Thread mit Angebot oder Job-Kontext)  
**Zustand**: Thread mit ThreadOfferCard oder ThreadJobContextBar sichtbar  
**Was zeigen**: Nachrichten, Angebots-Karte, Job-Status-Bar  
**Simulator-Schritt**:
1. Login als review-customer@fixup.app
2. Messages-Tab → aktiven Thread öffnen
3. Screenshot wenn Angebot/Job-Kontext sichtbar

**Dateiname**: `03_chat_offer_<size>.png`  
**Status**: ☐ 6.7" | ☐ 6.5"

---

### Screenshot 4 — Zahlungs-/Escrow-Status (Projektdetail)

**Route**: `/projects/<projectId>` (Projektdetail mit Zahlungsstatus)  
**Zustand**: Escrow-Funding-Card oder Release-Card sichtbar  
**Was zeigen**: Projekt-Zeitstrahl, Zahlungs-Status, CTAs  
**Simulator-Schritt**:
1. Login als review-customer@fixup.app
2. Home-Tab → aktives Projekt antippen
3. Screenshot auf Projektdetail mit Zahlungsbereich sichtbar

**Dateiname**: `04_project_payment_<size>.png`  
**Status**: ☐ 6.7" | ☐ 6.5"

---

### Screenshot 5 — Handwerker-Dashboard (Craftsman-Sicht)

**Route**: `/craftsman/dashboard` (Craftsman Dashboard, Session B)  
**Zustand**: KPIs + Job-Warteschlange + Heute-Block sichtbar  
**Was zeigen**: Dashboard-Tiles, Auftragsstatus, Übersicht  
**Simulator-Schritt**:
1. Login als review-craftsman@fixup.app
2. Dashboard-Tab
3. Screenshot

**Dateiname**: `05_craftsman_dashboard_<size>.png`  
**Status**: ☐ 6.7" | ☐ 6.5"

---

## Simulator Setup

```bash
# Simulator starten (Xcode erforderlich)
open -a Simulator

# Gerät für 6.7": iPhone 15 Pro Max
# Gerät für 6.5": iPhone 11 Pro Max

# Screenshots über Simulator-Menü: File → Save Screen (Cmd+S)
# Oder: xcrun simctl io booted screenshot screenshot.png
```

---

## Screenshot-Verzeichnis

Ablage im Repo: `/docs/screenshots/`

```
docs/screenshots/
  6.7/
    01_customer_home.png
    02_craftsman_profile.png
    03_chat_offer.png
    04_project_payment.png
    05_craftsman_dashboard.png
  6.5/
    01_customer_home.png
    02_craftsman_profile.png
    03_chat_offer.png
    04_project_payment.png
    05_craftsman_dashboard.png
```

> Verzeichnis `/docs/screenshots/` existiert noch nicht — vor dem ersten Screenshot anlegen.

---

## App Store Connect Upload

1. App Store Connect → App → iOS App → Versionen → Screenshots
2. Für jede Größe: Drag & Drop oder Upload
3. Reihenfolge: 01 → 02 → 03 → 04 → 05
4. Screenshot-Titel (optional): Kurze deutsche Beschreibung

---

## Qualitätskriterien

- [ ] Kein Loading-Spinner / Skeleton im sichtbaren Bereich
- [ ] Kein Placeholder-Text (z. B. „Lorem ipsum", „TODO")
- [ ] Echte Seed-Daten sichtbar (kein leerer State)
- [ ] Status-Bar sauber (keine Roaming-Zeichen, kein Demo-Modus-Banner)
- [ ] Korrekte Safe Area (kein Content hinter Notch oder Home Indicator)
- [ ] Alle Text-Elemente lesbar bei der jeweiligen Auflösung

---

**Version**: 1.0  
**Erstellt**: 2026-04-19
