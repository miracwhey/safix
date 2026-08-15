import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import AssignmentIntegrityWarningBanner from '../../src/components/jobs/AssignmentIntegrityWarningBanner'
import type { AssignmentIntegrityWarning } from '../../src/lib/jobs'
import type { TeamMember } from '../../src/lib/jobs/types'

function makeWarning(
  inProgress: { id: string; title: string }[],
  scheduled: { id: string; title: string }[],
): AssignmentIntegrityWarning {
  return {
    hasAnyGap: inProgress.length + scheduled.length > 0,
    hasActiveGap: inProgress.length > 0,
    gapCount: inProgress.length + scheduled.length,
    inProgressUnassigned: inProgress.map((j) => ({ id: j.id, title: j.title })),
    scheduledUnassigned: scheduled.map((j) => ({ id: j.id, title: j.title })),
  } as AssignmentIntegrityWarning
}

const TEAM: TeamMember[] = [
  { id: 'm1', name: 'T. Wagner', role: 'Mitarbeiter' } as TeamMember,
  { id: 'm2', name: 'M. Albrecht', role: 'Mitarbeiter' } as TeamMember,
]

function render(
  warning: AssignmentIntegrityWarning,
  team: TeamMember[] = TEAM,
): string {
  return renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(AssignmentIntegrityWarningBanner, {
        warning,
        teamMembers: team,
        onAssignWorker: () => {},
        onTakeJobMyself: () => {},
      }),
    ),
  )
}

describe('AssignmentIntegrityWarningBanner — inline lift (L2)', () => {
  it('renders nothing when there is no gap', () => {
    const html = render(makeWarning([], []))
    expect(html).toBe('')
  })

  it('renders an inline Zuweisen affordance per affected job', () => {
    const html = render(
      makeWarning(
        [{ id: 'j1', title: 'Bad-Sanierung Müller' }],
        [{ id: 'j2', title: 'Fenster-Tausch Schulze' }],
      ),
    )
    // Both jobs surfaced
    expect(html).toContain('Bad-Sanierung Müller')
    expect(html).toContain('Fenster-Tausch Schulze')
    // Two assignment toggle buttons (one per job)
    const matches = html.match(/data-testid="assignment-warning-toggle-/g)
    expect(matches?.length).toBe(2)
    expect(html).toContain('Zuweisen')
  })

  it('keeps a secondary Detail link with focus=assignment anchor', () => {
    const html = render(
      makeWarning([{ id: 'job-42', title: 'Heizung Becker' }], []),
    )
    expect(html).toContain('href="/craftsman/jobs/job-42?focus=assignment"')
    expect(html).toContain('Detail')
  })

  it('drops the legacy Admin-Bereich text hint that pointed users away', () => {
    const html = render(
      makeWarning(
        [{ id: 'j1', title: 'Bad-Sanierung Müller' }],
        [],
      ),
    )
    expect(html).not.toContain('in der Auftragsdetailansicht zuweisen')
    expect(html).not.toContain('(Admin-Bereich)')
  })

  it('keeps the count chips for in-progress and scheduled gaps', () => {
    const html = render(
      makeWarning(
        [{ id: 'j1', title: 'Bad-Sanierung Müller' }],
        [
          { id: 'j2', title: 'Fenster-Tausch Schulze' },
          { id: 'j3', title: 'Heizung Becker' },
        ],
      ),
    )
    expect(html).toMatch(/1[^a-zA-Z<]*<!--[^>]*-->\s*in Arbeit|1\s*in Arbeit/)
    expect(html).toMatch(/2[^a-zA-Z<]*<!--[^>]*-->\s*geplant|2\s*geplant/)
  })

  it('switches the primary copy to critical when active jobs are unassigned', () => {
    const criticalHtml = render(
      makeWarning([{ id: 'j1', title: 'A' }], []),
    )
    expect(criticalHtml).toContain('Sofortiger Handlungsbedarf')

    const onlyScheduledHtml = render(
      makeWarning([], [{ id: 'j2', title: 'B' }]),
    )
    expect(onlyScheduledHtml).toContain('Priorisierung empfohlen')
  })

  it('still renders a row per gap even when the count is large (skalierbar bleibt list-shaped)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `job-${i}`,
      title: `Auftrag ${i}`,
    }))
    const html = render(makeWarning(many, []))
    // All 12 toggle affordances are rendered — the list stays canonical and
    // shrinks naturally as assignments resolve, with at most one expanded
    // row at a time keeping height bounded.
    const matches = html.match(/data-testid="assignment-warning-toggle-/g)
    expect(matches?.length).toBe(12)
  })
})
