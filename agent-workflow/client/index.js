import { createElement } from 'react'
import { progressDefinition } from './progress.js'

export const inject = ['uiConversation', 'slots']
export function apply(ctx) {
  ctx.effect(() => ctx.uiConversation.events.register(progressDefinition))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'workflow-startup',
  }, (props) => {
    const progress = props.node.data
    return createElement('div', { role: progress.phase === 'failed' ? 'alert' : 'status',
      'aria-live': 'polite', style: { padding: '12px 16px', fontSize: '14px' } },
      `${progress.text} · ${(progress.elapsedMs / 1000).toFixed(1)} 秒`)
  }))
}
