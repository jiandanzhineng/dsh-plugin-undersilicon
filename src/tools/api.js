import { jsonTool } from './helpers.js'
import { renderJson, sessionIdOf, toolSource } from './helpers.js'

/** Register the raw-request escape hatch (still gated by the safety layer). */
export function registerApiTools(ctx, deps) {
  const { safety } = deps

  ctx.tools.register(jsonTool({
    name: 'panel_api',
    description: [
      'Call the local control-panel HTTP API directly when no dedicated tool fits. Base is http://127.0.0.1:5278/api; pass a path such as /devices or /games/status (a leading /api is accepted).',
      'GET/HEAD reads are limited to an agent whitelist: devices, capabilities, device types, game list/status/manifest, game-runtime status, client state/routes, recent events, remote-session status, brands status and voice status. Account/log/model/test/virtual-device/MQTT/serial/network endpoints and SSRF-style reads (external game meta, brand discovery) are blocked. Mutating requests are whitelisted: capability actions (scaled), preset operations (scaled, defaults merged), /client/* UI control, game start/stop/runtime control (game intensity params scaled), brand connect/disconnect, device rename/nickname/transport, device-watchdog/stop-all and remote-session/emergency-stop. Raw stop-all/remote emergency run the full plugin emergency flow (scripts, subscriptions, in-flight requests). Paths are canonicalized (case, dot segments, encoded slashes, trailing slashes), and a body must not contain both input and params. Every non-GET call is audited.',
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
