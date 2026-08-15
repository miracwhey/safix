-- ===========================================================================
-- SEC M3/M4 — media_uploads INSERT party-scoping + SELECT narrowing
-- ===========================================================================
--
-- POSTEN: MUPLOADS — cross-tenant injection via media_uploads.entity_id
--
-- HOLE 1 — INSERT WITH CHECK too narrow (entity_id unconstrained):
--   Current prod policy `media_uploads_insert_own`:
--     WITH CHECK (owner_user_id = auth.uid()::text)
--   Constrains the owner column but NOT entity_id.
--   Attack: user A uploads a storage blob to their OWN folder (passing M4),
--   then INSERTs a media_uploads row with entity_id = <B's entity id>.
--   B's profile/dispute/job/project view renders A's injected media.
--
-- HOLE 2 — SELECT USING (true) for {public} role (world-readable metadata):
--   Current prod policy `media_uploads_select_own_or_public`:
--     TO public USING (true)
--   Entire table visible to unauthenticated requests. Confirmed via recon:
--   no views, no RPCs, no anon callers exist in the codebase that need this.
--   The storage bucket (`media`) remains public (M3 flip deferred in M4),
--   so CDN URLs continue to work. Only the metadata enumeration is closed.
--
-- RECON SUMMARY (read-only MCP prod queries, 2026-06-12):
--   columns       : id(text) owner_user_id(text) entity_type(text)
--                   entity_id(text) file_path(text) public_url(text)
--                   mime_type(text) media_type(text) created_at(bigint)
--                   media_role(text) customer_visible(boolean)
--   jobs party    : customer_user_id(uuid)  craftsman_user_id(text)
--   projects party: craftsman_user_id(uuid) customer_user_id(uuid)
--   disputes party: opened_by_profile_id(uuid)  customer_profile_id(uuid)
--                   provider_id(uuid) → via providers.profile_id(uuid)
--   conversations : craftsman_user_id(uuid) customer_user_id(uuid)
--   providers     : id(uuid) profile_id(uuid) [profile_id = auth.uid()]
--   profiles      : id(uuid) = auth.uid() (standard Supabase handle_new_user)
--   anon surfaces : NONE — zero views/RPCs reference media_uploads
--
-- ENTITY TYPE COVERAGE:
--   profile   — entity_id = caller's own auth.uid()::text
--   showcase  — entity_id = a providers.id whose profile_id = auth.uid()
--   portfolio — same as showcase
--   job       — entity_id = jobs.id::text; party = customer_user_id OR
--               craftsman_user_id (text column)
--   project   — entity_id = projects.id::text; party = craftsman_user_id OR
--               customer_user_id (both uuid)
--   dispute   — entity_id = disputes.id::text; party = opened_by_profile_id
--               OR customer_profile_id OR via providers.profile_id
--   message   — entity_type declared in app enum but NO call site inserts it;
--               denied (fail-closed) until messaging-media is built and
--               party columns are confirmed
--
-- EXISTING POLICIES KEPT UNCHANGED:
--   media_uploads_delete_own        — USING (owner_user_id = auth.uid()::text)
--   media_uploads_update_own        — same
--   media_uploads_select_customer_visible — authenticated; entity_type='job'
--               AND customer_visible=true AND jobs.customer_user_id=auth.uid()
--               This policy is orthogonal and must remain — it gives customers
--               access to explicitly flagged job-progress photos. The new
--               SELECT policy below handles the craftsman (owner rule) and all
--               cross-party scenarios except customer-visible job media.
--
-- GOTCHAS APPLIED:
--   • Fail-closed: INSERT denied for any entity_type not in the named branches.
--   • No NOT(...) wrappers (NULL-poisoning safe; all guards are positive EXISTS).
--   • All media_uploads column references inside EXISTS subqueries are
--     table-qualified (media_uploads.entity_id) to prevent tautology trap
--     (feedback_rls_subquery_unqualified_column).
--   • UUID vs text: id::text = media_uploads.entity_id (safe direction —
--     no risk of invalid UUID input causing a runtime cast error).
--   • policies use PERMISSIVE (default) — OR semantics across all policies
--     on the same table and cmd, consistent with existing policy set.
--
-- SCHEMA CACHE: PostgREST reload required — NOTIFY pgrst at end of migration.
-- PAYMENT/JOB/PROJECT SYNC: not affected (no state columns touched).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- PART 1: Harden INSERT — add entity_id party-scoping
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS media_uploads_insert_own ON public.media_uploads;

CREATE POLICY media_uploads_insert_party_scoped
  ON public.media_uploads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Gate 1: caller must be the declared owner (unchanged from prior policy).
    owner_user_id = auth.uid()::text

    -- Gate 2: entity_id must correspond to an entity the caller legitimately
    -- controls. Fail-closed: any entity_type not matched below is denied.
    AND (

      -- profile: can only attach media to your own profile.
      (
        media_uploads.entity_type = 'profile'
        AND media_uploads.entity_id = auth.uid()::text
      )

      OR

      -- showcase / portfolio: caller must own the provider account.
      -- Mirrors the storage-level Branch 2 check in 20260612040000.
      (
        media_uploads.entity_type IN ('showcase', 'portfolio')
        AND EXISTS (
          SELECT 1
          FROM public.providers p
          WHERE p.id::text = media_uploads.entity_id
            AND p.profile_id = auth.uid()
        )
      )

      OR

      -- job: caller must be a party (customer or craftsman).
      -- jobs.craftsman_user_id is TEXT (historical denorm); compare as text.
      -- jobs.customer_user_id is UUID; compare uuid = uuid.
      (
        media_uploads.entity_type = 'job'
        AND EXISTS (
          SELECT 1
          FROM public.jobs j
          WHERE j.id::text = media_uploads.entity_id
            AND (
              j.customer_user_id = auth.uid()
              OR j.craftsman_user_id = auth.uid()::text
            )
        )
      )

      OR

      -- project: caller must be a party (craftsman or customer).
      -- Both columns are UUID on the projects table.
      (
        media_uploads.entity_type = 'project'
        AND EXISTS (
          SELECT 1
          FROM public.projects pr
          WHERE pr.id::text = media_uploads.entity_id
            AND (
              pr.craftsman_user_id = auth.uid()
              OR pr.customer_user_id = auth.uid()
            )
        )
      )

      OR

      -- dispute: caller must be a party.
      -- Parties: the profile that opened it, the customer's profile, or the
      -- craftsman via their provider record (provider_id → providers.profile_id).
      -- profiles.id = auth.uid() (standard Supabase handle_new_user invariant).
      (
        media_uploads.entity_type = 'dispute'
        AND EXISTS (
          SELECT 1
          FROM public.disputes d
          WHERE d.id::text = media_uploads.entity_id
            AND (
              d.opened_by_profile_id = auth.uid()
              OR d.customer_profile_id = auth.uid()
              OR EXISTS (
                SELECT 1
                FROM public.providers pv
                WHERE pv.id = d.provider_id
                  AND pv.profile_id = auth.uid()
              )
            )
        )
      )

      -- entity_type = 'message': declared in app MediaEntityType enum but no
      -- active call site passes it. Denied until the feature is built and
      -- the conversations party check is confirmed against prod columns.
      --
      -- Any other entity_type also falls through → denied (fail-closed).

    )
  );


-- ---------------------------------------------------------------------------
-- PART 2: Narrow SELECT — remove world-readable {public} USING (true)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS media_uploads_select_own_or_public ON public.media_uploads;

-- Replacement: authenticated only. Covers:
--   (a) Owner reads their own rows (all entity types — craftsman's job/project/
--       dispute uploads, provider's profile/showcase/portfolio).
--   (b) Public-facing provider content (profile avatars, showcase reels,
--       portfolio items): any authenticated user may read, because this media
--       is displayed on provider-profile and discovery screens. The storage
--       bucket is already public (CDN URLs work without auth), so narrowing
--       only the DB-metadata side is consistent and does not break rendering.
--   (c) Dispute evidence cross-party: both disputing parties need to read
--       the other's uploaded evidence (DisputeEvidenceSection, DisputeCard).
--   (d) Project media cross-party: customer reads craftsman's project photos
--       (CustomerProjectDetailScreen/ProjectMediaGrid) and vice-versa.
--
-- NOT covered here (handled by separate existing policy):
--   customer-visible job media → media_uploads_select_customer_visible
--   (entity_type='job', customer_visible=true, jobs.customer_user_id=auth.uid())
CREATE POLICY media_uploads_select_party_scoped
  ON public.media_uploads
  FOR SELECT
  TO authenticated
  USING (

    -- (a) Owner reads all of their own media rows.
    owner_user_id = auth.uid()::text

    OR

    -- (b) Public-facing provider content: any authenticated user may read
    -- profile/showcase/portfolio media regardless of who uploaded it.
    media_uploads.entity_type IN ('profile', 'showcase', 'portfolio')

    OR

    -- (c) Dispute evidence: both parties may read all evidence for a dispute
    -- they are party to (no customer_visible flag restriction for disputes).
    (
      media_uploads.entity_type = 'dispute'
      AND EXISTS (
        SELECT 1
        FROM public.disputes d
        WHERE d.id::text = media_uploads.entity_id
          AND (
            d.opened_by_profile_id = auth.uid()
            OR d.customer_profile_id = auth.uid()
            OR EXISTS (
              SELECT 1
              FROM public.providers pv
              WHERE pv.id = d.provider_id
                AND pv.profile_id = auth.uid()
            )
          )
      )
    )

    OR

    -- (d) Project media: both project parties may read.
    (
      media_uploads.entity_type = 'project'
      AND EXISTS (
        SELECT 1
        FROM public.projects pr
        WHERE pr.id::text = media_uploads.entity_id
          AND (
            pr.craftsman_user_id = auth.uid()
            OR pr.customer_user_id = auth.uid()
          )
      )
    )

    -- entity_type = 'job' non-owner reads: covered by existing policy
    -- media_uploads_select_customer_visible (customer_visible=true gate).
    -- Craftsman's own job uploads are covered by the owner branch (a) above.
    --
    -- entity_type = 'message': not yet implemented; no reads until built.
    -- Any other future entity_type: denied until an explicit branch is added.

  );


-- ---------------------------------------------------------------------------
-- Schema cache reload (defensive — RLS policy changes visible to PostgREST)
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';


-- ===========================================================================
-- ROLLBACK (run manually — reverses BOTH policy changes):
--
--   DROP POLICY IF EXISTS media_uploads_insert_party_scoped ON public.media_uploads;
--   DROP POLICY IF EXISTS media_uploads_select_party_scoped  ON public.media_uploads;
--
--   CREATE POLICY media_uploads_insert_own
--     ON public.media_uploads FOR INSERT TO authenticated
--     WITH CHECK (owner_user_id = auth.uid()::text);
--
--   CREATE POLICY media_uploads_select_own_or_public
--     ON public.media_uploads FOR SELECT TO public
--     USING (true);
--
--   NOTIFY pgrst, 'reload schema';
--
-- WARNING: rolling back restores the injection hole (entity_id unconstrained)
-- and the world-readable metadata exposure. Only roll back if the party-scoped
-- policies break a confirmed legitimate read surface.
-- ===========================================================================
