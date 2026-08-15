/**
 * Project builder completion and provider-selection flow tests.
 *
 * Covers:
 * - Loading state reset and navigation after successful project creation.
 * - Error surfacing and loading reset on creation failure.
 * - Builder inquiry CTA navigation without auto-starting an inquiry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getConversations } from '../../src/lib/messages'
import { submitBuilderProject } from '../../src/screens/submitBuilderProject'
import {
  buildBuilderInquiryNavigation,
  startBuilderInquirySelection,
} from '../../src/screens/customerProjectNavigation'
import { setupCleanRepositories } from '../helpers/setupRepositories'

describe('project builder submission', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('resets submitting state and navigates after successful creation', async () => {
    const setSubmitting = vi.fn()
    const setSubmitError = vi.fn()
    const navigate = vi.fn()
    const createProject = vi.fn().mockResolvedValue('project-123')

    const input = {
      category: 'Elektrik',
      description: 'Sicherungskasten modernisieren',
      location: 'Berlin',
      requestedBudget: '500 – 1.500 €',
      requestedTiming: 'So schnell wie möglich',
    }

    const result = await submitBuilderProject(input, {
      createProject,
      navigate,
      setSubmitting,
      setSubmitError,
    })

    expect(createProject).toHaveBeenCalledWith(input)
    expect(setSubmitError).toHaveBeenCalledTimes(1)
    expect(setSubmitError).toHaveBeenCalledWith(null)
    expect(setSubmitting).toHaveBeenNthCalledWith(1, true)
    expect(setSubmitting).toHaveBeenLastCalledWith(false)
    expect(navigate).toHaveBeenCalledWith('/projects/project-123', { replace: true })
    expect(result).toBe('project-123')
  })

  it('clears loading and surfaces error when creation fails', async () => {
    const setSubmitting = vi.fn()
    const setSubmitError = vi.fn()
    const navigate = vi.fn()
    const createProject = vi.fn().mockRejectedValue(new Error('RLS denied'))

    const input = {
      category: 'Fliesen',
      description: 'Bad erneuern',
      location: 'Hamburg',
      requestedBudget: undefined,
      requestedTiming: undefined,
    }

    const result = await submitBuilderProject(input, {
      createProject,
      navigate,
      setSubmitting,
      setSubmitError,
    })

    expect(createProject).toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(setSubmitError).toHaveBeenCalledWith('RLS denied')
    expect(setSubmitting).toHaveBeenNthCalledWith(1, true)
    expect(setSubmitting).toHaveBeenLastCalledWith(false)
    expect(result).toBeNull()
  })

  it('prevents duplicate submission while a request is in flight', async () => {
    const setSubmitting = vi.fn()
    const setSubmitError = vi.fn()
    const navigate = vi.fn()

    let resolveCreate: (value: string) => void = () => {}
    const createProject = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCreate = resolve
        })
    )

    const input = {
      category: 'Elektrik',
      description: 'Strom prüfen',
      location: 'Berlin',
      requestedBudget: undefined,
      requestedTiming: undefined,
    }

    const firstPromise = submitBuilderProject(input, {
      createProject,
      navigate,
      setSubmitting,
      setSubmitError,
    })
    const secondResult = await submitBuilderProject(input, {
      createProject,
      navigate,
      setSubmitting,
      setSubmitError,
    })

    expect(secondResult).toBeNull()
    expect(createProject).toHaveBeenCalledTimes(1)

    resolveCreate('project-dup-1')
    const firstResult = await firstPromise

    expect(firstResult).toBe('project-dup-1')
    expect(navigate).toHaveBeenCalledWith('/projects/project-dup-1', { replace: true })
    expect(setSubmitting).toHaveBeenCalledWith(true)
    expect(setSubmitting).toHaveBeenLastCalledWith(false)
  })
})

describe('builder inquiry handoff', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('navigates to provider selection without auto-starting an inquiry', () => {
    const navigate = vi.fn()

    startBuilderInquirySelection('project-builder-1', navigate)

    expect(navigate).toHaveBeenCalledWith('/search', {
      state: { mode: 'project', projectId: 'project-builder-1' },
    })
    expect(getConversations()).toHaveLength(0)
  })

  it('provides provider-selection nav state derived from project id', () => {
    const target = buildBuilderInquiryNavigation('project-builder-2')

    expect(target).toEqual({
      path: '/search',
      state: { mode: 'project', projectId: 'project-builder-2' },
    })
  })
})
