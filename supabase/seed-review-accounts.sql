-- APPLY HELD: run only after explicit ja apply
-- =============================================================================
-- FixUp Review Seed: Apple App Store Review Demo Data
-- =============================================================================
-- Creates 3 review accounts with interconnected, realistic German demo data.
-- Idempotent: safe to run multiple times (ON CONFLICT / IF NOT EXISTS guards).
--
-- Accounts:
--   review-customer@fixup.app   (Customer)
--   review-craftsman@fixup.app  (Craftsman, Owner)
--   review-operator@fixup.app   (Customer + Operator)
--
-- Passwort wird NICHT mehr im Repo gehalten (Hardening-Audit 2026-07-06).
-- Vor dem Run setzen:  select set_config('app.review_seed_password', '<pw>', false);
-- Quelle des Passworts: 1Password (App-Review-Accounts). Das zuvor committete
-- Passwort ist in der Git-History und MUSS nach Abschluss des laufenden
-- App-Reviews rotiert werden (nicht vorher — ASC-Demo-Login nutzt es).
--
-- Run AFTER all migrations are applied.
-- =============================================================================

do $$
declare
  -- Fixed UUIDs so the seed is idempotent and cross-references are stable
  v_customer_id   uuid := 'a1000000-0000-4000-8000-000000000001';
  v_craftsman_id  uuid := 'a1000000-0000-4000-8000-000000000002';
  v_operator_id   uuid := 'a1000000-0000-4000-8000-000000000003';

  -- Derived IDs for related entities
  v_provider_id   uuid := 'b1000000-0000-4000-8000-000000000001';
  v_conv_id       uuid := 'c1000000-0000-4000-8000-000000000001';
  v_offer_id      uuid := 'd1000000-0000-4000-8000-000000000001';
  v_job_id        uuid := 'e1000000-0000-4000-8000-000000000001';
  v_project_id    uuid := 'f1000000-0000-4000-8000-000000000001';
  -- Second (completed) job + project + rating
  v_job2_id       uuid := 'e1000000-0000-4000-8000-000000000002';
  v_project2_id   uuid := 'f1000000-0000-4000-8000-000000000002';
  v_rating_id     uuid := '91000000-0000-4000-8000-000000000001';

  -- Timestamps (epoch ms) — conversation starts 2026-03-20, progresses over days
  v_now_ms        bigint := (extract(epoch from now()) * 1000)::bigint;
  v_day_ms        bigint := 86400000;  -- 1 day in ms
  v_conv_start    bigint;
  v_encrypted_pw  text;

begin
  v_conv_start := v_now_ms - (14 * v_day_ms);  -- 14 days ago
  -- Passwort kommt aus Session-Config statt Repo-Klartext (Hardening 2026-07-06):
  --   select set_config('app.review_seed_password', '<pw aus 1Password>', false);
  if coalesce(current_setting('app.review_seed_password', true), '') = '' then
    raise exception 'app.review_seed_password ist nicht gesetzt — Seed abgebrochen (kein Klartext-Passwort mehr im Repo).';
  end if;
  v_encrypted_pw := crypt(current_setting('app.review_seed_password', true), gen_salt('bf'));

  -- =========================================================================
  -- 1. AUTH USERS (auth.users + auth.identities)
  -- =========================================================================

  -- Customer
  -- NOTE: email_change, phone_change, recovery_token etc. must be '' not NULL.
  -- GoTrue scans these as Go strings and panics on NULL → "converting NULL to
  -- string is unsupported".
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, confirmation_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, recovery_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user, is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_customer_id, 'authenticated', 'authenticated',
    'review-customer@fixup.app', v_encrypted_pw,
    now(), now(), now(), '',
    '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}', '{}', false, false, false
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_customer_id, v_customer_id,
    jsonb_build_object('sub', v_customer_id::text, 'email', 'review-customer@fixup.app', 'email_verified', false, 'phone_verified', false),
    'email', v_customer_id::text,
    now(), now(), now()
  ) ON CONFLICT (provider, provider_id) DO NOTHING;

  -- Craftsman
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, confirmation_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, recovery_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user, is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_craftsman_id, 'authenticated', 'authenticated',
    'review-craftsman@fixup.app', v_encrypted_pw,
    now(), now(), now(), '',
    '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}', '{}', false, false, false
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_craftsman_id, v_craftsman_id,
    jsonb_build_object('sub', v_craftsman_id::text, 'email', 'review-craftsman@fixup.app', 'email_verified', false, 'phone_verified', false),
    'email', v_craftsman_id::text,
    now(), now(), now()
  ) ON CONFLICT (provider, provider_id) DO NOTHING;

  -- Operator
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at, confirmation_token,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, recovery_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user, is_anonymous
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_operator_id, 'authenticated', 'authenticated',
    'review-operator@fixup.app', v_encrypted_pw,
    now(), now(), now(), '',
    '', '', '', '', '', '', '',
    '{"provider":"email","providers":["email"]}', '{}', false, false, false
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    v_operator_id, v_operator_id,
    jsonb_build_object('sub', v_operator_id::text, 'email', 'review-operator@fixup.app', 'email_verified', false, 'phone_verified', false),
    'email', v_operator_id::text,
    now(), now(), now()
  ) ON CONFLICT (provider, provider_id) DO NOTHING;

  -- =========================================================================
  -- 2. PROFILES
  -- =========================================================================

  INSERT INTO public.profiles (id, role, display_name, onboarding_done, craftsman_role, is_operator, created_at)
  VALUES
    (v_customer_id,  'customer',  'Anna Schneider',    true,  null,    false, now()),
    (v_craftsman_id, 'craftsman', 'Thomas Weber',      true,  'owner', false, now()),
    (v_operator_id,  'craftsman', 'FixUp Moderation',  true,  'owner', true,  now())
  ON CONFLICT (id) DO UPDATE SET
    role = EXCLUDED.role,
    display_name = EXCLUDED.display_name,
    onboarding_done = EXCLUDED.onboarding_done,
    craftsman_role = EXCLUDED.craftsman_role,
    is_operator = EXCLUDED.is_operator;

  -- =========================================================================
  -- 3. PROVIDER (Craftsman business profile)
  -- =========================================================================

  INSERT INTO public.providers (
    id, profile_id, company_name, handle, city, trade_categories,
    description, avatar_url, is_public, created_at, updated_at
  ) VALUES (
    v_provider_id,
    v_craftsman_id,
    'Weber Elektrotechnik',
    '@weberelektro',
    'Hannover',
    'Elektrik, Sanitär, Bad',
    'Meisterbetrieb für Elektroinstallationen, Sanitäranlagen und Badsanierungen in Hannover und Umgebung. Seit 12 Jahren zuverlässig im Einsatz.',
    null,  -- No avatar URL — UI shows fallback placeholder, no broken image
    true,
    now(),
    now()
  ) ON CONFLICT (id) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    handle = EXCLUDED.handle,
    city = EXCLUDED.city,
    trade_categories = EXCLUDED.trade_categories,
    description = EXCLUDED.description,
    is_public = EXCLUDED.is_public,
    updated_at = now();

  -- 3b. CRAFTSMAN_PROFILES — required by OwnerRouteGate/useCraftsmanProfileReady.
  -- Readiness (deriveProviderReadiness) checks THIS table, not providers:
  -- businessName, handle, location, tradeCategories (≥1), onboardingCompleted.
  -- Without this row every /craftsman/* route (incl. the SaFix Pro paywall)
  -- redirects the review account to /onboarding/craftsman-profile.
  INSERT INTO public.craftsman_profiles (
    user_id, business_name, handle, location, trade_categories,
    bio, onboarding_completed, created_at, updated_at
  ) VALUES (
    v_craftsman_id::text,
    'Weber Elektrotechnik',
    '@weberelektro',
    'Hannover',
    ARRAY['Elektrik','Sanitär','Bad'],
    'Meisterbetrieb für Elektroinstallationen, Sanitäranlagen und Badsanierungen in Hannover und Umgebung. Seit 12 Jahren zuverlässig im Einsatz.',
    true,
    now(),
    now()
  ) ON CONFLICT (user_id) DO UPDATE SET
    business_name = EXCLUDED.business_name,
    handle = EXCLUDED.handle,
    location = EXCLUDED.location,
    trade_categories = EXCLUDED.trade_categories,
    bio = EXCLUDED.bio,
    onboarding_completed = true,
    updated_at = now();

  -- Operator is craftsman/owner too — same gate applies
  INSERT INTO public.craftsman_profiles (
    user_id, business_name, handle, location, trade_categories,
    bio, onboarding_completed, created_at, updated_at
  ) VALUES (
    v_operator_id::text,
    'FixUp Moderation',
    '@fixup_mod',
    'Hannover',
    ARRAY['Moderation'],
    'Internes Moderations-Team',
    true,
    now(),
    now()
  ) ON CONFLICT (user_id) DO UPDATE SET
    onboarding_completed = true,
    updated_at = now();

  -- Operator also needs a provider row (craftsman/owner requirement for routing)
  INSERT INTO public.providers (
    id, profile_id, company_name, handle, city, trade_categories,
    description, is_public, created_at, updated_at
  ) VALUES (
    'b1000000-0000-4000-8000-000000000002',
    v_operator_id,
    'FixUp Moderation',
    '@fixup_mod',
    'Hannover',
    'Moderation',
    'Internes Moderations-Team',
    true,   -- Must be true: onboardingCompleted fallback uses is_public
    now(),
    now()
  ) ON CONFLICT (id) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    is_public = true;

  -- =========================================================================
  -- 4. HIDE OLD TEST PROVIDERS
  -- =========================================================================
  -- Set is_public=false for all non-review providers so the Explore feed only
  -- shows the clean demo profiles to the Apple reviewer. Keep BOTH review provider
  -- rows public: the craftsman (v_provider_id) AND the operator/moderation provider
  -- (...002) — section 3 set the latter public on purpose (onboardingCompleted
  -- fallback reads is_public); excluding it here prevents this UPDATE from
  -- re-hiding it.
  --
  -- ⚠️ DESTRUCTIVE + GLOBAL — LANDMINE GUARD. This hides EVERY real provider on
  -- whatever DB this runs against (incl. prod). A hidden craftsman's reels then
  -- vanish for all other accounts. It is REVERSIBLE: run
  -- `supabase/seed-review-accounts-restore.sql` after the review to re-publish
  -- everyone this hid. Craftsmen can also self-republish via the dashboard
  -- "Dein Profil ist versteckt" banner / the visibility toggle in the edit
  -- profile screen (providers.is_public). Do NOT run this seed on prod without
  -- planning the restore.

  UPDATE public.providers
  SET is_public = false, updated_at = now()
  WHERE id NOT IN (v_provider_id, 'b1000000-0000-4000-8000-000000000002'::uuid)
    AND is_public = true;

  -- =========================================================================
  -- 5. CONVERSATION (Customer ↔ Craftsman)
  -- =========================================================================

  INSERT INTO public.conversations (
    id, customer_user_id, craftsman_user_id,
    customer_name, customer_avatar_url,
    craftsman_name, craftsman_handle, craftsman_avatar_url,
    project_title, project_subtitle, project_location,
    project_cost_range, project_duration, project_status_label,
    inquiry_origin, created_at, unread_count, reviewed_at
  ) VALUES (
    v_conv_id,
    v_customer_id,
    v_craftsman_id,
    'Anna Schneider', '',
    'Weber Elektrotechnik', '@weberelektro', '',
    'Badezimmer-Sanierung',
    'Komplette Badsanierung inkl. Fliesen und Sanitär',
    'Hannover-Linden',
    '2.500–4.000 €',
    '2–3 Wochen',
    'In Arbeit',
    'profile',
    v_conv_start,
    0,
    v_conv_start + (2 * v_day_ms)  -- reviewed 2 days after creation
  ) ON CONFLICT (id) DO UPDATE SET
    customer_name = EXCLUDED.customer_name,
    craftsman_name = EXCLUDED.craftsman_name,
    project_title = EXCLUDED.project_title,
    project_status_label = EXCLUDED.project_status_label,
    unread_count = EXCLUDED.unread_count;

  -- =========================================================================
  -- 6. MESSAGES (realistic German dialog)
  -- =========================================================================
  -- sender_user_id = actual UUID of who sent it
  -- content = message text
  -- created_at = bigint epoch ms

  -- Message 1: Customer asks about bathroom renovation
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_001',
    v_conv_id,
    v_customer_id,
    'Hallo Herr Weber, ich suche einen Handwerker für eine Badsanierung in Linden. Das Bad ist ca. 8m² und soll komplett neu gemacht werden — Fliesen, Dusche, Waschbecken. Haben Sie gerade Kapazitäten?',
    v_conv_start
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 2: Craftsman responds
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_002',
    v_conv_id,
    v_craftsman_id,
    'Guten Tag Frau Schneider! Ja, das klingt nach einem Projekt, das gut zu uns passt. 8m² Komplettsanierung machen wir regelmäßig. Wann könnte ich mir das Bad vor Ort anschauen?',
    v_conv_start + (3 * 3600000)  -- 3 hours later
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 3: Customer suggests time
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_003',
    v_conv_id,
    v_customer_id,
    'Super! Wie wäre es am Donnerstag Nachmittag? Ab 14 Uhr bin ich da.',
    v_conv_start + (4 * 3600000)
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 4: Craftsman confirms
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_004',
    v_conv_id,
    v_craftsman_id,
    'Donnerstag 14 Uhr passt. Ich bringe ein Aufmaßblatt mit und kann Ihnen direkt vor Ort eine Einschätzung geben. Bis dann!',
    v_conv_start + (5 * 3600000)
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 5: After site visit — craftsman sends estimate
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_005',
    v_conv_id,
    v_craftsman_id,
    'Frau Schneider, danke für die Besichtigung. Wie besprochen: Komplettsanierung inkl. Fliesen, bodengleiche Dusche, neues Waschbecken und alle Sanitäranschlüsse. Ich erstelle Ihnen jetzt ein Angebot über FixUp.',
    v_conv_start + (4 * v_day_ms)  -- 4 days later
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 6: Customer accepts
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_006',
    v_conv_id,
    v_customer_id,
    'Das Angebot sieht fair aus, ich nehme es an! Wann können Sie starten?',
    v_conv_start + (5 * v_day_ms)
  ) ON CONFLICT (id) DO NOTHING;

  -- Message 7: Craftsman confirms start
  INSERT INTO public.messages (id, conversation_id, sender_user_id, content, created_at)
  VALUES (
    'msg_review_007',
    v_conv_id,
    v_craftsman_id,
    'Sehr gut! Wir starten nächsten Montag mit dem Rückbau. Die Materialien bestelle ich diese Woche. Über FixUp halten wir Sie zum Fortschritt auf dem Laufenden.',
    v_conv_start + (5 * v_day_ms) + (2 * 3600000)
  ) ON CONFLICT (id) DO NOTHING;

  -- =========================================================================
  -- 6b. LIVE CHAT THREAD (chat_threads / chat_participants / chat_messages)
  -- =========================================================================
  -- The legacy conversations/messages rows above satisfy offers.conversation_id
  -- (FK → conversations) and old reads. The LIVE app renders chat from
  -- chat_threads — mirror the same dialog here so the Apple reviewer actually sees
  -- the conversation in the chat list. Thread id = v_conv_id so
  -- jobs.source_conversation_id resolves to a real thread. Seed runs elevated, so
  -- RLS (incl. the new moderation gate) does not block these inserts.

  -- legacy_source CHECK only allows 'conversations' | 'message_threads' | NULL;
  -- this is a genuinely new seed thread, so leave the legacy_* columns NULL.
  -- channel_type='customer' requires customer_user_id + craftsman_user_id +
  -- provider_id all NOT NULL (chat_threads_customer_channel_check) — all set.
  INSERT INTO public.chat_threads (
    id, channel_type, customer_user_id, craftsman_user_id, provider_id,
    title, created_at, updated_at
  ) VALUES (
    v_conv_id, 'customer', v_customer_id, v_craftsman_id, v_provider_id,
    'Badezimmer-Sanierung',
    v_conv_start, v_conv_start + (5 * v_day_ms) + (2 * 3600000)
  ) ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO public.chat_participants (thread_id, user_id, role, joined_at)
  VALUES
    (v_conv_id, v_customer_id,  'customer',  v_conv_start),
    (v_conv_id, v_craftsman_id, 'craftsman', v_conv_start)
  ON CONFLICT (thread_id, user_id) DO NOTHING;

  INSERT INTO public.chat_messages (
    id, thread_id, sender_user_id, client_message_id, body, message_type, created_at
  ) VALUES
    ('c2000000-0000-4000-8000-000000000001'::uuid, v_conv_id, v_customer_id,  gen_random_uuid(),
     'Hallo Herr Weber, ich suche einen Handwerker für eine Badsanierung in Linden. Das Bad ist ca. 8m² und soll komplett neu gemacht werden — Fliesen, Dusche, Waschbecken. Haben Sie gerade Kapazitäten?',
     'text', v_conv_start),
    ('c2000000-0000-4000-8000-000000000002'::uuid, v_conv_id, v_craftsman_id, gen_random_uuid(),
     'Guten Tag Frau Schneider! Ja, das klingt nach einem Projekt, das gut zu uns passt. 8m² Komplettsanierung machen wir regelmäßig. Wann könnte ich mir das Bad vor Ort anschauen?',
     'text', v_conv_start + (3 * 3600000)),
    ('c2000000-0000-4000-8000-000000000003'::uuid, v_conv_id, v_customer_id,  gen_random_uuid(),
     'Super! Wie wäre es am Donnerstag Nachmittag? Ab 14 Uhr bin ich da.',
     'text', v_conv_start + (4 * 3600000)),
    ('c2000000-0000-4000-8000-000000000004'::uuid, v_conv_id, v_craftsman_id, gen_random_uuid(),
     'Donnerstag 14 Uhr passt. Ich bringe ein Aufmaßblatt mit und kann Ihnen direkt vor Ort eine Einschätzung geben. Bis dann!',
     'text', v_conv_start + (5 * 3600000)),
    ('c2000000-0000-4000-8000-000000000005'::uuid, v_conv_id, v_craftsman_id, gen_random_uuid(),
     'Frau Schneider, danke für die Besichtigung. Wie besprochen: Komplettsanierung inkl. Fliesen, bodengleiche Dusche, neues Waschbecken und alle Sanitäranschlüsse. Ich erstelle Ihnen jetzt ein Angebot über FixUp.',
     'text', v_conv_start + (4 * v_day_ms)),
    ('c2000000-0000-4000-8000-000000000006'::uuid, v_conv_id, v_customer_id,  gen_random_uuid(),
     'Das Angebot sieht fair aus, ich nehme es an! Wann können Sie starten?',
     'text', v_conv_start + (5 * v_day_ms)),
    ('c2000000-0000-4000-8000-000000000007'::uuid, v_conv_id, v_craftsman_id, gen_random_uuid(),
     'Sehr gut! Wir starten nächsten Montag mit dem Rückbau. Die Materialien bestelle ich diese Woche. Über FixUp halten wir Sie zum Fortschritt auf dem Laufenden.',
     'text', v_conv_start + (5 * v_day_ms) + (2 * 3600000))
  ON CONFLICT (id) DO NOTHING;

  -- Roll up thread + participant previews to the last message
  UPDATE public.chat_threads SET
    last_message_id   = 'c2000000-0000-4000-8000-000000000007'::uuid,
    last_message_at   = v_conv_start + (5 * v_day_ms) + (2 * 3600000),
    last_message_body = 'Sehr gut! Wir starten nächsten Montag mit dem Rückbau. Die Materialien bestelle ich diese Woche. Über FixUp halten wir Sie zum Fortschritt auf dem Laufenden.'
  WHERE id = v_conv_id;

  UPDATE public.chat_participants SET
    last_visible_message_id   = 'c2000000-0000-4000-8000-000000000007'::uuid,
    last_visible_message_at   = v_conv_start + (5 * v_day_ms) + (2 * 3600000),
    last_visible_message_body = 'Sehr gut! Wir starten nächsten Montag mit dem Rückbau. Die Materialien bestelle ich diese Woche. Über FixUp halten wir Sie zum Fortschritt auf dem Laufenden.',
    last_visible_message_type = 'text'
  WHERE thread_id = v_conv_id;

  -- =========================================================================
  -- 7. JOB (must come before offer due to FK on offers.created_job_id)
  -- =========================================================================

  INSERT INTO public.jobs (
    id, title, description, city, status,
    budget_amount, scheduled_for,
    customer_profile_id, provider_id, customer_user_id,
    craftsman_user_id, source_conversation_id,
    project_id, customer, location, date_label, amount, payment_state,
    documentation_status, proposal_sent_at, proposal_accepted_at,
    work_started_at,
    created_at, updated_at
  ) VALUES (
    v_job_id,
    'Badezimmer-Sanierung Linden',
    'Komplettsanierung Bad 8m²: Rückbau, Rohinstallation, Fliesen, bodengleiche Dusche, Waschbecken, Armaturen',
    'Hannover',
    'in_progress',
    3200.00,
    now() - interval '7 days',
    v_customer_id,
    v_provider_id,
    v_customer_id,
    v_craftsman_id::text,  -- jobs.craftsman_user_id is TEXT in live DB
    v_conv_id,
    v_project_id::text,
    'Anna Schneider',
    'Hannover-Linden',
    to_char(now() - interval '7 days', 'DD.MM.YYYY, HH24:MI Uhr'),
    '3.200 €',
    'in_escrow',
    '2 Fotos vorhanden',
    v_conv_start + (4 * v_day_ms),   -- proposal_sent_at
    v_conv_start + (5 * v_day_ms),   -- proposal_accepted_at
    v_conv_start + (7 * v_day_ms),   -- work_started_at
    now() - interval '14 days',
    now()
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    payment_state = EXCLUDED.payment_state,
    customer = EXCLUDED.customer,
    location = EXCLUDED.location,
    amount = EXCLUDED.amount;

  -- =========================================================================
  -- 8. OFFER (after job, because created_job_id FK → jobs.id)
  -- =========================================================================

  INSERT INTO public.offers (
    id, conversation_id, customer_user_id, craftsman_user_id,
    price, description, timing_note, status,
    created_at, updated_at, accepted_at, created_job_id,
    scope_summary, payment_terms, escrow_required,
    project_title_snapshot, location_snapshot,
    net_total, vat_rate, vat_amount, gross_total,
    labor_cost, material_cost
  ) VALUES (
    v_offer_id,
    v_conv_id,
    v_customer_id,
    v_craftsman_id,
    3200.00,
    'Komplettsanierung Bad 8m²: Rückbau, Rohinstallation, Fliesen, bodengleiche Dusche, Waschbecken, Armaturen',
    'Start nächste Woche, Dauer ca. 2–3 Wochen',
    'accepted',
    v_conv_start + (4 * v_day_ms),
    v_conv_start + (5 * v_day_ms),
    v_conv_start + (5 * v_day_ms),
    v_job_id,
    'Badsanierung inkl. Fliesen, Dusche, Waschbecken',
    '25% Anzahlung, 75% nach Abnahme',
    true,
    'Badezimmer-Sanierung',
    'Hannover-Linden',
    2689.08, 19, 510.92, 3200.00,
    2000.00, 689.08
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    accepted_at = EXCLUDED.accepted_at;

  -- Link job back to offer now that it exists
  UPDATE public.jobs SET source_offer_id = v_offer_id WHERE id = v_job_id;

  -- =========================================================================
  -- 9. PROJECT (linked to job, customer-facing)
  -- =========================================================================

  INSERT INTO public.projects (
    id, source_job_id, title,
    customer_profile_id, craftsman_user_id, customer_user_id,
    location, status, payment_state,
    created_at, updated_at
  ) VALUES (
    v_project_id,
    v_job_id,
    'Badezimmer-Sanierung',
    v_customer_id,
    v_craftsman_id,
    v_customer_id,
    'Hannover-Linden',
    'in_progress',
    'in_escrow',
    now() - interval '14 days',
    now()
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    payment_state = EXCLUDED.payment_state;

  -- =========================================================================
  -- 10. JOB FEEDBACK (for trust metrics on Explore)
  -- =========================================================================

  INSERT INTO public.job_feedback (
    id, job_id, craftsman_user_id, would_hire_again, note, created_at
  ) VALUES (
    gen_random_uuid(),
    v_job_id,
    v_craftsman_id::text,  -- TEXT column in live DB
    true,
    'Sehr zuverlässig und saubere Arbeit.',
    v_now_ms - (2 * v_day_ms)
  ) ON CONFLICT DO NOTHING;

  -- =========================================================================
  -- 11. USER REPORTS (for operator dashboard)
  -- =========================================================================

  -- Report 1: pending fraud report (customer reports an old test user)
  INSERT INTO public.user_reports (
    id, reporter_id, reported_id, reason, details, context_type, status, created_at
  ) VALUES (
    'a2000000-0000-4000-8000-000000000001'::uuid,
    v_customer_id,
    -- Use an existing old test user as the reported party
    (SELECT id FROM public.profiles WHERE id <> v_customer_id AND id <> v_craftsman_id AND id <> v_operator_id LIMIT 1),
    'fraud',
    'Handwerker hat Anzahlung erhalten, aber nie mit der Arbeit begonnen. Reagiert seit 2 Wochen nicht mehr auf Nachrichten.',
    'job',
    'pending',
    now() - interval '3 days'
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    details = EXCLUDED.details;

  -- Report 2: pending spam report
  INSERT INTO public.user_reports (
    id, reporter_id, reported_id, reason, details, context_type, status, created_at
  ) VALUES (
    'a2000000-0000-4000-8000-000000000002'::uuid,
    -- Use another existing old user as reporter
    (SELECT id FROM public.profiles WHERE id <> v_customer_id AND id <> v_craftsman_id AND id <> v_operator_id AND role = 'craftsman' LIMIT 1),
    v_customer_id,
    'spam',
    'Nutzer sendet wiederholt identische Anfragen an mehrere Handwerker ohne ernsthaftes Interesse.',
    'conversation',
    'pending',
    now() - interval '1 day'
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    details = EXCLUDED.details;

  -- Report 3: dismissed (already reviewed by operator, with notes)
  INSERT INTO public.user_reports (
    id, reporter_id, reported_id, reason, details, context_type, status,
    reviewed_by, reviewed_at, operator_notes, created_at
  ) VALUES (
    'a2000000-0000-4000-8000-000000000003'::uuid,
    v_craftsman_id,
    (SELECT id FROM public.profiles WHERE id <> v_customer_id AND id <> v_craftsman_id AND id <> v_operator_id LIMIT 1),
    'inappropriate',
    'Profilbild enthält unangemessene Inhalte.',
    'profile',
    'dismissed',
    v_operator_id,
    now() - interval '5 days',
    'Profil geprüft — Bild ist ein normales Firmenlogo, kein Verstoß erkennbar.',
    now() - interval '7 days'
  ) ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    reviewed_by = EXCLUDED.reviewed_by,
    reviewed_at = EXCLUDED.reviewed_at,
    operator_notes = EXCLUDED.operator_notes;

  -- =========================================================================
  -- 12. CLEAN UP old seed reports/blocks that used wrong data
  -- =========================================================================
  -- Remove any old blocks between review accounts (in case of re-run)
  DELETE FROM public.user_blocks
  WHERE blocker_id IN (v_customer_id, v_craftsman_id, v_operator_id)
    AND blocked_id IN (v_customer_id, v_craftsman_id, v_operator_id);

  -- =========================================================================
  -- 13. COMPLETED JOB (earlier engagement, payment released)
  -- =========================================================================

  INSERT INTO public.jobs (
    id, title, description, city, status,
    budget_amount, scheduled_for,
    customer_profile_id, provider_id, customer_user_id,
    craftsman_user_id,
    project_id, customer, location, date_label, amount, payment_state,
    documentation_status, proposal_sent_at, proposal_accepted_at,
    work_started_at, work_completed_at,
    created_at, updated_at
  ) VALUES (
    v_job2_id,
    'Küchen-Elektrik Hannover',
    'Erneuerung Steckdosen und Lichtschalter in der Küche, neue Herdanschlussleitung, DGUV-Sicherheitsüberprüfung.',
    'Hannover',
    'completed',
    850.00,
    now() - interval '42 days',
    v_customer_id,
    v_provider_id,
    v_customer_id,
    v_craftsman_id::text,
    v_project2_id::text,
    'Anna Schneider',
    'Hannover-Mitte',
    to_char(now() - interval '42 days', 'DD.MM.YYYY, HH24:MI Uhr'),
    '850 €',
    'released',
    '3 Fotos vorhanden',
    v_now_ms - (47 * v_day_ms),   -- proposal_sent_at
    v_now_ms - (45 * v_day_ms),   -- proposal_accepted_at
    v_now_ms - (42 * v_day_ms),   -- work_started_at
    v_now_ms - (28 * v_day_ms),   -- work_completed_at
    now() - interval '52 days',
    now() - interval '28 days'
  ) ON CONFLICT (id) DO UPDATE SET
    status        = EXCLUDED.status,
    payment_state = EXCLUDED.payment_state,
    work_completed_at = EXCLUDED.work_completed_at;

  -- =========================================================================
  -- 14. COMPLETED PROJECT (customer-facing, linked to completed job)
  -- =========================================================================

  INSERT INTO public.projects (
    id, source_job_id, title,
    customer_profile_id, craftsman_user_id, customer_user_id,
    location, status, payment_state,
    created_at, updated_at
  ) VALUES (
    v_project2_id,
    v_job2_id,
    'Küchen-Elektrik',
    v_customer_id,
    v_craftsman_id,
    v_customer_id,
    'Hannover-Mitte',
    'completed',
    'released',
    now() - interval '52 days',
    now() - interval '28 days'
  ) ON CONFLICT (id) DO UPDATE SET
    status        = EXCLUDED.status,
    payment_state = EXCLUDED.payment_state;

  -- =========================================================================
  -- 15. RATING (customer rates craftsman for completed job)
  -- =========================================================================

  INSERT INTO public.ratings (
    id, job_id, provider_user_id, customer_user_id,
    rating_score, rating_comment, created_at
  ) VALUES (
    v_rating_id,
    v_job2_id,  -- ratings.job_id is uuid (not text)
    v_craftsman_id,
    v_customer_id,
    5,
    'Sehr gute Arbeit! Alles sauber und pünktlich erledigt. Klare Empfehlung.',
    now() - interval '27 days'
  ) ON CONFLICT DO NOTHING;

  raise notice 'Review seed complete: 3 accounts, 1 conversation (7 messages), 2 jobs, 2 projects, 1 rating, 3 reports.';
end;
$$;
