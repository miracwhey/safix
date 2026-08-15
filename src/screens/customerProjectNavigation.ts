export function buildBuilderInquiryNavigation(projectId: string) {
  return {
    path: '/search',
    state: { mode: 'project' as const, projectId },
  }
}

export function startBuilderInquirySelection(
  projectId: string,
  navigate: (path: string, options?: { state?: unknown }) => void
) {
  const target = buildBuilderInquiryNavigation(projectId)
  navigate(target.path, { state: target.state })
}
