/**
 * Spatial · Lane 2.5 · Stream B · useStartEmptyRoomProject
 *
 * Mirror of `useStartPresalesRoomScan` for the Manual-Start CTAs on the
 * Privat-Tab empty-state. Wires the `createEmptyRoomProject` workflow + a
 * busy-state + toast surface; the caller passes a navigation handler so
 * the hook stays UI-agnostic.
 *
 * No LiDAR check — manual rooms are explicitly the path for non-LiDAR
 * devices (and any user who wants to skip the scan).
 */

import { useCallback, useState } from 'react'

import { logError } from '../lib/observability'
import type { PresalesProject } from '../domain/presales/presalesProjectTypes'
import {
  createEmptyRoomProject,
  type CreateEmptyRoomVariant,
} from '../lib/spatial/workflow/createEmptyRoomProject'
import type { RoomScene } from '../lib/spatial/canonical/types/scene-graph'
import { useToast } from './useToast'

export interface StartEmptyRoomOptions {
  variant: CreateEmptyRoomVariant
  /** Optional override of the auto-generated `Aufmaß · …` title. */
  title?: string
  /** Optional draft customer fields (mirrors createProviderPresalesProject). */
  customerNameDraft?: string
  customerEmailDraft?: string
  customerPhoneDraft?: string
  notes?: string
  /** Optional footprint override for the empty_room_2x2 preset. */
  widthM?: number
  depthM?: number
  ceilingHeightM?: number
  /** Called after the scene was created — the caller typically navigates to
   *  the presales detail screen so the user lands in Edit-Mode immediately.
   *  `scene` is the fully-hydrated RoomScene the workflow already built, so the
   *  caller can mount the multi-mode viewer optimistically (navigation-state)
   *  without waiting on a server blob refetch. */
  onSuccess?: (project: PresalesProject, sceneId: string, scene: RoomScene) => void
  onSettled?: () => void
}

export interface UseStartEmptyRoomProjectApi {
  startEmptyRoom: (opts: StartEmptyRoomOptions) => Promise<void>
  busy: boolean
}

export function useStartEmptyRoomProject(): UseStartEmptyRoomProjectApi {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const startEmptyRoom = useCallback(
    async (opts: StartEmptyRoomOptions) => {
      setBusy(true)
      try {
        const result = await createEmptyRoomProject({
          variant: opts.variant,
          title: opts.title,
          customerNameDraft: opts.customerNameDraft,
          customerEmailDraft: opts.customerEmailDraft,
          customerPhoneDraft: opts.customerPhoneDraft,
          notes: opts.notes,
          widthM: opts.widthM,
          depthM: opts.depthM,
          ceilingHeightM: opts.ceilingHeightM,
        })
        if (!result.ok) {
          toast.error(result.message)
          logError('spatial.manualStart.workflow_failed', new Error(result.message), {
            reason: result.reason,
            variant: opts.variant,
          })
          return
        }
        toast.success(
          opts.variant === 'empty_canvas'
            ? 'Leerer Raum angelegt — zeichne jetzt die Wände.'
            : 'Vorlage angelegt — passe die Maße an.',
        )
        opts.onSuccess?.(result.project, result.sceneId, result.scene)
      } finally {
        setBusy(false)
        opts.onSettled?.()
      }
    },
    [toast],
  )

  return { startEmptyRoom, busy }
}
