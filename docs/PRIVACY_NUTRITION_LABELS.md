# SaFix — Privacy Nutrition Labels (App Store Connect)

Mapping fuer die "App Privacy" Angaben in App Store Connect.
Quelle: Code-Evidenz-Audit 2026-06-03 (Frontend, iOS/Capacitor, Supabase, Edge/Vercel, Storage-Buckets prod-verifiziert).

> Tracking gesamt: **NEIN** — kein IDFA, keine Werbenetzwerke, kein Cross-App/Website-Tracking, kein Datenbroker.
> First-Party-Betriebs-Analytics (`analytics_events`) ist nach Apple-Definition KEIN "Tracking", aber dennoch "Data Linked to You".

## Datenerhebung (Data Linked to You)

| Apple-Kategorie | Datentyp | Zweck | Drittanbieter | Verknuepft? | Tracking? | Code-Evidenz |
|---|---|---|---|---|---|---|
| Contact Info | E-Mail-Adresse | Auth, Mail-Benachrichtigung, Rechnung, Widerruf | Supabase, Resend | Ja | Nein | `src/lib/auth.ts`, `api/send-notification-email.ts:47` |
| Contact Info | Name | Profil, Rechnung, Team | Supabase | Ja | Nein | `profiles.display_name`, `craftsman_profiles.business_name`, `customerBillingProfileService.ts` |
| Contact Info | Telefonnummer | Profil (HW), Rechnung, Team | Supabase | Ja | Nein | `craftsman_profiles.phone`, `customerBillingProfileService.ts:25` |
| Contact Info | Physische Adresse | Rechnung, Discovery, Auftragsort | Supabase | Ja | Nein | `customerBillingProfileService.ts:18-22`, `providers.business_address`, `projects/jobs.location` |
| Financial Info | Zahlungsinformationen (Karte) | Escrow-Zahlung | Stripe (nie in App/Backend) | Ja (bei Stripe) | Nein | `CustomerEscrowFundingCard.tsx`, `DiagnosisPaymentSheet.tsx` (nur `<PaymentElement/>`) |
| Financial Info | Sonstige Finanzdaten (IBAN/BIC, Steuer-/USt-Nr., Escrow-Betraege, Ledger, Connect-Account) | Rechnung, Escrow, Payout | Supabase, Stripe | Ja | Nein | `providers.iban/tax_number`, `escrow_payment_plans`, `ledger_entries`, `connect-account.ts` |
| Purchases | Kaufhistorie (Abo, Transaktions-IDs, Produkt-IDs) | In-App-Kauf SaFix Pro + Marktplatz-Transaktionen | RevenueCat, Apple, Supabase | Ja | Nein | `craftsman_subscriptions`, `revenuecat_webhook_events`, `api/revenuecat-webhook.ts` |
| Location | Grober Standort (Stadt/PLZ, manuell eingegeben) | Handwerkersuche, Auftragsort | Supabase | Ja | Nein | `profiles.location/city`, `projects/jobs.location` |
| Location | Praeziser Standort | NUR falls EXIF-GPS in Uploads nicht gestrippt (siehe Offene Frage B1) | Supabase | Ja | Nein | `preUploadPipeline.ts:8`, `absenceWorkflow.ts:274`, `pinWorkflow.ts:181` |
| User Content | Fotos/Videos | Profil, Projekt-/Schadens-/Auftrags-Doku, Dispute-Evidence, 3D-Pins | Supabase | Ja | Nein | Buckets `media`(public), `worker-doku-photos`/`spatial-*`(privat) |
| User Content | Audio (Sprachnachrichten, Pin-Sprachnotizen) | Chat, Raum-Pin-Memos | Supabase | Ja | Nein | `useVoiceRecorder.ts`, `pinWorkflow.ts:211` |
| User Content | Andere Nutzerinhalte (Chat-Text, Projekt-/Job-Beschreibung, Ratings, PDF-Dokumente, 3D-Raumscans/Mesh) | Kernfunktion | Supabase | Ja | Nein | `messages`/`chat_messages`, `projects`, `ratings`, `project-scans`/`spatial-*` (privat) |
| User Content | Kundensupport | Support-Anfragen | Google (Gmail) | Ja | Nein | `ProfileActionsCard.tsx:97` (`fixup.support.team@gmail.com`) |
| Sensitive Info | Gesundheitsdaten (Krankmeldung/AU-Bescheinigung) | Abwesenheits-Dokumentation (Team) | Supabase | Ja | Nein | `absenceWorkflow.ts:274`, Bucket `sick-notes` (privat) — Art. 9 DSGVO |
| Identifiers | Nutzer-ID (Supabase UUID) | Auth, Datensatz-PK, Fehlerkontext, IAP | Supabase, Sentry, RevenueCat | Ja | Nein | `supabase.ts:28`, `sentry.ts:74`, `revenueCat.ts:108` |
| Identifiers | Geraete-ID (APNs Push-Token, ggf. RevenueCat-IDFV) | Push-Benachrichtigung, IAP-Fraud | Apple, RevenueCat, Supabase | Ja | Nein | `notification_device_tokens`, `pushNotificationBridge.ts:74` |
| Usage Data | Produktinteraktion (First-Party-Events) | Betriebsmetriken (Job-Lifecycle, Zahlungen, Media-Views, Ratings) | Supabase | Ja | Nein | `analytics_events`, `SupabaseAnalyticsRepository.ts:148` |
| Usage Data | Andere Nutzungsdaten (Breadcrumbs, Perf-Spans) | Monitoring | Sentry | Ja | Nein | `observability/index.ts`, `sentry.ts` |
| Diagnostics | Crash-Daten | Fehlerdiagnose | Sentry (EU) | **Ja (User-ID verknuepft)** | Nein | `sentry.ts:74`, `session.ts:1085`, `api/_observability.ts:184` |
| Diagnostics | Performance-Daten | Monitoring (10% Sampling) | Sentry (EU) | Ja | Nein | `sentry.ts:51`, `observability/perf.ts` |

## Zusammenfassung

- **Kein Tracking.** SaFix trackt keine Nutzer ueber Apps oder Websites hinweg. Kein IDFA, keine Werbenetzwerke.
- **First-Party-Analytics vorhanden** (`analytics_events`, mit Nutzer-ID verknuepft) — KEIN "Tracking", aber als "Usage Data — Linked to You" deklarationspflichtig.
- **Crash-/Performance-Daten sind mit der Nutzer-ID verknuepft** (Sentry `setUser`) → "Data Linked to You", NICHT "Not Linked".
- **Keine reine "Data Not Linked to You"-Kategorie** — selbst Diagnose ist User-ID-verknuepft.

## Drittanbieter-Detail (vollstaendig)

| Anbieter | Verarbeitete Daten | Zweck | Serverstandort | AVV/DPA |
|---|---|---|---|---|
| Supabase | Auth, Profil, Nachrichten, Projekte, Storage, Analytics, Push-Token | Backend-Infrastruktur | EU | vorhanden |
| Stripe | Kartendaten (PCI), Connect-/Payout-Daten, Escrow | Zahlungsabwicklung | PCI DSS, US/EU | vorhanden |
| Sentry | Crash-/Perf-Logs + Breadcrumbs (User-ID-verknuepft) | Fehleranalyse | EU-Ingest (`ingest.de.sentry.io`) | PRUEFEN |
| Vercel | Request-/Server-Logs, Deploy-Metadaten | Hosting/CDN/API | Global | PRUEFEN |
| Resend | Empfaenger-E-Mail + Benachrichtigungs-Text | Transaktionale E-Mails | US | PRUEFEN |
| Upstash Redis | Rate-Limit-Counter (User-ID als Key, kein Inhalt) | Missbrauchsschutz | PRUEFEN (Region) | PRUEFEN |
| RevenueCat | App-User-ID (= Supabase UUID), StoreKit-Transaktionen, ggf. IDFV | In-App-Kauf-Verwaltung | US | PRUEFEN |
| Apple | APNs Push-Token, StoreKit-Kaeufe | Push, IAP | global (Apple) | Apple-Standard |

## Hinweise fuer App Store Connect

- Kategorie "Data Used to Track You": **Nichts** ankreuzen.
- Kategorie "Data Linked to You": Name, E-Mail, Telefon, Physische Adresse, Zahlungsinfo, Sonstige Finanzdaten, Kaufhistorie, Grober Standort, Fotos/Videos, Audio, Andere Nutzerinhalte, Kundensupport, Gesundheitsdaten (Sensitive Info), Nutzer-ID, Geraete-ID, Produktinteraktion, Andere Nutzungsdaten, Crash-Daten, Performance-Daten.
- Kategorie "Data Not Linked to You": **leer** (keine sauber unverknuepfte Kategorie vorhanden).
- Praeziser Standort NUR ankreuzen, wenn EXIF-GPS nicht gestrippt wird (offene Frage B1). Empfehlung: GPS strippen, dann NICHT ankreuzen.

## Blocker-Status (Stand 2026-06-03)

1. EXIF-GPS — **Bild-Pfade GEFIXT** (`stripImageExifIfPossible` in pinWorkflow/uploadAnnotationPhoto/absenceWorkflow; Standard-Media-Pfad strippte bereits). **Offen:** Video-Container-GPS (kein Client-Transcode) → entweder "Precise Location" deklarieren ODER serverseitig strippen; Device-`exiftool`-Spotcheck nach `cap sync`.
2. Sentry-Disclosure — **GEFIXT** in Hosted-Policy (kein "anonymisiert/keine personenbezogenen Daten" mehr; pseudonyme Nutzerkennung + Crash/Performance als Linked). In-App-Policy war bereits korrekt.
3. Gesundheitsdaten (Krankmeldung, Art. 9) — **GEFIXT** in Labels + Hosted-Policy (Art. 9 Abs. 2 lit. b DSGVO). In-App-Policy hatte es bereits.
4. Hosted Privacy Policy — **GEFIXT**: auf Parität mit der In-App-Policy gebracht (alle 8 Sub-Processors, Telefon, Rechnungsadresse, Audio, Push-Token, Gesundheit, IAP). Apple-Anforderung Policy >= Labels erfuellt.

**Verbleibend vor Submission (extern/human):** AVV/DPA Resend/Upstash/RevenueCat bestaetigen · Video-EXIF-Entscheidung · Device-Smoke nach `cap sync` (Pin-/Annotation-/Sick-Note-Upload nach EXIF-Wiring) · Dispute-Evidence aus public `media`-Bucket in privaten verschieben · `craftsman_profiles.phone`-Exposure (RLS authenticated) klaeren.
