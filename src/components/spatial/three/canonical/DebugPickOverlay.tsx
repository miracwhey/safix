/**
 * Spatial · Canonical · Three · DebugPickOverlay (V1.6.1 R14)
 *
 * Visual diagnostic overlay for the pick pipeline. Activated by
 * `?picking=debug`. Renders:
 *   - DOM crosshair (red) at the last tap's clientX/clientY
 *   - DOM probe markers (yellow dots) at each probe sample offset
 *   - DOM legend showing winner + per-sample table (nodeId, distance)
 *
 * Stays OUT of the Three.js scene tree — pure DOM overlay above the canvas.
 * Mount alongside the canonical Canvas; positions itself absolutely.
 */

import { useEffect, useState, type ReactElement } from 'react'

import { isPickDebugEnabled, subscribeDebugPickFrame, type DebugPickFrame } from './pickDebug'
import { PROBE_OFFSETS_PX } from './surfaceTap'

export function DebugPickOverlay(): ReactElement | null {
  // Lazy init: `isPickDebugEnabled()` is a pure window/localStorage read and
  // this is a client-only SPA (no SSR hydration), so resolving it once during
  // first render is safe and avoids a setState-in-effect cascade.
  const [enabled] = useState(() => isPickDebugEnabled())
  const [frame, setFrame] = useState<DebugPickFrame | null>(null)
  useEffect(() => {
    if (!enabled) return
    return subscribeDebugPickFrame((f) => setFrame(f))
  }, [enabled])

  if (!enabled) return null

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 9999,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
        color: '#fff',
      }}
    >
      {/* Legend top-left */}
      <div
        style={{
          position: 'absolute',
          top: 60,
          left: 8,
          background: 'rgba(0,0,0,0.7)',
          padding: '6px 8px',
          borderRadius: 6,
          maxWidth: 280,
          backdropFilter: 'blur(6px)',
        }}
      >
        <div style={{ color: '#7af', marginBottom: 4 }}>PICK · DEBUG</div>
        {frame ? (
          <>
            <div>winner: {frame.winner ? `${frame.winner.kind}-${frame.winner.nodeId}` : '∅'}</div>
            <div>samples: {frame.samples.filter((s) => s.kind).length}/{frame.samples.length}</div>
            <div>tap: ({frame.clientX.toFixed(0)},{frame.clientY.toFixed(0)})</div>
          </>
        ) : (
          <div>tap to probe…</div>
        )}
      </div>

      {/* Crosshair + sample markers at last tap */}
      {frame && (
        <>
          {/* Crosshair */}
          <div
            style={{
              position: 'absolute',
              left: frame.clientX - 12,
              top: frame.clientY - 12,
              width: 24,
              height: 24,
              border: '1.5px solid #ff3b30',
              borderRadius: '50%',
            }}
          />
          {/* 9 sample dots */}
          {PROBE_OFFSETS_PX.map(([dx, dy], i) => {
            const s = frame.samples[i]
            const hit = s?.kind != null
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: frame.clientX + dx - 3,
                  top: frame.clientY + dy - 3,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: hit ? '#ffd60a' : 'rgba(255,255,255,0.25)',
                  boxShadow: hit ? '0 0 4px rgba(255,214,10,0.9)' : undefined,
                }}
              />
            )
          })}
        </>
      )}
    </div>
  )
}
