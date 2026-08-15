-- Storage hardening — 2026-06-02
--
-- Buckets `media` (public, 108 objects) and `provider-media` (public, 0 objects)
-- each carry a broad PUBLIC SELECT policy on storage.objects scoped only by
-- bucket_id. With no path scoping, anyone (incl. anon) can `.list()` and
-- enumerate every object path in those buckets (advisor: public_bucket_allows_listing).
--
-- Fix: drop both broad SELECT policies. The buckets stay public, so objects keep
-- serving via fixed getPublicUrl() links (the /object/public/ route does NOT
-- consult storage.objects RLS for public buckets). The app renders exclusively
-- via persisted public_url (read from the media_uploads / provider_media DB
-- tables) and never calls .list() or queries storage.objects metadata for these
-- buckets (full repo trace = 0 hits). Upload/delete/update keep working via their
-- separate INSERT/DELETE/UPDATE policies. Net effect: anon path enumeration closed,
-- zero functional impact.
--
-- If authenticated owner-scoped listing is ever needed on `media`, add:
--   CREATE POLICY media_owner_list ON storage.objects FOR SELECT TO authenticated
--     USING (bucket_id = 'media' AND owner = auth.uid());

DROP POLICY IF EXISTS "media_bucket_select_public" ON storage.objects;
DROP POLICY IF EXISTS "Public read provider media" ON storage.objects;

NOTIFY pgrst, 'reload schema';
