// @vitest-environment jsdom
/**
 * Tests for the Block R4 `ObjectErrorBoundary` — the boundary that catches a
 * failed GLB render inside `ObjectAdapter` and swaps in the generic-box
 * placeholder so one missing model never blanks the whole scene.
 *
 * The boundary is renderer-agnostic (a plain React class component), so it is
 * exercised here with plain DOM children — no Canvas needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { ObjectErrorBoundary } from '../../../src/components/spatial/three/canonical/adapters/ObjectErrorBoundary.tsx'

/** A child that throws on render — simulates a failed GLB read. */
function Throws({ message }: { message: string }): never {
  throw new Error(message)
}

afterEach(cleanup)

describe('ObjectErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ObjectErrorBoundary objectId="obj-1" fallback={<div>placeholder</div>}>
        <div>real model</div>
      </ObjectErrorBoundary>,
    )
    expect(screen.getByText('real model')).toBeTruthy()
    expect(screen.queryByText('placeholder')).toBeNull()
  })

  it('renders the fallback when a child throws (missing / corrupt GLB)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <ObjectErrorBoundary objectId="obj-2" fallback={<div>placeholder</div>}>
        <Throws message="404 model not found" />
      </ObjectErrorBoundary>,
    )
    expect(screen.getByText('placeholder')).toBeTruthy()
    expect(screen.queryByText('real model')).toBeNull()
    // The degradation is logged once at warn level — it is not a crash.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('logs the failure with the object id and the error message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <ObjectErrorBoundary objectId="furn-floor-lamp-tripod-1" fallback={<div>ph</div>}>
        <Throws message="GLB decoded without a scene" />
      </ObjectErrorBoundary>,
    )
    const logged = warn.mock.calls[0]?.join(' ') ?? ''
    expect(logged).toContain('furn-floor-lamp-tripod-1')
    expect(logged).toContain('GLB decoded without a scene')
    warn.mockRestore()
  })
})
