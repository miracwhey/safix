-- APPLY HELD: run only after explicit "ja apply"
-- =============================================================================
-- provider_media_comments: add user_id → profiles(id) FK (B5 — comments broken)
-- =============================================================================
-- Posting a comment failed ("Kommentar konnte nicht gespeichert werden") and the
-- comment list was always empty. Root cause: portfolioCommentService selects
-- `author:profiles(display_name)` (an embedded relationship) on BOTH the fetch
-- and the INSERT…RETURNING, but provider_media_comments.user_id had NO foreign
-- key to profiles — so PostgREST cannot resolve the `profiles` embed (PGRST200).
-- The fetch swallowed the error → empty list; the post re-threw it → the toast.
--
-- Adding the FK makes the embed resolvable (profiles is publicly readable for
-- onboarded users, so author names populate). user_id = auth.uid() = profiles.id
-- for every signed-in user, and the table currently has 0 rows, so the
-- constraint cannot violate existing data. ON DELETE CASCADE removes a user's
-- comments when their profile/account is deleted (mirrors the account-deletion
-- cascade).
-- =============================================================================

ALTER TABLE public.provider_media_comments
  DROP CONSTRAINT IF EXISTS provider_media_comments_user_id_fkey;

ALTER TABLE public.provider_media_comments
  ADD CONSTRAINT provider_media_comments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

NOTIFY pgrst, 'reload schema';
