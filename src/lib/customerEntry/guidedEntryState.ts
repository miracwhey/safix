/**
 * Customer Guided-Entry State Machine
 *
 * Canonical source of truth: Supabase `profiles.guided_entry_state` column.
 * localStorage (`fixup.guided-entry.v1`) serves only as a warm cache so the
 * UI renders instantly while the Supabase roundtrip completes.
 *
 * PERSISTENCE MODEL (hardened — no fire-and-forget):
 *   Every transition writes to Supabase **and awaits** the result.
 *   • State only commits (in-memory + localStorage) after Supabase confirms.
 *   • On write failure the previous state is kept and an error is surfaced.
 *   • Rapid consecutive transitions are serialized via a promise chain so
 *     later writes cannot race and overwrite earlier ones.
 *   • The UI observes both the entry state and a transient `saving` / `error`
 *     status so it can disable buttons and show retry affordances.
 *
 * On session refresh (login / reload), the authoritative state is loaded from
 * Supabase via `hydrateFromProfile()`.
 *
 * State is cleared on sign-out via `resetGuidedEntry()`.
 *
 * State transitions:
 *
 *   initial ──▶ invited  ──▶ searching_provider ──▶ provider_selected
 *                              ──▶ project_needed ──▶ project_created ──▶ completed
 *
 *   initial ──▶ self_found ──▶ project_needed ──▶ project_created
 *                              ──▶ matching_ready ──▶ request_ready ──▶ completed
 */

import { saveGuidedEntryState } from '../profile'
import type { GuidedEntryStep, GuidedEntryPath, GuidedEntryState, GuidedEntryStatus } from './guidedEntryTypes'

// Re-export types so existing consumers are not broken.
export type { GuidedEntryStep, GuidedEntryPath, GuidedEntryState, GuidedEntryStatus } from './guidedEntryTypes'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'fixup.guided-entry.v1'

const INITIAL_STATE: GuidedEntryState = {
  step: 'initial',
  path: null,
  selectedProviderId: null,
  projectId: null,
}

// ---------------------------------------------------------------------------
// Validation helpers (hardening — reject corrupted / tampered values)
// ---------------------------------------------------------------------------

const VALID_STEPS: ReadonlySet<string> = new Set<string>([
  'initial',
  'invited',
  'self_found',
  'searching_provider',
  'provider_selected',
  'project_needed',
  'project_created',
  'matching_ready',
  'request_ready',
  'completed',
])

const VALID_PATHS: ReadonlySet<string> = new Set<string>(['invited', 'self_found'])

/** Returns a valid GuidedEntryStep or 'initial' if the value is invalid. */
function validStep(raw: unknown): GuidedEntryStep {
  if (typeof raw === 'string' && VALID_STEPS.has(raw)) return raw as GuidedEntryStep
  return 'initial'
}

/** Returns a valid GuidedEntryPath or null if the value is invalid. */
function validPath(raw: unknown): GuidedEntryPath | null {
  if (typeof raw === 'string' && VALID_PATHS.has(raw)) return raw as GuidedEntryPath
  return null
}

/**
 * Validates and sanitizes a raw GuidedEntryState object.
 * Returns a clean state with only valid values; invalid fields fall back
 * to their defaults. If the step is past-initial but the path is
 * inconsistent (e.g. step requires a path but path is null), the entire
 * state resets to initial to prevent incoherent UI.
 */
function sanitizeState(raw: Partial<GuidedEntryState> | null | undefined): GuidedEntryState {
  if (!raw || typeof raw !== 'object') return { ...INITIAL_STATE }

  const step = validStep(raw.step)
  const path = validPath(raw.path)

  // If the step implies a path has been chosen but path is missing/invalid,
  // the state is incoherent — reset to initial.
  const NEEDS_PATH: ReadonlySet<GuidedEntryStep> = new Set([
    'invited',
    'self_found',
    'searching_provider',
    'provider_selected',
    'project_needed',
    'project_created',
    'matching_ready',
    'request_ready',
  ])
  if (NEEDS_PATH.has(step) && path == null) {
    return { ...INITIAL_STATE }
  }

  return {
    step,
    path,
    selectedProviderId: typeof raw.selectedProviderId === 'string' ? raw.selectedProviderId : null,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isWebStorage(storage: unknown): storage is Storage {
  return typeof storage === 'object'
    && storage !== null
    && typeof (storage as Record<string, unknown>).getItem === 'function'
    && typeof (storage as Record<string, unknown>).setItem === 'function'
    && typeof (storage as Record<string, unknown>).removeItem === 'function'
}

function getStorage(): Storage | null {
  if (typeof localStorage === 'undefined' || !isWebStorage(localStorage)) return null
  return localStorage
}

// ---------------------------------------------------------------------------
// Subscriptions (same reactive pattern as session.ts)
// ---------------------------------------------------------------------------

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  listeners.forEach((fn) => fn())
}

export function subscribeGuidedEntry(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

let _state: GuidedEntryState = loadCache()
let _status: GuidedEntryStatus = { saving: false, error: null }

export function getGuidedEntryState(): GuidedEntryState {
  return _state
}

export function getGuidedEntryStatus(): GuidedEntryStatus {
  return _status
}

// ---------------------------------------------------------------------------
// localStorage cache (secondary — warm-start only)
// ---------------------------------------------------------------------------

function loadCache(): GuidedEntryState {
  const storage = getStorage()
  if (!storage) return { ...INITIAL_STATE }

  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return { ...INITIAL_STATE }

  try {
    const parsed = JSON.parse(raw) as Partial<GuidedEntryState>
    return sanitizeState(parsed)
  } catch {
    return { ...INITIAL_STATE }
  }
}

function persistCache(next: GuidedEntryState) {
  const storage = getStorage()
  if (!storage) return

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore quota / private-mode failures.
  }
}

// ---------------------------------------------------------------------------
// Serialized, acknowledged Supabase write
// ---------------------------------------------------------------------------

/**
 * Promise chain that serializes all guided-entry writes so that rapid
 * consecutive transitions cannot race and overwrite each other.
 */
let _writeChain: Promise<void> = Promise.resolve()

/**
 * Persist `next` to Supabase with acknowledgement.
 *
 * • Sets `saving = true` before the write.
 * • On success: commits `next` to in-memory state + localStorage cache,
 *   clears error, returns `true`.
 * • On failure: keeps previous in-memory state, sets error, returns `false`.
 * • Writes are serialized: each call waits for the previous to complete.
 */
async function transitionTo(next: GuidedEntryState): Promise<boolean> {
  let result = false

  // Signal saving immediately so the UI can react synchronously
  _status = { saving: true, error: null }
  notify()

  const doWrite = async () => {
    const prev = _state

    try {
      await saveGuidedEntryState(next)

      // Write confirmed — commit canonical state
      _state = next
      persistCache(next)
      _status = { saving: false, error: null }
      result = true
    } catch (e: unknown) {
      // Write failed — roll back to last confirmed state
      _state = prev
      persistCache(prev)
      _status = {
        saving: false,
        error: e instanceof Error ? e.message : 'Speichern fehlgeschlagen',
      }
      result = false
    }

    notify()
  }

  // Chain onto previous write — runs `doWrite` regardless of whether the
  // previous write succeeded or failed (so retries work).
  _writeChain = _writeChain.then(doWrite, doWrite)
  await _writeChain

  return result
}

// ---------------------------------------------------------------------------
// Hydration from Supabase (called on session refresh)
// ---------------------------------------------------------------------------

/**
 * Called by session.ts after loading the profile from Supabase.
 * Overwrites the in-memory + localStorage cache with the canonical server state.
 * If the server state is null (no guided entry yet), resets to initial.
 *
 * The server state is validated/sanitized to protect against corrupted DB
 * values or schema drift.
 */
export function hydrateFromProfile(serverState: GuidedEntryState | null): void {
  const next = sanitizeState(serverState)
  _state = next
  persistCache(next)
  _status = { saving: false, error: null }
  notify()
}

// ---------------------------------------------------------------------------
// Error management
// ---------------------------------------------------------------------------

/** Dismiss the current error without triggering a new write. */
export function clearGuidedEntryError(): void {
  if (_status.error !== null) {
    _status = { ..._status, error: null }
    notify()
  }
}

// ---------------------------------------------------------------------------
// Transitions (all async — return true on success, false on failure)
// ---------------------------------------------------------------------------

/** Customer chose "Ja, von einem Handwerker" (Path A). */
export function chooseInvitedPath(): Promise<boolean> {
  return transitionTo({
    ...INITIAL_STATE,
    step: 'invited',
    path: 'invited',
  })
}

/** Customer chose "Nein, selbst gefunden" (Path B). */
export function chooseSelfFoundPath(): Promise<boolean> {
  return transitionTo({
    ...INITIAL_STATE,
    step: 'self_found',
    path: 'self_found',
  })
}

/** Path A: Customer starts searching for the business. */
export function startProviderSearch(): Promise<boolean> {
  if (_state.path !== 'invited') return Promise.resolve(false)
  return transitionTo({ ..._state, step: 'searching_provider' })
}

/** Path A: Customer selected a specific business/provider. */
export function selectProvider(providerId: string): Promise<boolean> {
  if (_state.path !== 'invited') return Promise.resolve(false)
  return transitionTo({
    ..._state,
    step: 'provider_selected',
    selectedProviderId: providerId,
  })
}

/** Either path: Customer needs to create a project. */
export function markProjectNeeded(): Promise<boolean> {
  return transitionTo({ ..._state, step: 'project_needed' })
}

/** Either path: A project has been created / linked. */
export function markProjectCreated(projectId: string): Promise<boolean> {
  return transitionTo({ ..._state, step: 'project_created', projectId })
}

/** Path B: Matching providers are ready for display. */
export function markMatchingReady(): Promise<boolean> {
  if (_state.path !== 'self_found') return Promise.resolve(false)
  return transitionTo({ ..._state, step: 'matching_ready' })
}

/** Either path: Request is ready to be sent. */
export function markRequestReady(): Promise<boolean> {
  return transitionTo({ ..._state, step: 'request_ready' })
}

/** Either path: Guided entry completed. */
export function completeGuidedEntry(): Promise<boolean> {
  return transitionTo({ ..._state, step: 'completed' })
}

/** Reset guided entry state (called on sign-out). */
export function resetGuidedEntry(): void {
  _state = { ...INITIAL_STATE }
  _status = { saving: false, error: null }
  const storage = getStorage()
  if (storage) storage.removeItem(STORAGE_KEY)
  // Note: Supabase row is cleared via session sign-out or stays as-is
  // (the user is no longer authenticated so no write is needed).
  notify()
}