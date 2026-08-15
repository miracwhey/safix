-- Batch 1A: allow audio MIME types in chat storage buckets so voice notes upload.
--
-- Root cause: the chat-customer bucket's allowed_mime_types contained NO audio
-- type, so every customer-channel voice note was rejected by Supabase Storage
-- with HTTP 400 (mime not allowed). Internal-channel voice worked because
-- chat-internal already allowed audio, which made the bug present as
-- "voice is unreliable" rather than "voice never works".
--
-- The recorder emits audio/mp4 (native iOS m4a), audio/webm (web Chrome), or
-- audio/aac (native fallback). All three must be allowed in chat-customer.
-- chat-dispute lacked audio/webm (web) + audio/aac; chat-internal lacked aac.
--
-- Additive + idempotent (distinct union) — order is irrelevant for an
-- allowlist. Applied to prod via Supabase MCP apply_migration on 2026-06-21;
-- this file mirrors that change for the repo ledger.

update storage.buckets
set allowed_mime_types = (
  select array(select distinct e from unnest(
    allowed_mime_types || array['audio/mp4','audio/aac','audio/webm']
  ) as e)
)
where id = 'chat-customer';

update storage.buckets
set allowed_mime_types = (
  select array(select distinct e from unnest(
    allowed_mime_types || array['audio/webm','audio/aac']
  ) as e)
)
where id = 'chat-dispute';

update storage.buckets
set allowed_mime_types = (
  select array(select distinct e from unnest(
    allowed_mime_types || array['audio/aac']
  ) as e)
)
where id = 'chat-internal';
