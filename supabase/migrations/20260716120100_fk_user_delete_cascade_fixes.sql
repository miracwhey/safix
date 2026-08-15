-- 20260716120100 · FK fixes for auth.users delete cascade (Bug ② Submit-Nacht 02.07.)
--
-- Verified in prod 2026-07-16 via recursive FK walk (all tables reachable from
-- auth.users through ON DELETE CASCADE/SET NULL chains, then every FK pointing
-- AT those tables with NO ACTION / RESTRICT — each such FK can abort a user
-- deletion with 23503 once the referencing table has rows).
--
-- Fixed here (the two unambiguous cases):
--
-- 1. provider_media_assets.provider_id → providers  (NO ACTION → CASCADE)
--    Actually blocked the 7-account DELETE on 2026-07-02 (23503, rows were
--    cleaned up manually). Media-asset metadata is provider-owned content;
--    the storage blobs themselves are covered by the cascade cleanup
--    (media bucket, owner-based selector). 0 orphan rows in prod —
--    constraint revalidation passes.
--
-- 2. chat_threads.dispute_id → disputes  (NO ACTION → SET NULL)
--    dispute_id is nullable and typed `string | null` in src/lib/chat/types.ts
--    with no non-null consumers. A dispute cascade-deleted by a user deletion
--    must not take down (or block behind) a thread the other participant
--    still owns.
--
-- NOT fixed here — needs a per-table product decision (all 0 rows in prod
-- today except scans=9, presales=2; latent, not acute). Tracked in Current
-- Block · Post-Review-Fixes:
--   spatial_change_orders.proposer_id        → auth.users  NO ACTION (NOT NULL)
--   spatial_pin_reviews.reviewed_by_user_id  → auth.users  NO ACTION (NOT NULL)
--   spatial_pin_reviews.provider_org_id      → providers   NO ACTION (NOT NULL)
--   spatial_rescan_requests.requested_by_user_id → auth.users NO ACTION (NOT NULL)
--   spatial_rescan_requests.provider_org_id  → providers   NO ACTION (NOT NULL)
--   scans.captured_by                        → profiles    RESTRICT  (NOT NULL)
--   provider_presales_projects.created_by_user_id → profiles RESTRICT (NOT NULL)
--   spatial_share_audit.actor_user_id        → auth.users  RESTRICT  (NOT NULL, audit table:
--     deliberate write-protection vs. DSGVO Art. 17 erasure — decide anonymize-vs-cascade)
--   company_code_audit.old_code_id/new_code_id → company_join_codes NO ACTION (nullable,
--     audit table: SET NULL candidate)
--   invoices.original_invoice_id             → invoices    NO ACTION (self-ref; §14b retention
--     likely wants RESTRICT/anonymize, not cascade)

ALTER TABLE public.provider_media_assets
  DROP CONSTRAINT provider_media_assets_provider_id_fkey,
  ADD CONSTRAINT provider_media_assets_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE CASCADE;

ALTER TABLE public.chat_threads
  DROP CONSTRAINT chat_threads_dispute_id_fkey,
  ADD CONSTRAINT chat_threads_dispute_id_fkey
    FOREIGN KEY (dispute_id) REFERENCES public.disputes(id) ON DELETE SET NULL;

-- Rollback:
-- ALTER TABLE public.provider_media_assets
--   DROP CONSTRAINT provider_media_assets_provider_id_fkey,
--   ADD CONSTRAINT provider_media_assets_provider_id_fkey
--     FOREIGN KEY (provider_id) REFERENCES public.providers(id);
-- ALTER TABLE public.chat_threads
--   DROP CONSTRAINT chat_threads_dispute_id_fkey,
--   ADD CONSTRAINT chat_threads_dispute_id_fkey
--     FOREIGN KEY (dispute_id) REFERENCES public.disputes(id);
