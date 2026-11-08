import { jsonTool } from './helpers.js'
import { renderJson, sessionIdOf, toolSource } from './helpers.js'

/** Register the raw-request escape hatch (still gated by the safety layer). */
export function registerApiTools(ctx, deps) {
  const { safety } = deps

  ctx.tools.register(jsonTool({
    name: 'panel_api',
    description: [
      'Call the local control-panel HTTP API directly when no dedicated tool fits. Base is http://127.0.0.1:5278/api; pass a path such as /devices or /games/status (a leading /api is accepted).',
      'The safety layer still applies: raw device messages (/devices/:id/message), /devices/batch, /mqtt-client, serial/flashing/firmware, local-app launch, plugin/auth/model writes, device deletion and remote-session lifecycle are blocked. Capability and operation paths are threshold-scaled. Every non-GET call is written to the audit log. Prefer dedicated tools when one exists.',
    ].join('\n'),
    parameters: {
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method.' },
      path: { type: 'string', required: true, description: 'API path, e.g. /devices or /logs/current.' },
      body: { type: 'json', description: 'JSON request body.' },
      query: { type: 'json', description: 'Query parameters object.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      if (!args.path) throw new Error('path is required')
      return safety.raw({
        sessionId: sessionIdOf(exec), source: toolSource('panel_api', exec),
        method: args.method, path: args.path, body: args.body, query: args.query,
        signal: exec.signal,
      })
    },
  }))
}
