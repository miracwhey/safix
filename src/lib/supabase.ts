import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const browserStorage = typeof window !== 'undefined' ? window.localStorage : undefined
const isBrowser =
  typeof browserStorage?.getItem === 'function' &&
  typeof browserStorage?.setItem === 'function' &&
  typeof browserStorage?.removeItem === 'function'

// The Supabase client is always constructed at module-evaluation time because
// Supabase repository classes import it statically. When VITE_DATA_SOURCE is
// 'in-memory' this client is never actually called, so placeholder values are
// safe. When VITE_DATA_SOURCE=supabase, bootstrapRepositories() validates
// the credentials before any repository is instantiated, so any missing values
// are caught early with a clear error message rather than surfacing later as
// cryptic network failures.
//
// Note: Supabase JS >=2.98 rejects empty-string URLs at construction time,
// so we fall back to a syntactically valid placeholder that will never be
// reached in in-memory mode.
const PLACEHOLDER_URL = 'https://placeholder.supabase.co'
const PLACEHOLDER_KEY = 'placeholder'
export const supabase = createClient(supabaseUrl || PLACEHOLDER_URL, supabaseAnonKey || PLACEHOLDER_KEY, {
  auth: {
    persistSession: isBrowser,
    autoRefreshToken: isBrowser,
    detectSessionInUrl: isBrowser,
    storageKey: 'fixup.auth',
    ...(isBrowser ? { storage: browserStorage! } : {}),
  },
})

// Spatial Core · Block A.8 follow-up — Realtime CHANNEL_ERROR fix.
// `private: true` channels (used by scan_annotations + scan_measurements
// broadcasts per migration 20260518000008_scan_realtime_broadcast.sql)
// silently fail with CHANNEL_ERROR if `realtime.setAuth(token)` is not
// kept in sync with the auth session. Without this listener, pin and
// measurement live-updates never reach the SpatialViewer.
if (isBrowser) {
  void supabase.auth.getSession().then(({ data }) => {
    if (data.session?.access_token) {
      supabase.realtime.setAuth(data.session.access_token)
    }
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    supabase.realtime.setAuth(session?.access_token ?? null)
  })
}
