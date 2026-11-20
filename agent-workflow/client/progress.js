/** Log-only progress, independent of model history or workflow authorization. */
export const progressDefinition = {
  kind: 'workflow-startup', target: 'chat',
  match(event) {
    return event.type === 'plugin:agent-workflow/startup' ? { id: event.data.id, role: 'start' } : null
  },
  start(_context, match) { return { ...match.event.data, anchorSeq: match.event.seq } },
  update(context, match) { return { ...match.event.data, anchorSeq: context.state.anchorSeq } },
  buildViewNode(context) {
    return { key: context.key, kind: 'workflow-startup', id: context.id, target: 'chat',
      anchorSeq: context.state.anchorSeq, location: context.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: context.state }
  },
}
