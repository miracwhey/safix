// @vitest-environment jsdom
/**
 * Tests for the Block R6 `EnvironmentErrorBoundary` — the boundary that
 * catches a failed HDRI `<Environment>` load inside `CanonicalSceneRoot` and
 * silently falls back to the analytic three-point lighting rig so a missing /
 * corrupt EXR never blanks the whole `<Canvas>`.
 *
 * The boundary is renderer-agnostic (a plain React class component), so it is
 * exercised here with plain DOM children — no Canvas needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import { EnvironmentErrorBoundary } from '../../../src/components/spatial/three/canonical/adapters/EnvironmentErrorBoundary.tsx'

/** A child that throws on render — simulates a failed HDRI EXR load. */
function Throws({ message }: { message: string }): never {
  throw new Error(message)
}

afterEach(cleanup)

describe('EnvironmentErrorBoundary', () => {
  it('renders its children when the HDRI loads cleanly', () => {
    render(
      <EnvironmentErrorBoundary hdriUrl="/spatial-assets/hdri/bathroom_2k.exr" fallback={<div>fallback</div>}>
        <div>environment</div>
      </EnvironmentErrorBoundary>,
    )
    expect(screen.getByText('environment')).toBeTruthy()
    expect(screen.queryByText('fallback')).toBeNull()
  })

  it('renders the fallback when the HDRI load throws (missing / corrupt EXR)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <EnvironmentErrorBoundary hdriUrl="/spatial-assets/hdri/missing_2k.exr" fallback={<div>fallback</div>}>
        <Throws message="404 EXR not found" />
      </EnvironmentErrorBoundary>,
    )
    expect(screen.getByText('fallback')).toBeTruthy()
    expect(screen.queryByText('environment')).toBeNull()
    // The degradation is logged once at warn level — not an error: no red
    // console noise reaches the user.
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('logs the failure with the HDRI url and the error message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(
      <EnvironmentErrorBoundary
        hdriUrl="/spatial-assets/hdri/comfy_cafe_2k.exr"
        fallback={<div>fb</div>}
      >
        <Throws message="EXR decode failed" />
      </EnvironmentErrorBoundary>,
    )
    const logged = warn.mock.calls[0]?.join(' ') ?? ''
    expect(logged).toContain('comfy_cafe_2k.exr')
    expect(logged).toContain('EXR decode failed')
    warn.mockRestore()
  })

  it('accepts a null fallback (analytic lights already mounted above)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The production call site passes `fallback={null}` because the
    // three-point rig renders unconditionally outside this boundary.
    const { container } = render(
      <EnvironmentErrorBoundary hdriUrl="/spatial-assets/hdri/en_suite_2k.exr" fallback={null}>
        <Throws message="suspense loader rejected" />
      </EnvironmentErrorBoundary>,
    )
    // No crash, nothing rendered in place of the environment.
    expect(container.textContent).toBe('')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clears the error when the HDRI url changes so a new preset is retried', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    function Maybe({ fail }: { fail: boolean }): ReturnType<typeof Throws> | JSX.Element {
      if (fail) return <Throws message="first EXR broken" />
      return <div>environment</div>
    }
    const { rerender } = render(
      <EnvironmentErrorBoundary hdriUrl="/spatial-assets/hdri/broken_2k.exr" fallback={<div>fallback</div>}>
        <Maybe fail />
      </EnvironmentErrorBoundary>,
    )
    expect(screen.getByText('fallback')).toBeTruthy()

    // Switch to a different (valid) preset url — the boundary resets and
    // re-attempts the children instead of staying on the fallback.
    rerender(
      <EnvironmentErrorBoundary hdriUrl="/spatial-assets/hdri/studio_small_09_2k.exr" fallback={<div>fallback</div>}>
        <Maybe fail={false} />
      </EnvironmentErrorBoundary>,
    )
    expect(screen.getByText('environment')).toBeTruthy()
    expect(screen.queryByText('fallback')).toBeNull()
    warn.mockRestore()
  })
})
