/**
 * Block D Slice 1b-B — Unified Chat UI primitives.
 *
 * Isolated, channel-agnostic, repo-agnostic components used by all 7
 * compose/detail screens once the Phase 1b-A read-only cutover ramps to
 * 100 %. Keep these stateless and prop-driven — business logic lives in
 * `lib/chat` + workflows.
 */

export { ChannelBadge } from './ChannelBadge'
export { ChatBubble } from './ChatBubble'
export { ChatConnectionBanner } from './ChatConnectionBanner'
export { ChatBubbleSkeleton, ChatInboxRowSkeleton } from './ChatBubbleSkeleton'
export { ChatComposer } from './ChatComposer'
export { ChatInboxRow } from './ChatInboxRow'
export { ChatReplyQuote } from './ChatReplyQuote'
export { ChatStatusIcon } from './ChatStatusIcon'

export {
  composerTilesFor,
  groupComposerTiles,
} from './composerTiles'
export type {
  ComposerIconKey,
  ComposerTile,
  ComposerTileKind,
  ComposerTileSection,
  ComposerTileSections,
} from './composerTiles'

export {
  bubbleStatusToken,
  bubbleStatusToneClass,
  shouldRenderBubbleStatus,
} from './chatBubbleStatus'
export type { BubbleStatusGlyph, BubbleStatusToken } from './chatBubbleStatus'

export { channelStyle } from './chatChannelStyle'
export type { ChannelStyle } from './chatChannelStyle'

export {
  inboxRowDisplay,
  inboxRowTimestamp,
  inboxRowUnreadBadge,
  inboxRowPreview,
} from './chatInboxRowFormat'
export type { InboxRowDisplay } from './chatInboxRowFormat'

export { ChatArtifactCardCompact } from './ChatArtifactCardCompact'
export type { ChatArtifactCardCompactProps } from './ChatArtifactCardCompact'

export {
  getArtifactRoute,
  isKnownArtifactType,
  KNOWN_ARTIFACT_TYPES,
} from './chatArtifactRouting'
export type {
  ArtifactRouteContext,
  ChatArtifactType,
  OfferDocumentSubtype,
} from './chatArtifactRouting'
