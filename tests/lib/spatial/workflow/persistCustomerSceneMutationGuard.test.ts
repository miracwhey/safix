/**
 * Cluster D workflow-guard lock — persistCustomerSceneMutation refuses to
 * persist a scene the caller is not allowed to edit (HW-owned shared aufmaß),
 * short-circuiting BEFORE the blob upload so no orphan blob is created. The DB
 * RLS (`spatial_can_edit_scene`) is the authoritative guard; this is the
 * workflow-layer enforcement mandated by CLAUDE.md.
 */
import { describe, expect, it } from 'vitest'

import { persistCustomerSceneMutation } from '../../../../src/lib/spatial/workflow/persistCustomerSceneMutation.ts'
import { makeRoom } from '../canonical/__helpers__/sceneFactory.ts'

describe('persistCustomerSceneMutation — RBAC guard', () => {
  it('returns { ok:false, reason:"forbidden" } when callerCanEdit is false', async () => {
    const result = await persistCustomerSceneMutation({
      sceneId: 'scene-1',
      userId: 'user-1',
      callerCanEdit: false,
      roomScene: makeRoom(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('forbidden')
  })
})
