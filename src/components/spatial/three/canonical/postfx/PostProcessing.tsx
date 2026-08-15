/**
 * Spatial · Canonical · PostFX · Stack (Day 15)
 *
 * The post-processing chain applied on top of <CanonicalSceneRoot>:
 *   - N8AO (half-res on mobile · OD per Plan §6 Day 15)
 *   - Bloom (selective · threshold 1)
 *   - SMAA edge anti-aliasing (cheaper than MSAA on integrated GPUs)
 *
 * Soft shadows are configured on the renderer via PCFSoftShadowMap (set
 * inside CanonicalSceneRoot's Canvas `gl.shadows` and per-light
 * `shadow.mapSize`).
 *
 * The n8ao package is pinned to 1.10.1 due to Issue #291 (MR2): newer
 * versions ship a regressed `screenSpaceRadius` default that washes out
 * thin geometry like wall trim. Hold the pin until the upstream patch
 * ships.
 *
 * The component is intentionally not exported from the canonical/three
 * barrel — opt-in via `<PostProcessing />` inside the dev POC screen.
 * Production routes may decide per-scene whether the post-FX cost is
 * worth it (Phase 1 will introduce a quality preset switch).
 */

import { useEffect, useState, type ReactElement } from 'react'
import { getGPUTier } from 'detect-gpu'
import {
  Bloom,
  EffectComposer,
  N8AO,
  SMAA,
} from '@react-three/postprocessing'

export interface PostProcessingProps {
  /** Force mobile-quality even on desktop GPUs (defaults to GPU detection). */
  forceMobile?: boolean
}

export function PostProcessing({ forceMobile = false }: PostProcessingProps): ReactElement | null {
  const [mobile, setMobile] = useState<boolean>(forceMobile)

  useEffect(() => {
    if (forceMobile) return
    let cancelled = false
    void getGPUTier()
      .then((t) => {
        if (cancelled) return
        setMobile((t?.tier ?? 0) < 2)
      })
      .catch(() => {
        if (!cancelled) setMobile(true) // safer: assume mobile on failure
      })
    return () => {
      cancelled = true
    }
  }, [forceMobile])

  return (
    <EffectComposer multisampling={0}>
      <N8AO
        aoRadius={mobile ? 0.5 : 1.0}
        intensity={mobile ? 1.2 : 1.5}
        halfRes={mobile}
      />
      <Bloom
        intensity={0.6}
        luminanceThreshold={1.0}
        luminanceSmoothing={0.2}
        mipmapBlur
      />
      <SMAA />
    </EffectComposer>
  )
}

export default PostProcessing
