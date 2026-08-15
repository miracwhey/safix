/**
 * Tests for notification delivery templates.
 * Verifies that buildEmailContent produces correct subject/text/html for each
 * delivery type, and that HTML is properly escaped for injection safety.
 */

import { describe, it, expect } from 'vitest'
import { buildEmailContent } from '../../src/lib/notifications/delivery/templates'

describe('buildEmailContent', () => {
  // ---------------------------------------------------------------------------
  // proposal_received
  // ---------------------------------------------------------------------------
  describe('proposal_received', () => {
    it('includes job title in subject and body', () => {
      const result = buildEmailContent('proposal_received', { jobTitle: 'Badsanierung' })
      expect(result.subject).toContain('Badsanierung')
      expect(result.text).toContain('Badsanierung')
      expect(result.html).toContain('Badsanierung')
    })

    it('falls back to generic job label when no title given', () => {
      const result = buildEmailContent('proposal_received', {})
      expect(result.subject).toContain('Ihr Auftrag')
      expect(result.text).toContain('Ihr Auftrag')
    })

    it('returns non-empty subject, text, and html', () => {
      const result = buildEmailContent('proposal_received', { jobTitle: 'Test' })
      expect(result.subject.length).toBeGreaterThan(0)
      expect(result.text.length).toBeGreaterThan(0)
      expect(result.html.length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // schedule_created
  // ---------------------------------------------------------------------------
  describe('schedule_created', () => {
    it('includes job title in subject', () => {
      const result = buildEmailContent('schedule_created', { jobTitle: 'Elektroinstallation' })
      expect(result.subject).toContain('Elektroinstallation')
    })

    it('html is well-formed with DOCTYPE', () => {
      const result = buildEmailContent('schedule_created', { jobTitle: 'Test' })
      expect(result.html).toMatch(/^<!DOCTYPE html>/)
    })
  })

  // ---------------------------------------------------------------------------
  // schedule_updated
  // ---------------------------------------------------------------------------
  describe('schedule_updated', () => {
    it('includes job title in subject and body', () => {
      const result = buildEmailContent('schedule_updated', { jobTitle: 'Malerarbeiten' })
      expect(result.subject).toContain('Malerarbeiten')
      expect(result.text).toContain('Malerarbeiten')
    })
  })

  // ---------------------------------------------------------------------------
  // work_completed
  // ---------------------------------------------------------------------------
  describe('work_completed', () => {
    it('mentions payment release action in text', () => {
      const result = buildEmailContent('work_completed', { jobTitle: 'Dacharbeiten' })
      expect(result.text).toContain('Zahlung')
    })

    it('includes job title in subject', () => {
      const result = buildEmailContent('work_completed', { jobTitle: 'Dacharbeiten' })
      expect(result.subject).toContain('Dacharbeiten')
    })
  })

  // ---------------------------------------------------------------------------
  // payment_release_requested
  // ---------------------------------------------------------------------------
  describe('payment_release_requested', () => {
    it('includes job title in subject and body', () => {
      const result = buildEmailContent('payment_release_requested', { jobTitle: 'Heizungseinbau' })
      expect(result.subject).toContain('Heizungseinbau')
      expect(result.text).toContain('Heizungseinbau')
    })
  })

  // ---------------------------------------------------------------------------
  // dispute_opened
  // ---------------------------------------------------------------------------
  describe('dispute_opened', () => {
    it('includes job title', () => {
      const result = buildEmailContent('dispute_opened', { jobTitle: 'Reparatur' })
      expect(result.subject).toContain('Reparatur')
      expect(result.text).toContain('Reparatur')
    })
  })

  // ---------------------------------------------------------------------------
  // dispute_evidence_requested
  // ---------------------------------------------------------------------------
  describe('dispute_evidence_requested', () => {
    it('mentions evidence submission in text', () => {
      const result = buildEmailContent('dispute_evidence_requested', { jobTitle: 'Umbau' })
      expect(result.text).toContain('Nachweise')
    })
  })

  // ---------------------------------------------------------------------------
  // HTML injection safety
  // ---------------------------------------------------------------------------
  describe('HTML escaping', () => {
    it('escapes HTML special characters in job title', () => {
      const result = buildEmailContent('proposal_received', {
        jobTitle: '<script>alert("xss")</script>',
      })
      expect(result.html).not.toContain('<script>')
      expect(result.html).toContain('&lt;script&gt;')
    })

    it('escapes ampersands in job title', () => {
      const result = buildEmailContent('schedule_created', {
        jobTitle: 'Bath & Kitchen',
      })
      expect(result.html).not.toMatch(/ & /)
      expect(result.html).toContain('&amp;')
    })
  })

  // ---------------------------------------------------------------------------
  // HTML structure
  // ---------------------------------------------------------------------------
  describe('HTML structure', () => {
    it('includes a plain-text footer note', () => {
      const result = buildEmailContent('work_completed', { jobTitle: 'Test' })
      expect(result.html).toContain('SaFix')
    })

    it('html contains lang="de"', () => {
      const result = buildEmailContent('dispute_opened', { jobTitle: 'Test' })
      expect(result.html).toContain('lang="de"')
    })
  })
})
