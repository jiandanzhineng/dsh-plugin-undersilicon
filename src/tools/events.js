import { jsonTool } from './helpers.js'
import { renderJson, sessionIdOf } from './helpers.js'

const EVENT_TYPES = [
  'device.added', 'device.removed', 'device.connected', 'device.disconnected', 'device.updated',
  'game.started', 'game.stopped', 'game.state',
  'session.mode', 'session.revoked',
  'client.route', 'client.window',
]

/** Register no-code event subscription tools. */
export function registerEventTools(ctx, deps) {
  const { events } = deps

  ctx.tools.register(jsonTool({
    name: 'events_subscribe',
    description: [
      'Subscribe to the control-center event stream without writing a script. Matching events are delivered to this agent as follow-up messages (mode=wake, starts a turn) or injected context (mode=inject, no wake).',
      'Event types (prefixes allowed: device, game, session, client): device.added/removed/connected/disconnected/updated {deviceId, changes, data}; game.started/stopped/state {gameId}; session.mode {mode}; session.revoked; client.route {path}; client.window {visible,focused,minimized}.',
      'Filter with where={field:"data.heart_rate",op:"gte",value:150} (ops: eq,ne,gt,gte,lt,lte,contains,exists,truthy,falsy). Events are merged per throttleMs window and the subscription auto-ends after maxEvents deliveries. Keep subscriptions narrow and short-lived; unsubscribe when done.',
    ].join('\n'),
    parameters: {
      types: { type: 'array', required: true, items: { type: 'string' }, description: 'Event types or prefixes, e.g. ["device.updated"] or ["device"].' },
      deviceId: { type: 'string', description: 'Only events for this device id.' },
      where: {
        type: 'object', additionalProperties: false,
        properties: {
          field: { type: 'string', required: true, description: 'Dot path into the event, e.g. data.heart_rate.' },
          op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'truthy', 'falsy'], description: 'Comparison. Default eq.' },
          value: { type: 'json', description: 'Comparison value.' },
        },
        description: 'Optional single condition.',
      },
      mode: { type: 'string', enum: ['wake', 'inject'], description: 'wake starts a turn; inject waits for the next turn. Default wake.' },
      prompt: { type: 'string', description: 'Short reminder included with every delivery, e.g. "心率过高时把强度降到 0".' },
      throttleMs: { type: 'integer', description: 'Merge window in ms, 500-3600000. Default 1000.' },
      maxEvents: { type: 'integer', description: 'Auto-unsubscribe after 1-1000 deliveries. Default 30. A session may hold at most 20 subscriptions.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const types = Array.isArray(args.types) ? args.types.map(String) : []
      if (types.length === 0) throw new Error('types must contain at least one event type')
      for (const type of types) {
        const known = EVENT_TYPES.some((item) => item === type || item.startsWith(`${type}.`))
        if (!known) throw new Error(`unknown event type "${type}"; known: ${EVENT_TYPES.join(', ')}`)
      }
      const subscription = events.subscribe({
        kind: 'agent', ownerId: sessionIdOf(exec), agent: exec.agent,
        types, deviceId: args.deviceId, where: args.where,
        mode: args.mode, prompt: args.prompt,
        throttleMs: args.throttleMs, maxEvents: args.maxEvents,
      })
      return {
        ...subscription,
        note: `Subscribed. Deliveries use ${subscription.mode}; auto-unsubscribe after ${subscription.maxEvents} events. Stream status: ${JSON.stringify(events.state)}`,
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'events_unsubscribe',
    description: 'Cancel one event subscription by id, or all subscriptions owned by this agent session when subscriptionId is omitted. Always cancel subscriptions that are no longer needed.',
    parameters: {
      subscriptionId: { type: 'string', description: 'Subscription id from events_subscribe. Omit to cancel all in this session.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const ownerId = sessionIdOf(exec)
      if (args.subscriptionId) {
        return { ok: events.unsubscribe(args.subscriptionId, { ownerId }), subscriptionId: args.subscriptionId }
      }
      return { ok: true, removed: events.unsubscribeOwner(ownerId) }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'events_recent',
    description: 'Read recent events from the plugin ring buffer (last 200); when the buffer is empty it asks /api/events/recent. Useful for confirming device activity or reconstructing what happened before subscribing.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum events, 1-200. Default 50.' },
      types: { type: 'array', items: { type: 'string' }, description: 'Filter by event types/prefixes.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args) {
      return { events: await events.recent({ limit: args.limit ?? 50, types: args.types }), stream: events.state }
    },
  }))
}
