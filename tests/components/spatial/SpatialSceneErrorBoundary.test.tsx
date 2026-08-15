// @vitest-environment jsdom
/**
 * Spatial · SpatialSceneErrorBoundary contract (PR #951 review · HIGH)
 *
 * Verifies the boundary catches a render error in a child scene root and
 * renders the calm outline-fallback (or a custom `fallback` node) without
 * tearing down the surrounding chrome.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'

import { SpatialSceneErrorBoundary } from '../../../src/components/spatial/SpatialSceneErrorBoundary'

function Exploder(): ReactElement {
  throw new Error('boom · simulated WebGL context loss')
}

describe('SpatialSceneErrorBoundary', () => {
  beforeEach(() => {
    // Boundaries log via componentDidCatch + React's own error logging. Silence
    // both so the test output stays readable; assertions cover the rest.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children when no error is thrown', () => {
    render(
      <SpatialSceneErrorBoundary>
        <div data-testid="scene-child">scene</div>
      </SpatialSceneErrorBoundary>,
    )
    expect(screen.getByTestId('scene-child')).toBeTruthy()
  })

  it('renders the default outline-fallback when a child throws', () => {
    render(
      <SpatialSceneErrorBoundary context="ExampleRoomViewer">
        <Exploder />
      </SpatialSceneErrorBoundary>,
    )
    const fallback = screen.getByTestId('spatial-scene-fallback')
    expect(fallback).toBeTruthy()
    expect(fallback.getAttribute('role')).toBe('alert')
    expect(fallback.textContent).toContain('3D-Ansicht nicht verfügbar')
    expect(fallback.textContent).toContain('Beispiel-Maße findest du unten')
  })

  it('renders a custom fallback when provided', () => {
    render(
      <SpatialSceneErrorBoundary
        fallback={<div data-testid="custom-fallback">custom</div>}
      >
        <Exploder />
      </SpatialSceneErrorBoundary>,
    )
    expect(screen.getByTestId('custom-fallback')).toBeTruthy()
    expect(screen.queryByTestId('spatial-scene-fallback')).toBeNull()
  })

  it('warns to console with the context label', () => {
    const warnSpy = vi.spyOn(console, 'warn')
    render(
      <SpatialSceneErrorBoundary context="ExampleRoomViewer">
        <Exploder />
      </SpatialSceneErrorBoundary>,
    )
    const matched = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('[ExampleRoomViewer]'),
    )
    expect(matched).toBe(true)
  })
})
