import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Home, Play, Briefcase, MessageCircle, User, ClipboardList, Camera, type LucideIcon } from 'lucide-react'
import {
  subscribeNotifications,
  getUnreadNotificationSignals,
} from '../lib/notifications'
import {
  subscribeInAppNotifications,
  getUnreadInAppNotificationCount,
} from '../lib/inAppNotifications'
import { useSession } from '../hooks/useSession'
import { useHaptics } from '../hooks/useHaptics'
import { resolveAppContext } from '../lib/access'
import { useChatBadgeCount, type ChatBadgeRole } from '../lib/chat'
import { tabPerfTap } from '../lib/debug/tabPerf'

export type BottomNavItem =
  // owner / customer
  | 'home' | 'explore' | 'messages' | 'profile' | 'verwaltung'
  // employee (worker)
  | 'worker-start' | 'worker-einsaetze' | 'worker-doku' | 'worker-nachrichten' | 'worker-konto'

type Props = {
  active?: BottomNavItem
  /** When true, renders a minimal transparent variant for immersive screens (Reels). */
  immersive?: boolean
}

type NavEntry = {
  key: BottomNavItem
  label: string
  to: string
  Icon: LucideIcon
}

function getLegacyUnreadCount(): number {
  return getUnreadNotificationSignals().length + getUnreadInAppNotificationCount()
}

function appContextToChatBadgeRole(
  context: 'owner' | 'customer' | 'employee' | 'unknown',
): ChatBadgeRole | null {
  if (context === 'owner') return 'craftsman'
  if (context === 'customer') return 'customer'
  if (context === 'employee') return 'worker'
  return null
}

const PRE_APP_PREFIXES = ['/login', '/auth/', '/gate', '/onboarding/']

export default function BottomNav({ active, immersive = false }: Props) {
  const { pathname } = useLocation()
  const session = useSession()
  const context = resolveAppContext(session)
  const haptics = useHaptics()

  // Tab tap: light selection tick on every switch. Tapping the tab you are
  // already on scrolls its active scroller back to top (native iOS parity).
  // The active tab's AppShell scroller is the BottomNav's nearest
  // [data-app-scroll] ancestor (see AppShell) — resolve it from the tapped
  // link so we never grab a sibling tab's hidden, display:none scroller.
  const handleNavTap = (e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
    tabPerfTap(to) // Step-0 instrumentation clock origin (no-op unless armed).
    haptics.selection()
    if (to === pathname) {
      const scroller = e.currentTarget.closest<HTMLElement>('[data-app-scroll]')
      scroller?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // Nav items are scoped to the resolved actor context.
  // Owner/customer use the classic 4–5 tab model.
  // Employees (workers) get a dedicated 5-tab worker shell.
  const items: NavEntry[] =
    context === 'owner'
      ? [
          { key: 'home',       label: 'Start',       to: '/craftsman/dashboard',  Icon: Home },
          { key: 'explore',    label: 'Reels',        to: '/explore',              Icon: Play },
          { key: 'verwaltung', label: 'Verwaltung',   to: '/craftsman/backoffice', Icon: Briefcase },
          { key: 'messages',   label: 'Nachrichten',  to: '/craftsman/messages',   Icon: MessageCircle },
          { key: 'profile',    label: 'Konto',        to: '/profile',              Icon: User },
        ]
      : context === 'customer'
        ? [
            { key: 'home',      label: 'Start',        to: '/',           Icon: Home },
            { key: 'explore',   label: 'Reels',        to: '/explore',    Icon: Play },
            { key: 'messages',  label: 'Nachrichten',  to: '/messages',   Icon: MessageCircle },
            { key: 'profile',   label: 'Konto',        to: '/profile',    Icon: User },
          ]
        : context === 'employee'
          ? [
              { key: 'worker-start',       label: 'Start',       to: '/worker',                Icon: Home },
              { key: 'worker-einsaetze',   label: 'Einsätze',    to: '/worker/einsaetze',      Icon: ClipboardList },
              { key: 'worker-doku',        label: 'Doku',         to: '/worker/doku',           Icon: Camera },
              { key: 'worker-nachrichten', label: 'Nachrichten',  to: '/worker/nachrichten',    Icon: MessageCircle },
              { key: 'worker-konto',       label: 'Konto',        to: '/worker/konto',          Icon: User },
            ]
          : []

  // Legacy badge count (notifications + in-app). Always live.
  const [legacyCount, setLegacyCount] = useState<number>(getLegacyUnreadCount)

  useEffect(() => {
    const refresh = () => setLegacyCount(getLegacyUnreadCount())
    const unsubSignals = subscribeNotifications(refresh)
    const unsubInApp = subscribeInAppNotifications(refresh)
    return () => {
      unsubSignals()
      unsubInApp()
    }
  }, [])

  // Per-persona chat badge count (Block D Slice 1 Phase 1b-A wire-in).
  // The hook subscribes to chatStore + user_notification_preferences and
  // returns 0 when chat-cutover is off. We additionally guard at the top
  // level so the chat-store doesn't have to load for non-cutover users.
  const chatBadgeRole = appContextToChatBadgeRole(context)
  // useChatBadgeCount must be called unconditionally (Rules of Hooks).
  const chatCount = useChatBadgeCount(chatBadgeRole ?? 'customer')
  const unreadCount = legacyCount + (chatBadgeRole !== null ? chatCount : 0)

  const messagesKey: BottomNavItem = context === 'employee' ? 'worker-nachrichten' : 'messages'

  // Never render on pre-app / onboarding routes — even if a screen forgets hideBottomNav.
  if (PRE_APP_PREFIXES.some((p) => pathname.startsWith(p))) return null

  // ── Immersive variant (Reels) — transparent overlay anchored to bottom ──
  if (immersive) {
    return (
      <nav
        aria-label="Hauptnavigation"
        className="liquid-glass-bar-dark fixed inset-x-0 bottom-0 z-40 pb-[max(0px,calc(env(safe-area-inset-bottom,0px)-8px))]"
      >
        <div className="mx-auto flex w-full max-w-[430px] items-stretch justify-around px-2 pt-1.5">
          {items.map((item) => {
            const isActive = active === item.key
            const showBadge = item.key === messagesKey && unreadCount > 0

            return (
              <NavLink
                key={item.key}
                to={item.to}
                aria-label={item.label}
                onClick={(e) => handleNavTap(e, item.to)}
                className={`group relative flex min-h-[44px] flex-1 items-center justify-center rounded-xl py-2 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-[0.9] ${
                  isActive ? 'liquid-glass-active-dark' : ''
                }`}
              >
                <item.Icon
                  size={22}
                  strokeWidth={isActive ? 2.2 : 1.7}
                  className={`transition-all duration-300 ease-out ${
                    isActive
                      ? 'text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]'
                      : 'text-white/65 group-active:text-white/90'
                  }`}
                />

                {showBadge && (
                  <span className="absolute right-3 top-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-chip bg-danger px-0.5 text-[8px] font-bold text-white shadow-[0_0_8px_rgba(239,68,68,0.5)]">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </NavLink>
            )
          })}
        </div>
      </nav>
    )
  }

  // ── Default — bottom-anchored native tab bar ────────────────────────────
  return (
    <nav
      aria-label="Hauptnavigation"
      className="liquid-glass-bar-light fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="mx-auto flex w-full max-w-[430px] items-stretch justify-around px-2 pt-1.5">
        {items.map((item) => {
          const isActive = active === item.key
          const showBadge = item.key === messagesKey && unreadCount > 0

          return (
            <NavLink
              key={item.key}
              to={item.to}
              aria-label={item.label}
              onClick={(e) => handleNavTap(e, item.to)}
              className={`group relative flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-1.5 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] active:scale-[0.92] ${
                isActive ? 'liquid-glass-active-light' : ''
              }`}
            >
              <item.Icon
                size={24}
                strokeWidth={isActive ? 2.2 : 1.8}
                className={`transition-all duration-300 ease-out ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-500 group-active:text-slate-700'
                }`}
              />

              <span
                className={`text-[10px] font-medium leading-none tracking-tight transition-all duration-300 ${
                  isActive
                    ? 'text-slate-900'
                    : 'text-slate-500 group-active:text-slate-700'
                }`}
              >
                {item.label}
              </span>

              {showBadge && (
                <span className="absolute right-2 top-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-chip bg-danger px-0.5 text-[8px] font-bold text-white shadow-[0_0_10px_rgba(239,68,68,0.4)]">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}
