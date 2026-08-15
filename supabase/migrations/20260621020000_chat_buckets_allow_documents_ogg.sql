-- Batch 1 robustness: allow the document + Firefox-voice MIME types the chat
-- upload pipeline actually produces, so real-world attachments stop breaking.
--
-- Findings (full-pipeline audit 2026-06-21): the document tile advertises and
-- the client accepts PDF + Office + text, but the buckets only allowed
-- application/pdf — so .docx/.xlsx/.doc/.xls/.pptx/.ppt/.txt/.csv would HTTP 400
-- at Storage even after the magic-byte gate was taught to recognise them.
-- Firefox web voice notes land on audio/ogg, which only chat-internal allowed —
-- so customer + dispute voice notes from Firefox 400'd.
--
-- Archives (zip/rar/7z) are intentionally NOT added: they were dropped from the
-- client allowlist (never advertised end-to-end) — don't allow what we don't offer.
-- Video container coverage is handled in the client (VideoComposerSheet normalises
-- MP4-family mimes to bucket-allowed types and rejects unsupported ones), so no
-- video MIME changes are needed here.
--
-- Additive + idempotent (distinct union), order-insensitive for an allowlist.

-- Office + text documents -> all three chat buckets.
update storage.buckets
set allowed_mime_types = (
  select array(select distinct e from unnest(
    allowed_mime_types || array[
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'text/plain',
      'text/csv'
    ]
  ) as e)
)
where id in ('chat-customer', 'chat-internal', 'chat-dispute');

-- Firefox web voice (Ogg/Opus) -> customer + dispute (chat-internal already has it).
update storage.buckets
set allowed_mime_types = (
  select array(select distinct e from unnest(
    allowed_mime_types || array['audio/ogg']
  ) as e)
)
where id in ('chat-customer', 'chat-dispute');
