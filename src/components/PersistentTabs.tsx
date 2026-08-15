import { Suspense, memo, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useLocation } from 'react-router-dom'
import { useSession } from '../hooks/useSession'
import { resolveAppContext, type AppContext } from '../lib/access'
import { isPasswordRecoveryActive } from '../lib/session'
import AppShell from './AppShell'
import ScreenSkeleton from './system/ScreenSkeleton'
import TabErrorBoundary from './system/TabErrorBoundary'
import { lazyWithRetry } from './system/lazyWithRetry'
import { tabPerfMark, tabPerfMarkPaint, tabPerfWrapImport } from '../lib/debug/tabPerf'
import type { BottomNavItem } from './BottomNav'

// Tab screens are code-split per route so cold start no longer parses every
// tab of the OTHER role (a customer never downloads the craftsman dashboard
// chunk and vice-versa) and the heaviest screens leave the main entry chunk.
// `lazyWithRetry` survives transient chunk-fetch failures; a persistent
// failure (stale-chunk 404 after redeploy) is caught per-tab by
// TabErrorBoundary instead of blanking the whole shell.
// `tabPerfWrapImport` is a transparent pass-through unless the Step-0 harness
// is armed (?tabperf=on) — then it times each chunk's parse window and marks
// the screen's paint. Zero cost otherwise.
// Import factories are named so the SAME module load can be reused for both
// lazy() (mount) and idle-preload (warm the chunk before the first tap). The
// dynamic import is cached, so calling the factory during idle parses the chunk
// once; a later tab tap then resolves instantly instead of paying the parse.
const importCustomerHome = () => import('../screens/CustomerHomeScreen')
const importExploreFeed = () => import('../screens/ExploreFeed')
const importMessages = () => import('../screens/MessagesScreen')
const importProfile = () => import('../screens/ProfileScreen')
const importCraftsmanDashboard = () => import('../screens/CraftsmanDashboardScreen')
const importCraftsmanBackoffice = () => import('../screens/CraftsmanBackofficeScreen')
const importCraftsmanMessages = () => import('../screens/CraftsmanMessagesScreen')

const CustomerHomeScreen = lazyWithRetry(() => tabPerfWrapImport('home/customer', importCustomerHome))
const ExploreFeed = lazyWithRetry(() => tabPerfWrapImport('explore', importExploreFeed))
const MessagesScreen = lazyWithRetry(() => tabPerfWrapImport('messages/customer', importMessages))
const ProfileScreen = lazyWithRetry(() => tabPerfWrapImport('profile', importProfile))
const CraftsmanDashboardScreen = lazyWithRetry(() => tabPerfWrapImport('home/owner', importCraftsmanDashboard))
const CraftsmanBackofficeScreen = lazyWithRetry(() => tabPerfWrapImport('verwaltung', importCraftsmanBackoffice))
const CraftsmanMessagesScreen = lazyWithRetry(() => tabPerfWrapImport('messages/owner', importCraftsmanMessages))

// ---------------------------------------------------------------------------
// Tab definitions per app context
// ---------------------------------------------------------------------------

type TabDef = {
  path: string
  /** Nav item to highlight while the chunk loads / on the error fallback. */
  navItem: BottomNavItem
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous screen prop shapes, all rendered prop-less
  Component: LazyExoticComponent<ComponentType<any>>
  /** Same-module import factory, used to idle-preload the chunk before a tap. */
  preload: () => Promise<unknown>
  /** Reels-style immersive shell (transparent dark nav, no bottom padding). */
  immersive?: boolean
  /** Skeleton variant for the Suspense fallback. */
  skeleton?: 'detail' | 'list' | 'chat'
}

const CUSTOMER_TABS: TabDef[] = [
  { path: '/', navItem: 'home', Component: CustomerHomeScreen, preload: importCustomerHome, skeleton: 'detail' },
  { path: '/explore', navItem: 'explore', Component: ExploreFeed, preload: importExploreFeed, immersive: true },
  { path: '/messages', navItem: 'messages', Component: MessagesScreen, preload: importMessages, skeleton: 'list' },
  { path: '/profile', navItem: 'profile', Component: ProfileScreen, preload: importProfile, skeleton: 'detail' },
]

// Owner tabs only — workers use WORKER_TABS below.
const OWNER_TABS: TabDef[] = [
  { path: '/craftsman/dashboard', navItem: 'home', Component: CraftsmanDashboardScreen, preload: importCraftsmanDashboard, skeleton: 'detail' },
  { path: '/explore', navItem: 'explore', Component: ExploreFeed, preload: importExploreFeed, immersive: true },
  { path: '/craftsman/backoffice', navItem: 'verwaltung', Component: CraftsmanBackofficeScreen, preload: importCraftsmanBackoffice, skeleton: 'list' },
  { path: '/craftsman/messages', navItem: 'messages', Component: CraftsmanMessagesScreen, preload: importCraftsmanMessages, skeleton: 'list' },
  { path: '/profile', navItem: 'profile', Component: ProfileScreen, preload: importProfile, skeleton: 'detail' },
]

function getTabsForContext(context: AppContext): TabDef[] {
  if (context === 'customer') return CUSTOMER_TABS
  if (context === 'owner') return OWNER_TABS
  // Employees (workers) navigate via regular Routes — no persistent tab shell.
  // The worker BottomNav is rendered inside each screen's AppShell.
  return []
}

/**
 * Suspense fallback that keeps the app chrome on screen while a tab chunk
 * loads. Rendering inside `AppShell` (rather than a bare skeleton) means the
 * BottomNav + Header never disappear during the chunk fetch AND a
 * `[data-app-scroll]` container exists for the scroll-restore effect to find.
 */
function TabFallback({ tab }: { tab: TabDef }) {
  // Step-0: mark when the Suspense skeleton actually paints (no-op unless
  // armed). Hook runs before the immersive branch to satisfy rules-of-hooks.
  useEffect(() => {
    tabPerfMarkPaint(`fallback painted · ${tab.navItem}`)
  }, [tab.navItem])
  if (tab.immersive) {
    // Reels: dark immersive shell. `bg-black` mirrors ExploreFeed's own
    // AppShell (it paints bg-black on every return path) so the chunk-load
    // fallback never flashes the light app base (#f5f6fa) under the dark nav.
    return <AppShell active={tab.navItem} immersive className="bg-black"><div className="min-h-[100svh]" /></AppShell>
  }
  return (
    <AppShell active={tab.navItem}>
      <ScreenSkeleton variant={tab.skeleton ?? 'list'} />
    </AppShell>
  )
}

/**
 * One mounted tab's content, memoized. A tab switch re-renders PersistentTabs,
 * which without this would synchronously re-reconcile EVERY already-mounted tab
 * subtree (the hidden Home tab, its cards, its derivations) on the same commit
 * that must paint the tapped tab's skeleton. At cold start that extra work
 * competes for the main thread and delays the switch — the tap "does nothing"
 * for a beat. `tab` is a stable module-level object, so after first mount memo
 * bails on every navigation: the only per-switch work becomes the CSS display
 * toggle on the wrappers. A tab still re-renders on its OWN state/subscription
 * changes (memo only blocks parent-driven re-renders), so nothing goes stale.
 */
const TabPane = memo(function TabPane({ tab }: { tab: TabDef }) {
  return (
    <TabErrorBoundary active={tab.navItem} tabPath={tab.path}>
      <Suspense fallback={<TabFallback tab={tab} />}>
        <tab.Component />
      </Suspense>
    </TabErrorBoundary>
  )
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Keeps bottom-nav tab screens mounted across navigation so they don't
 * unmount/remount on every tab switch.  Only the active tab is visible;
 * inactive tabs are hidden via `display: none` but retain their React state
 * (form input, subscription data).  Scroll position is NOT retained by the
 * browser across a display:none toggle (WebKit resets the scrollTop of
 * scroll containers inside a hidden subtree) — it is saved per tab while
 * active and restored explicitly on re-activation, see
 * `tabScrollPositionsRef` below.
 *
 * Tab screens are lazy-loaded (code-split) but still all mounted once auth
 * settles, so switching between already-visited tabs stays instant and their
 * state/subscriptions persist. The first paint of a freshly-loaded tab shows
 * the AppShell-aware `TabFallback` (chrome intact) until its chunk resolves.
 *
 * Rendered unconditionally inside App so the DOM stays alive even when the
 * user navigates to a detail screen.  In that case all tabs are hidden.
 *
 * Tab set is determined by resolved AppContext, not raw role:
 *   - 'customer'  → customer tabs
 *   - 'owner'     → owner tabs
 *   - 'employee'  → no persistent tab shell; worker screens mount via Routes
 *   - 'unknown'   → no tab shell (session not yet resolved)
 */
export default function PersistentTabs() {
  const location = useLocation()
  const session = useSession()
  const { user, sessionValidated } = session

  // ── Per-tab scroll preservation (Block 3 scroll-twofer, additive) ────────
  // Each tab screen owns an AppShell inner scroll container
  // ([data-app-scroll]). While a tab is active, a passive scroll listener
  // mirrors its scrollTop into the map — capturing BEFORE deactivation is
  // mandatory because once the wrapper flips to display:none the container
  // reads scrollTop 0. On (re-)activation the saved offset is restored
  // pre-paint (useLayoutEffect) so the user never sees the reset frame.
  // Mount/unmount gating below is untouched (#963).
  const tabScrollPositionsRef = useRef(new Map<string, number>())
  const tabWrapperRefs = useRef(new Map<string, HTMLDivElement | null>())
  const activePathname = location.pathname

  // ── Mount-on-activation (boot interactivity on slow/throttled devices) ────
  // Mounting all tab chunks at once — even deferred to a post-paint "warm" pass
  // — fetches+parses the 4 inactive lazy chunks concurrently on the main thread.
  // On a memory/thermal-throttled device that parse storm blocks the very tab
  // tap the user just made: the navigation render queues behind it, so the tap
  // does "nothing" for a beat and then loads. Instead mount ONLY tabs the user
  // has actually visited. The active tab always renders (its Suspense fallback
  // paints instantly → a tap is always responsive), and each visited tab then
  // stays mounted so re-switches are instant and its state/subscriptions
  // survive. A first visit parses just THAT one chunk — fast even when throttled
  // — instead of competing with a 4-chunk storm. `mountedPaths` is recorded
  // during render (the documented React "remember across renders" pattern),
  // guarded so the set update runs at most once per newly-activated path.
  const [mountedPaths, setMountedPaths] = useState<Set<string>>(() => new Set())

  useLayoutEffect(() => {
    const wrapper = tabWrapperRefs.current.get(activePathname)
    if (!wrapper) return

    // The active tab's [data-app-scroll] container can mount LATER than this
    // layout effect: a lazy screen renders its TabFallback first (own
    // [data-app-scroll]) and swaps to the real screen (a fresh
    // [data-app-scroll]) only once its chunk resolves. Resolve the live
    // container on every relevant DOM change instead of once, so the scroll
    // listener + restore always bind to the element currently on screen.
    let scroller: HTMLElement | null = null
    let detach: (() => void) | null = null

    const sync = () => {
      // Cheap path: the bound container is still mounted (content just mutated)
      // → nothing to rebind.
      if (scroller && wrapper.contains(scroller)) return
      const next = wrapper.querySelector<HTMLElement>('[data-app-scroll]')
      if (next === scroller) return
      detach?.()
      scroller = next
      if (!scroller) {
        detach = null
        return
      }
      const saved = tabScrollPositionsRef.current.get(activePathname)
      if (saved !== undefined && scroller.scrollTop !== saved) {
        scroller.scrollTop = saved
      }
      const bound = scroller
      const onScroll = () => {
        tabScrollPositionsRef.current.set(activePathname, bound.scrollTop)
      }
      bound.addEventListener('scroll', onScroll, { passive: true })
      detach = () => bound.removeEventListener('scroll', onScroll)
    }

    // Synchronous bind for the common case (already-mounted tab → restore is
    // pre-paint, no regression to #963 scroll-restore on tab switches).
    sync()
    // Catch the fallback→real swap of a freshly-loaded lazy tab.
    const observer = new MutationObserver(sync)
    observer.observe(wrapper, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      detach?.()
    }
  }, [activePathname, user, sessionValidated])

  // ── Idle-preload of not-yet-opened tab chunks ───────────────────────────
  // Once the shell is up, warm the chunks the user hasn't opened so the FIRST
  // tap resolves instantly instead of paying the parse then ("tap → nothing →
  // loads"). requestIdleCallback fires only when the main thread is idle and
  // yields to pending input, so this never competes with cold-start hydration
  // OR with the tab tap it speeds up — it respects #1063 (no boot parse storm;
  // the parse happens later, during idle). Warmed-ref guards each chunk to a
  // single load. setTimeout fallback where rIC is unavailable (older WKWebView).
  const warmedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!user || !sessionValidated || isPasswordRecoveryActive()) return
    const queue = getTabsForContext(resolveAppContext(session)).filter(
      (t) => !mountedPaths.has(t.path) && !warmedRef.current.has(t.path),
    )
    if (queue.length === 0) return

    const schedule: (cb: () => void) => number =
      typeof window.requestIdleCallback === 'function'
        ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => window.setTimeout(cb, 300)
    const unschedule: (h: number) => void =
      typeof window.cancelIdleCallback === 'function'
        ? window.cancelIdleCallback
        : window.clearTimeout

    let handle = 0
    let i = 0
    const warmNext = () => {
      if (i >= queue.length) return
      const tab = queue[i++]
      warmedRef.current.add(tab.path)
      void tab.preload().catch(() => {})
      handle = schedule(warmNext) // one chunk per idle slot → stays yield-friendly
    }
    handle = schedule(warmNext)
    return () => unschedule(handle)
  }, [user, sessionValidated, session, mountedPaths])

  // Don't render anything before auth is settled or during password recovery.
  // Gate on sessionValidated, NOT loading: a warm re-validate flips loading
  // transiently while user + sessionValidated stay valid, and gating on it
  // would unmount the whole tab tree on every resume — wiping scroll position,
  // realtime subscriptions and screen state. sessionValidated already covers
  // cold start (false until validated) and account switch (reset to false on
  // SIGNED_IN); password recovery stays blocked via isPasswordRecoveryActive().
  // During recovery, PersistentTabs must stay unmounted — the tab screens'
  // effects (guided-entry subscriptions etc.) would fire on USER_UPDATED and
  // trigger profile upserts whose HTTP requests land after signOut() clears
  // the auth token, causing a "new row violates RLS" error.
  if (!user || !sessionValidated || isPasswordRecoveryActive()) return null

  const context = resolveAppContext(session)
  const tabs = getTabsForContext(context)
  const activeTabPath = tabs.find((t) => t.path === location.pathname)?.path ?? null

  // Step-0: how long after the tap does React reach this render? A large delta
  // here = main-thread contention queuing the navigation (no-op unless armed).
  tabPerfMark(`PersistentTabs render · active=${activeTabPath ?? 'none'}`)

  // Remember each tab the moment it first becomes active so it stays mounted on
  // later navigations (instant re-switch + preserved state). Render-phase set
  // state is React's documented way to derive state from the current render; the
  // guard makes it idempotent (runs once per new path, no render loop).
  if (activeTabPath && !mountedPaths.has(activeTabPath)) {
    setMountedPaths(new Set(mountedPaths).add(activeTabPath))
  }

  return (
    <>
      {tabs.map((tab) => {
        const isActive = tab.path === activeTabPath
        // Active tab always renders (instant, responsive tap → Suspense
        // fallback paints immediately). A tab that has been visited stays
        // mounted (mountedPaths) so re-switches are instant and React state
        // survives. Never-visited tabs are not mounted — no boot-time storm.
        const shouldMount = isActive || mountedPaths.has(tab.path)
        return (
          <div
            key={tab.path}
            ref={(el) => {
              tabWrapperRefs.current.set(tab.path, el)
            }}
            style={{ display: isActive ? 'contents' : 'none' }}
          >
            {shouldMount && <TabPane tab={tab} />}
          </div>
        )
      })}
    </>
  )
}
