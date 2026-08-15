-- ===========================================================================
-- Team-Hub Block 4 — Join-Code Hardening
-- ===========================================================================
-- Adds a default-deny audit table for failed join attempts and replaces
-- public.join_company_with_code with a hardened variant that:
--
--   1. Enforces the canonical 6-char unambiguous-charset format up front.
--   2. Rate-limits failures per auth.uid (10 / 1h).
--   3. Distinguishes status='active' / 'rotated' / other so the UI can
--      explain to the worker WHY their code was rejected.
--   4. Preserves the existing idempotency + stub-email-match path bit-for-bit
--      so existing onboarding flows keep working.
--
-- Existing behavior preserved:
--   - SECURITY DEFINER, search_path=public
--   - UPPER(TRIM(...)) normalization
--   - Re-activation of previously deactivated members
--   - Stub-email-match by lowercased email
--   - Final EXCEPTION→{ok:false, code:'unknown'} guard
--
-- The legacy 'invalid_code' reason is no longer returned — clients should
-- map the new finer-grained codes (invalid_format / not_found / rotated /
-- expired / rate_limited) but should also tolerate 'invalid_code' for
-- compatibility with mid-deploy clients.

-- ===========================================================================
-- failed_join_attempts — append-only audit (no SELECT for end users)
-- ===========================================================================

create table public.failed_join_attempts (
  id              uuid primary key default gen_random_uuid(),
  attempted_by    uuid references auth.users(id) on delete set null,
  code_input      text,
  reason          text not null,
  attempted_at    timestamptz not null default now()
);

create index failed_join_attempts_user_time_idx
  on public.failed_join_attempts (attempted_by, attempted_at desc)
  where attempted_by is not null;

create index failed_join_attempts_time_idx
  on public.failed_join_attempts (attempted_at desc);

-- Default-deny RLS. The RPC (SECURITY DEFINER) bypasses RLS for INSERTs.
-- All other access from anon/authenticated must be blocked. We REVOKE the
-- table-level grants (which postgres auto-grants via the supabase role
-- defaults) on top of RLS to defend against a config drift that flips RLS
-- off — the writes still fail.
alter table public.failed_join_attempts enable row level security;

revoke insert, update, delete, truncate on public.failed_join_attempts from anon, authenticated;
revoke select on public.failed_join_attempts from anon, authenticated;

comment on table public.failed_join_attempts is
  'Append-only audit of failed join_company_with_code attempts. Default-deny — only the SECURITY DEFINER RPC writes here. Used for rate-limiting (10 failures / 1h / auth.uid) and operator forensics.';

-- ===========================================================================
-- supabase_realtime publication — add company_join_codes
-- ===========================================================================
-- Owner-side rotate emits an UPDATE that flips the active row's status.
-- Realtime-Subscribe by Owner code-rotation UI works today (owner has
-- full RLS on the table). Worker-side subscription is *not* feasible yet
-- because workers have no SELECT policy on company_join_codes — adding
-- a policy is out of scope for Block 4 (defer to a future block 4.1 if
-- the toast UX is needed).

alter publication supabase_realtime add table public.company_join_codes;

-- ===========================================================================
-- join_company_with_code — hardened
-- ===========================================================================

create or replace function public.join_company_with_code(
  p_code      text,
  p_full_name text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_normalized_code text;
  v_uid             uuid := auth.uid();
  v_code_row        record;
  v_recent_failures int;
  v_caller_email    text;
  v_stub_id         uuid;
begin
  v_normalized_code := upper(trim(coalesce(p_code, '')));

  -- 1. Format-Check. Charset matches src/lib/company/joinCode.ts CODE_CHARS
  --    exactly: A–Z minus I/O, plus 2–9. Refusing here saves a lookup and
  --    creates an audit row the rate-limit can use.
  if v_normalized_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, left(v_normalized_code, 32), 'invalid_format');
    return jsonb_build_object(
      'ok', false,
      'error', 'Code muss 6 Zeichen aus A–Z (ohne I, O) und 2–9 sein.',
      'code', 'invalid_format'
    );
  end if;

  -- 2. Rate-Limit (UID-only — IP unavailable in PostgREST/SECURITY DEFINER context).
  if v_uid is not null then
    select count(*) into v_recent_failures
    from public.failed_join_attempts
    where attempted_by = v_uid
      and attempted_at > now() - interval '1 hour';
    if v_recent_failures >= 10 then
      return jsonb_build_object(
        'ok', false,
        'error', 'Zu viele Versuche. Bitte in einer Stunde nochmal.',
        'code', 'rate_limited'
      );
    end if;
  end if;

  -- 3. Lookup without the previous status='active' filter so we can return
  --    a precise reason for non-active rows.
  select id, provider_id, target_role, status into v_code_row
  from public.company_join_codes
  where code = v_normalized_code;

  if not found then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'not_found');
    return jsonb_build_object(
      'ok', false,
      'error', 'Code unbekannt. Bitte den aktuellen Code beim Chef erfragen.',
      'code', 'not_found'
    );
  end if;

  if v_code_row.status = 'rotated' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'rotated');
    return jsonb_build_object(
      'ok', false,
      'error', 'Dieser Code wurde geändert. Bitte den neuen Code erfragen.',
      'code', 'rotated'
    );
  end if;

  if v_code_row.status <> 'active' then
    insert into public.failed_join_attempts (attempted_by, code_input, reason)
    values (v_uid, v_normalized_code, 'expired');
    return jsonb_build_object(
      'ok', false,
      'error', 'Dieser Code ist abgelaufen.',
      'code', 'expired'
    );
  end if;

  -- 4. Idempotency — re-activate an existing membership rather than fail.
  if exists (
    select 1 from public.team_members
    where provider_id = v_code_row.provider_id and profile_id = v_uid
  ) then
    update public.team_members
       set is_active  = true,
           full_name  = coalesce(nullif(trim(p_full_name), ''), full_name),
           updated_at = now()
     where provider_id = v_code_row.provider_id and profile_id = v_uid;
    return jsonb_build_object('ok', true, 'provider_id', v_code_row.provider_id);
  end if;

  -- 5. Stub-Email-Match — preserved verbatim from the legacy implementation.
  select lower(u.email) into v_caller_email from auth.users u where u.id = v_uid;
  if v_caller_email is not null then
    select tm.id into v_stub_id
    from public.team_members tm
    where tm.provider_id = v_code_row.provider_id
      and lower(tm.email) = v_caller_email
      and tm.profile_id is null
    limit 1;
    if v_stub_id is not null then
      update public.team_members
         set profile_id = v_uid,
             full_name  = coalesce(nullif(trim(p_full_name), ''), full_name),
             is_active  = true,
             updated_at = now()
       where id = v_stub_id;
      return jsonb_build_object(
        'ok', true,
        'provider_id', v_code_row.provider_id,
        'matched_stub', true
      );
    end if;
  end if;

  -- 6. Plain insert.
  insert into public.team_members (provider_id, profile_id, full_name, role, is_active)
  values (
    v_code_row.provider_id,
    v_uid,
    coalesce(nullif(trim(p_full_name), ''), 'Mitarbeiter'),
    v_code_row.target_role,
    true
  )
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'provider_id', v_code_row.provider_id);

exception when others then
  -- Defensive last-ditch: never leak SQL errors to the worker. Audit-logged
  -- so operators can investigate genuine RPC failures.
  insert into public.failed_join_attempts (attempted_by, code_input, reason)
  values (v_uid, left(coalesce(v_normalized_code, ''), 32), 'unknown');
  return jsonb_build_object(
    'ok', false,
    'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
    'code', 'unknown'
  );
end;
$$;

comment on function public.join_company_with_code(text, text) is
  'Hardened Block-4 join-code lookup. Validates format + rate-limit + status before insert; preserves stub-email-match and idempotent re-activation. Audit rows go to public.failed_join_attempts (default-deny). Reason codes: invalid_format, not_found, rotated, expired, rate_limited, unknown.';
