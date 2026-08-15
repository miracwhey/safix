/**
 * PortfolioCommentsPanel — Source-Contract (Block 2: TikTok-Parity)
 *
 * Lockt das neue Comment-Sheet-Layout + Threading-Surface gegen
 * Regressionen:
 *  - 90dvh full / 60dvh half Snap-Points (kein "kleiner Balken" mehr)
 *  - BottomNav-Cut-off-Fix via Portal zu document.body (root-cause-Fix:
 *    escaped die Feed-Momentum-Scroll-<main>, in der iOS WKWebView
 *    position:fixed unter die BottomNav klemmte)
 *  - Threaded Replies (1-Level), per-Comment-Heart, Top/Neueste-Sort,
 *    Author-Edit, Author-OR-Host-Delete
 *  - Single-source via `useComments` Hook (kein Direct-Supabase im UI)
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/components/explore/PortfolioCommentsPanel.tsx'),
  'utf-8',
)

describe('PortfolioCommentsPanel: module shape', () => {
  it('default-exports the component', () => {
    expect(source).toMatch(/export default function PortfolioCommentsPanel/)
  })

  it('uses the canonical hook (single source of truth)', () => {
    expect(source).toContain('useComments')
    expect(source).toContain("from '../../lib/providerMedia/useComments'")
  })

  it('does not import supabase directly (writes go through the hook/service)', () => {
    expect(source).not.toContain("from '../../lib/supabase'")
  })
})

describe('PortfolioCommentsPanel: dialog contract', () => {
  it('renders a top-anchored full-bleed overlay', () => {
    expect(source).toContain('fixed left-0 right-0 top-0')
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
  })

  it('portals to document.body so the sheet escapes the feed scroll container and covers the BottomNav (cut-off-fix)', () => {
    expect(source).toContain("import { createPortal } from 'react-dom'")
    expect(source).toMatch(/return createPortal\(/)
    expect(source).toContain('document.body')
  })

  it('offers two snap-points (full ~90dvh, half ~60dvh) instead of the legacy 78vh cap', () => {
    expect(source).toContain('90dvh')
    expect(source).toContain('60dvh')
    expect(source).not.toContain('max-h-[78vh]')
  })

  it('returns null when not open or media id is missing', () => {
    expect(source).toMatch(/if \(!open \|\| !mediaId\) return null/)
  })

  it('listens for Escape to close (with reply / edit cancellation precedence)', () => {
    expect(source).toContain("event.key !== 'Escape'")
    // Batch-3 hardening: when the nested report sheet is open the panel yields
    // Escape to it instead of tearing down the whole comment thread.
    expect(source).toContain('if (reportTarget) return')
  })

  it('tracks the visualViewport to keep the composer above the iOS keyboard', () => {
    expect(source).toContain('visualViewport')
  })
})

describe('PortfolioCommentsPanel: composer guards', () => {
  it('hides the textarea + submit when not signed in', () => {
    expect(source).toContain('Bitte logge dich ein, um zu kommentieren.')
  })

  it('caps the textarea by COMMENT_BODY_MAX_LEN (single source of truth)', () => {
    expect(source).toContain('COMMENT_BODY_MAX_LEN')
    expect(source).toContain('maxLength={COMMENT_BODY_MAX_LEN}')
  })

  it('disables submit when draft is empty / submitting', () => {
    expect(source).toContain('submittable')
    expect(source).toMatch(/disabled=\{!submittable\}/)
  })

  it('submits via post(draft, parentId) and clears the draft on success', () => {
    // Block 2 erweitert post() um den optionalen parentCommentId-Parameter
    // (1-Level-Threading). Der Composer sendet `replyTarget?.id ?? null`.
    expect(source).toMatch(/post\(draft,\s*replyTarget\?\.id\s*\?\?\s*null\)/)
    expect(source).toContain("setDraft('')")
  })
})

describe('PortfolioCommentsPanel: threading + engagement', () => {
  it('renders a reply affordance per comment that targets the top-level parent', () => {
    expect(source).toContain('Antworten')
    expect(source).toMatch(/setReplyTarget\(\{[^}]*id:\s*comment\.id/)
  })

  it('exposes a per-comment heart driven by the hook toggleLike', () => {
    expect(source).toContain('toggleLike(')
    expect(source).toContain('summary.likedByMe')
  })

  it('lazy-loads replies via expandReplies(parentId) and supports collapse', () => {
    expect(source).toContain('expandReplies(comment.id)')
    expect(source).toContain('collapseReplies(comment.id)')
  })

  it('offers a Top / Neueste sort toggle wired to the hook setSort', () => {
    expect(source).toContain('SortToggle')
    expect(source).toMatch(/<SortToggle\s+sort=\{sort\}\s+onChange=\{setSort\}/)
  })
})

describe('PortfolioCommentsPanel: edit / delete affordance', () => {
  it('allows the author to edit their own comment via the hook edit()', () => {
    expect(source).toMatch(/edit\(editingId,\s*editingDraft\)/)
  })

  it('exposes the trash button when viewer is the author OR the host (provider-owner)', () => {
    expect(source).toContain('comment.userId === currentUserId')
    expect(source).toContain('providerOwnerUserId === currentUserId')
  })

  it('does not allow delete for anonymous viewers', () => {
    expect(source).toContain('!!currentUserId')
  })

  it('drives the delete button via the hook (remove)', () => {
    expect(source).toContain('remove(comment.id)')
    expect(source).toContain('remove(reply.id)')
  })
})

describe('PortfolioCommentsPanel: error surface', () => {
  it('renders the hook error inline with role="alert"', () => {
    expect(source).toContain('role="alert"')
  })
})
