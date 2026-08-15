import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getMyProfile } from '../lib/profile'
import { getOrCreateChatDirectThread } from '../lib/chat'
import AppShell from '../components/AppShell'
import ScreenSkeleton from '../components/system/ScreenSkeleton'

export default function HandleRedirectScreen() {
  const { handle } = useParams<{ handle: string }>()
  const navigate = useNavigate()
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!handle) {
      navigate('/explore', { replace: true })
      return
    }

    // profiles.handle is stored WITHOUT '@', lowercase (CHECK-enforced);
    // providers/discovery_providers.handle is stored WITH a leading '@'.
    const normalised = handle.replace(/^@/, '').toLowerCase()
    // Escape ILIKE wildcards (% _ \) so a handle containing them can't match a
    // sibling profile (or error via two matches → self-404). Handles are
    // freeform/unvalidated, so this is raw user input.
    const escaped = normalised.replace(/[\\%_]/g, '\\$&')

    let cancelled = false

    async function resolve() {
      // 1. Person handle (profiles.handle) → open/start a 1:1 direct chat.
      //    Only works for authenticated viewers (profiles read is
      //    authenticated-only after the H2b policy hardening); anon viewers
      //    fall through to the provider path. The direct-thread RPC enforces
      //    discoverability / dm_privacy / block gates, so a non-reachable
      //    person surfaces as "not found" here without leaking anything.
      const { data: person } = await supabase
        .from('profiles')
        .select('id')
        .eq('handle', normalised)
        .maybeSingle()

      if (cancelled) return

      if (person?.id) {
        try {
          const [myProfile, threadId] = await Promise.all([
            getMyProfile(),
            getOrCreateChatDirectThread(person.id as string),
          ])
          if (cancelled) return
          const base = myProfile.role === 'craftsman' ? '/craftsman/messages' : '/messages'
          navigate(`${base}/${threadId}`, { replace: true })
          return
        } catch {
          // Self, not discoverable, dm_privacy=nobody, blocked, or not signed
          // in → fall through to the provider (@Firma) resolution below.
          if (cancelled) return
        }
      }

      // 2. Provider @handle (legacy company namespace) → craftsman profile.
      const { data } = await supabase
        .from('discovery_providers')
        .select('profile_id')
        .ilike('handle', `@${escaped}`)
        .maybeSingle()
      if (cancelled) return
      if (data?.profile_id) {
        navigate(`/explore/craftsman/${data.profile_id}`, { replace: true })
      } else {
        setNotFound(true)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
  }, [handle, navigate])

  if (notFound) {
    return (
      <AppShell active="explore" className="bg-canvas">
        <section className="px-4 py-6">
          <div className="mx-auto w-full max-w-[420px] space-y-4 pt-10 text-center">
            <p className="text-[22px] font-semibold text-ink">@{handle}</p>
            <p className="text-[14px] text-ink-muted">Dieses Profil wurde nicht gefunden.</p>
            <button
              type="button"
              onClick={() => navigate('/explore', { replace: true })}
              className="mx-auto mt-2 rounded-full bg-brand px-5 py-2.5 text-[14px] font-semibold text-white transition active:scale-[0.97]"
            >
              Zurück zur Übersicht
            </button>
          </div>
        </section>
      </AppShell>
    )
  }

  return (
    <AppShell active="explore" className="bg-canvas">
      <ScreenSkeleton variant="detail" />
    </AppShell>
  )
}
