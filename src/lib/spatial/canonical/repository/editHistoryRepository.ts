/**
 * Spatial · Canonical · Repository · Edit-History Repository (Phase 2 · Block 2.13)
 *
 * The persistence seam for the append-only `spatial_edit_history` audit trail.
 * Mirrors the `catalog-repository.ts` pattern: an InMemory implementation (a
 * plain in-process append-only list) and a Supabase implementation (the
 * `spatial_edit_history_append` SECURITY DEFINER RPC + an RLS-gated SELECT),
 * switched by `VITE_DATA_SOURCE`.
 *
 * ── Why a SEPARATE repository (not the SpatialSceneRepository) ──────────────
 * `SpatialSceneRepository` already exposes `appendEditHistory` / `listEditHistory`,
 * but it predates the Phase-2 command-pattern: its `AppendEditHistoryInput`
 * has no `semantic_op`, no `command`-mapping, and is keyed to the 7-arg RPC.
 * Block 2.13 needs the 8-arg RPC (with `p_semantic_op`) and a typed
 * `EditCommand → spatial_edit_history-row` mapper. This module owns exactly
 * that — the command→row translation + the 8-arg write-path — and stays a thin
 * focused contract rather than bloating the scene repository.
 *
 * ── Command → Row mapping (binding) ─────────────────────────────────────────
 * One {@link EditCommand} can touch SEVERAL `(base_node_id, variant_id)`
 * overrides (e.g. `set_room_height` resizes every wall). Each touched node
 * therefore yields ONE `spatial_edit_history` row. {@link mapCommandToRows}
 * walks the command's `after` snapshot — the override rows the command wrote —
 * and emits one {@link EditHistoryAppendRow} per entry:
 *
 *   - `override_fields` — the per-node override delta (from the `after` row).
 *   - `command` — the COARSE override primitive (`set` / `delete` / `restore`).
 *     `delete_node` ⇒ `delete`; the persistent reverter ⇒ `restore` (forced by
 *     the caller via {@link mapRestoreCommandToRows}); a row whose delta is the
 *     `{ __deleted: true }` marker ⇒ `delete`; everything else ⇒ `set`.
 *   - `semantic_op` — the FINE {@link EditOperationKind} discriminator.
 *   - `parametric_sha256_before/after` — blob-level content addresses, passed
 *     through from the persistence caller (Block 2.13 workflow helper).
 *
 * Phase 1+2 run on InMemory — the canonical migrations are not applied to prod
 * (Phase-5 step). The Supabase implementation is written against the RPC
 * contract from `20260520120030_spatial_edit_history_semantic_op.sql`; it is
 * NOT exercised against prod in Phase 2.
 *
 * This module imports the Supabase client and is therefore NOT re-exported
 * from `canonical/index.ts` — same reason the scene + catalog repositories
 * live outside the L1 barrel.
 */

import { supabase } from '../../../supabase'
import { DELETION_MARKER_KEY } from '../overrides/layer-merge.ts'
import type { EditCommand, EditHistoryCommand, EditOperationKind } from '../types/commands.ts'
import type { NodeOverride } from '../types/variants.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Row-level audit entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One persisted `spatial_edit_history` row, as read back from the store.
 *
 * Distinct from the `EditHistoryEntry` type in `types/commands.ts`: that type
 * models a LOGICAL edit (Master-Spec §10.2 — one `operation`, before/after
 * snapshot arrays). The `spatial_edit_history` TABLE is keyed PER touched
 * `(base_node_id, variant_id)` override — one logical command can be several
 * rows. This type is the row shape; the repository works at row granularity
 * because the SECURITY DEFINER RPC writes one row per invocation.
 */
export interface EditHistoryRowEntry {
  /** Row uuid. */
  id: string
  /**
   * Monotonic insertion sequence — strictly increasing in append order, used
   * as the deterministic tiebreak when two rows share a `created_at` (the
   * InMemory append timestamps at millisecond resolution, so a fast multi-edit
   * burst produces same-`created_at` rows). The InMemory repository assigns a
   * real process-monotonic value; the Supabase table has no monotonic column,
   * so its rows carry `0` and ordering falls back to `created_at` alone.
   */
  seq: number
  /** The canonical scene the row belongs to. */
  scene_id: string
  /** The variant layer the override targeted. */
  variant_id: string
  /** The base-scene node the override targeted. */
  base_node_id: string
  /** auth.users.id of the actor — server-forced to `auth.uid()` on Supabase. */
  user_id: string
  /** Coarse override primitive (`set` / `delete` / `restore`). */
  command: EditHistoryCommand
  /** Fine semantic discriminator — the {@link EditOperationKind}. */
  semantic_op: EditOperationKind
  /** The per-node override delta as applied. */
  override_fields: Record<string, unknown>
  /** SHA-256 of the parametric blob before the command. */
  parametric_sha256_before: string | null
  /** SHA-256 of the parametric blob after the command. */
  parametric_sha256_after: string | null
  /** ISO-8601 wall-clock creation time. */
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Append payload + Command → Row mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `spatial_edit_history` row to append. Snake-cased to mirror the table /
 * RPC contract — the Supabase implementation passes these straight to the RPC
 * args; the InMemory implementation stores them verbatim.
 */
export interface EditHistoryAppendRow {
  /** The variant layer the override targeted. */
  variant_id: string
  /** The base-scene node the override targeted. */
  base_node_id: string
  /** The per-node override delta as applied. */
  override_fields: Record<string, unknown>
  /** Coarse override primitive (`spatial_edit_history.command`). */
  command: EditHistoryCommand
  /** Fine semantic discriminator (`spatial_edit_history.semantic_op`). */
  semantic_op: EditOperationKind
}

/** The full input to {@link SpatialEditHistoryRepository.append}. */
export interface AppendEditHistoryRowsInput {
  /** The canonical scene the edit belongs to. */
  scene_id: string
  /** The rows to append (one per touched override). */
  rows: EditHistoryAppendRow[]
  /** SHA-256 of the parametric blob BEFORE the command — passed through. */
  parametric_sha256_before?: string | null
  /** SHA-256 of the parametric blob AFTER the command — passed through. */
  parametric_sha256_after?: string | null
}

/**
 * Decide the coarse {@link EditHistoryCommand} primitive for a single override
 * row. A row whose delta IS the deletion marker is a `delete`; everything else
 * is a `set`. The `restore` primitive is never produced here — it is forced by
 * the reverter path ({@link mapRestoreCommandToRows}), because a restore can
 * write either a `set`-shaped or a `delete`-shaped delta yet must always be
 * recorded as `restore` for the audit trail.
 */
function coarseCommandOf(override: NodeOverride): EditHistoryCommand {
  return override.override_fields[DELETION_MARKER_KEY] === true ? 'delete' : 'set'
}

/**
 * Map an executed {@link EditCommand} to its `spatial_edit_history` rows — one
 * per `(base_node_id, variant_id)` override the command WROTE.
 *
 * The `command` (coarse primitive) is derived per-row: a `delete_node` command
 * writes the `{ __deleted: true }` marker, so its row is `delete`; an
 * `add_door` undo would too. Any other override delta is `set`. The
 * `semantic_op` is the command's fine operation kind, identical on every row.
 *
 * ── Node-adding commands ────────────────────────────────────────────────────
 * `add_door` / `add_pin` introduce a NEW base-scene node, NOT a delta — their
 * `after` override snapshot is intentionally empty (the override engine cannot
 * synthesise a node). Walking `after` alone would emit ZERO rows for them, an
 * audit blind spot: adding a door or pin would write nothing to
 * `spatial_edit_history`. So these two operations are mapped from the command's
 * OPERATION payload instead — one row keyed on the created node's id, recording
 * the add as a `set` coarse primitive with the `add_door` / `add_pin`
 * `semantic_op`.
 */
export function mapCommandToRows(command: EditCommand): EditHistoryAppendRow[] {
  const semanticOp = command.operation.kind

  // Node-adding commands carry no override rows — synthesise one audit row
  // from the operation payload so the add is never invisible to the trail.
  const addRow = nodeAddRow(command)
  if (addRow) return [addRow]

  return command.after.map((override) => ({
    variant_id: override.variant_id,
    base_node_id: override.base_node_id,
    override_fields: { ...override.override_fields },
    command: coarseCommandOf(override),
    semantic_op: semanticOp,
  }))
}

/**
 * For a node-adding command (`add_door` / `add_pin`) build the single audit
 * row capturing the created node — its id (as `base_node_id`), the variant the
 * command authored on, and a minimal `override_fields` delta describing the
 * created node. Returns `null` for every other operation kind, leaving
 * {@link mapCommandToRows} to walk the `after` snapshot as usual.
 */
function nodeAddRow(command: EditCommand): EditHistoryAppendRow | null {
  const op = command.operation
  if (op.kind === 'add_door') {
    return {
      variant_id: command.variant_id,
      base_node_id: op.door.id,
      override_fields: { added_node: 'door', host_wall_id: op.wall_id },
      command: 'set',
      semantic_op: 'add_door',
    }
  }
  if (op.kind === 'add_pin') {
    return {
      variant_id: command.variant_id,
      base_node_id: op.pin_id,
      override_fields: {
        added_node: 'pin',
        anchor_surface_id: op.anchor.anchor_surface_id,
      },
      command: 'set',
      semantic_op: 'add_pin',
    }
  }
  return null
}

/**
 * Map a REVERTER command to its `spatial_edit_history` rows. Distinct from
 * {@link mapCommandToRows}: the reverter re-applies a prior state as a NEW
 * override write, and the audit trail must mark every such row as `restore`
 * regardless of whether the restored delta looks like a `set` or a `delete`.
 *
 * `semanticOpOverride` records WHICH operation was reverted. The reverter's
 * COMMAND carries a constraint-safe gate operation (often `delete_node` — see
 * `revertEditHistoryEntry`), which is not always the same as the operation the
 * user actually reverted. Passing the reverted row's own `semantic_op` here
 * keeps the audit `semantic_op` faithful so the timeline shows the correct
 * "… (wiederhergestellt)" label. When omitted, the command's operation kind is
 * used (correct for the reconstructable `set_material` / `delete_node` /
 * `move_node` restores).
 */
export function mapRestoreCommandToRows(
  command: EditCommand,
  semanticOpOverride?: EditOperationKind,
): EditHistoryAppendRow[] {
  const semanticOp = semanticOpOverride ?? command.operation.kind
  return command.after.map((override) => ({
    variant_id: override.variant_id,
    base_node_id: override.base_node_id,
    override_fields: { ...override.override_fields },
    command: 'restore' as const,
    semantic_op: semanticOp,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append-only persistence for `spatial_edit_history`.
 *
 * `append` is the ONLY write path — there is no update / delete (the table is
 * append-only, REVOKE'd from anon/authenticated; the Supabase write goes
 * exclusively through the SECURITY DEFINER RPC). `list` reads a scene's full
 * history newest-first.
 */
export interface SpatialEditHistoryRepository {
  /**
   * Append one or more audit rows for a single command. Returns the persisted
   * {@link EditHistoryRowEntry} rows in the order they were written. A best-effort
   * audit append — callers treat a rejection as non-fatal to the local edit
   * (see the Block-2.13 workflow helper).
   */
  append(input: AppendEditHistoryRowsInput): Promise<EditHistoryRowEntry[]>

  /**
   * List a scene's edit history, newest first (`ORDER BY created_at DESC`).
   * `limit` caps the result (default 200).
   */
  list(sceneId: string, limit?: number): Promise<EditHistoryRowEntry[]>
}

const DEFAULT_LIST_LIMIT = 200

// ─────────────────────────────────────────────────────────────────────────────
// InMemory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-process append-only history list. This is the implementation Phase 2
 * actually runs on (the canonical migrations are not on prod). Returns
 * defensive copies so a consumer cannot mutate the stored audit trail.
 *
 * `actorIdProvider` mirrors Supabase's server-forced `auth.uid()`: when absent,
 * appended rows have `user_id = ''` (the InMemory unauthenticated default —
 * Supabase forces a real uid). Tests inject a stable id via the constructor.
 */
export class InMemorySpatialEditHistoryRepository implements SpatialEditHistoryRepository {
  /** Append-only log, each row tagged with a monotonic insertion sequence. */
  private entries: Array<{ seq: number; entry: EditHistoryRowEntry }> = []
  private seq = 0
  private readonly actorIdProvider: () => string

  constructor(options: { actorIdProvider?: () => string } = {}) {
    this.actorIdProvider = options.actorIdProvider ?? (() => '')
  }

  async append(input: AppendEditHistoryRowsInput): Promise<EditHistoryRowEntry[]> {
    const createdAt = new Date().toISOString()
    const actorId = this.actorIdProvider()
    const written: EditHistoryRowEntry[] = input.rows.map((row) => {
      this.seq += 1
      return {
        id: newId(),
        // Process-monotonic — the deterministic tiebreak the persistent
        // reverter uses to order same-`created_at` rows (see EditHistoryRowEntry.seq).
        seq: this.seq,
        scene_id: input.scene_id,
        variant_id: row.variant_id,
        base_node_id: row.base_node_id,
        user_id: actorId,
        command: row.command,
        semantic_op: row.semantic_op,
        override_fields: { ...row.override_fields },
        parametric_sha256_before: input.parametric_sha256_before ?? null,
        parametric_sha256_after: input.parametric_sha256_after ?? null,
        created_at: createdAt,
      }
    })
    for (const entry of written) {
      this.entries.push({ seq: entry.seq, entry: cloneEntry(entry) })
    }
    return written.map(cloneEntry)
  }

  async list(sceneId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<EditHistoryRowEntry[]> {
    // Newest first: ORDER BY created_at DESC. Same-millisecond appends fall
    // back to the monotonic insertion sequence (DESC) — deterministic, and a
    // multi-row command lists its last-touched node first.
    return this.entries
      .filter((e) => e.entry.scene_id === sceneId)
      .slice()
      .sort((a, b) =>
        a.entry.created_at < b.entry.created_at
          ? 1
          : a.entry.created_at > b.entry.created_at
            ? -1
            : b.seq - a.seq,
      )
      .slice(0, limit)
      .map((e) => cloneEntry(e.entry))
  }

  /** Test helper — wipe the in-memory log. */
  reset(): void {
    this.entries = []
    this.seq = 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────────────────────────────────────

/** Raw `spatial_edit_history` row shape (post-20260520120030 migration). */
interface EditHistoryRow {
  id: string
  scene_id: string
  actor_id: string | null
  variant_id: string
  base_node_id: string
  override_fields: Record<string, unknown>
  command: EditHistoryCommand
  semantic_op: EditOperationKind | null
  parametric_sha256_before: string | null
  parametric_sha256_after: string | null
  created_at: string
}

function rowToEntry(row: EditHistoryRow): EditHistoryRowEntry {
  return {
    id: row.id,
    // The `spatial_edit_history` table has no monotonic column — ordering of
    // same-`created_at` rows falls back to `created_at` alone for Supabase.
    seq: 0,
    scene_id: row.scene_id,
    variant_id: row.variant_id,
    base_node_id: row.base_node_id,
    // Supabase forces actor_id = auth.uid(); a null only occurs on a legacy /
    // system row — surface it as '' so the type stays a plain string.
    user_id: row.actor_id ?? '',
    command: row.command,
    // `semantic_op` is nullable in the schema (legacy rows). Command-pattern
    // writes always supply it; default to the safest discriminator if absent.
    semantic_op: row.semantic_op ?? 'set_material',
    override_fields: row.override_fields,
    parametric_sha256_before: row.parametric_sha256_before,
    parametric_sha256_after: row.parametric_sha256_after,
    created_at: row.created_at,
  }
}

/**
 * Talks to the Day-7 `spatial_edit_history_append` SECURITY DEFINER RPC (8-arg
 * variant, with `p_semantic_op`) and the RLS-gated `spatial_edit_history`
 * SELECT.
 *
 * `append` issues one RPC call PER row — the RPC inserts a single row per
 * invocation. A multi-node command therefore makes N RPC round-trips; this is
 * accepted because (a) a single command rarely touches more than a handful of
 * nodes and (b) the SECURITY DEFINER RPC is the ONLY legal write path (direct
 * INSERT is REVOKE'd from anon/authenticated). The first failing RPC aborts
 * the append and rejects — the workflow caller treats that as a non-fatal
 * audit-append failure.
 *
 * A transport / RPC error is THROWN, not swallowed: the workflow-layer
 * persistence helper (`workflow/persistEditCommand.ts`) is the single place
 * that decides an audit-append failure must not roll back the local edit.
 */
export class SupabaseSpatialEditHistoryRepository implements SpatialEditHistoryRepository {
  async append(input: AppendEditHistoryRowsInput): Promise<EditHistoryRowEntry[]> {
    const written: EditHistoryRowEntry[] = []
    for (const row of input.rows) {
      const { data, error } = await supabase.rpc('spatial_edit_history_append', {
        p_scene_id: input.scene_id,
        p_variant_id: row.variant_id,
        p_base_node_id: row.base_node_id,
        p_override_fields: row.override_fields,
        p_command: row.command,
        p_sha_before: input.parametric_sha256_before ?? null,
        p_sha_after: input.parametric_sha256_after ?? null,
        p_semantic_op: row.semantic_op,
      })
      if (error) {
        throw new Error(`spatial_edit_history_append failed: ${error.message}`)
      }
      // The RPC returns the inserted row id; re-fetch for a shaped result.
      const { data: fetched, error: fetchErr } = await supabase
        .from('spatial_edit_history')
        .select(
          'id, scene_id, actor_id, variant_id, base_node_id, override_fields, ' +
            'command, semantic_op, parametric_sha256_before, parametric_sha256_after, created_at',
        )
        .eq('id', data as string)
        .single<EditHistoryRow>()
      if (fetchErr) {
        throw new Error(`spatial_edit_history fetch-after-append failed: ${fetchErr.message}`)
      }
      written.push(rowToEntry(fetched as EditHistoryRow))
    }
    return written
  }

  async list(sceneId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<EditHistoryRowEntry[]> {
    const { data, error } = await supabase
      .from('spatial_edit_history')
      .select(
        'id, scene_id, actor_id, variant_id, base_node_id, override_fields, ' +
          'command, semantic_op, parametric_sha256_before, parametric_sha256_after, created_at',
      )
      .eq('scene_id', sceneId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      throw new Error(`spatial_edit_history list failed: ${error.message}`)
    }
    return ((data as unknown as EditHistoryRow[] | null) ?? []).map(rowToEntry)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

export type SpatialEditHistoryDataSource = 'in-memory' | 'supabase'

let _instance: SpatialEditHistoryRepository | null = null
let _kind: SpatialEditHistoryDataSource | null = null

function resolveDataSource(): SpatialEditHistoryDataSource {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env
  return env?.VITE_DATA_SOURCE === 'supabase' ? 'supabase' : 'in-memory'
}

/**
 * Singleton edit-history repository for the active data source. The InMemory
 * singleton retains its audit log for the process lifetime — call
 * {@link resetSpatialEditHistoryRepository} in test `beforeEach` blocks.
 */
export function getSpatialEditHistoryRepository(
  kindOverride?: SpatialEditHistoryDataSource,
): SpatialEditHistoryRepository {
  const kind = kindOverride ?? resolveDataSource()
  if (_instance && _kind === kind) return _instance
  _instance = kind === 'supabase'
    ? new SupabaseSpatialEditHistoryRepository()
    : new InMemorySpatialEditHistoryRepository()
  _kind = kind
  return _instance
}

/** Reset the singleton — test helper. */
export function resetSpatialEditHistoryRepository(): void {
  _instance = null
  _kind = null
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `eh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function cloneEntry(entry: EditHistoryRowEntry): EditHistoryRowEntry {
  return { ...entry, override_fields: { ...entry.override_fields } }
}
