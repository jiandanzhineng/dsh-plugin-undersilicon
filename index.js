import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { ControlPanelClient } from './src/sdk/client.js'
import { AuditLog } from './src/safety/audit.js'
import { SafetyLayer } from './src/safety/safety.js'
import { Watchdog } from './src/safety/watchdog.js'
import { EventManager } from './src/events/manager.js'
import { ScriptManager } from './src/scripts/manager.js'
import { registerStatusTools } from './src/tools/status.js'
import { registerDeviceTools } from './src/tools/devices.js'
import { registerGameTools } from './src/tools/games.js'
import { registerClientTools } from './src/tools/client.js'
import { registerScriptTools } from './src/tools/scripts.js'
import { registerEventTools } from './src/tools/events.js'
import { registerApiTools } from './src/tools/api.js'
import { createPanelHandler } from './src/client-rpc.js'
import { SKILL } from './src/skill.js'

export const name = 'undersilicon'
export const inject = ['tools']

export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:5278/api'),
  limits: z.object({
    default: z.number().min(0).max(100).default(60),
    capabilities: z.dict(z.number().min(0).max(100)).default({ shock: 30 }),
  }).default({ default: 60, capabilities: { shock: 30 } }),
  stopOnSessionEnd: z.boolean().default(true),
  watchdogTtlSec: z.number().min(5).max(600).step(1).default(30),
  auditEnabled: z.boolean().default(true),
  scripts: z.object({
    maxConcurrent: z.number().min(1).max(32).step(1).default(8),
    allowPersist: z.boolean().default(true),
    memoryMb: z.number().min(16).max(512).step(1).default(64),
    syncTimeoutMs: z.number().min(100).max(60000).step(100).default(5000),
    heartbeatTimeoutMs: z.number().min(1000).max(60000).step(500).default(5000),
    maxLogs: z.number().min(50).max(5000).step(50).default(500),
  }).default({}),
  events: z.object({
    maxSubscriptions: z.number().min(1).max(64).step(1).default(16),
    minThrottleMs: z.number().min(100).max(60000).step(100).default(200),
    defaultThrottleMs: z.number().min(200).max(60000).step(100).default(1000),
    maxEvents: z.number().min(1).max(1000).step(1).default(30),
  }).default({}),
})

/** Create a logger that works with cordis' logger and stays quiet in tests. */
function makeLogger(ctx) {
  return (message, meta) => {
    const line = meta && Object.keys(meta).length ? `${message} ${JSON.stringify(meta)}` : message
    if (ctx.logger?.info) ctx.logger.info(line)
    else if (process.env.DSH_UNDERSILICON_DEBUG) console.error(`[undersilicon] ${line}`)
  }
}

/**
 * Plugin body. Everything is created per plugin instance so a reload tears down
 * its streams, scripts and leases cleanly.
 */
export function apply(ctx, config = {}) {
  const resolved = Config(config ?? {})
  const log = makeLogger(ctx)
  const client = new ControlPanelClient({ baseUrl: resolved.baseUrl })
  const audit = new AuditLog({ enabled: resolved.auditEnabled })
  const watchdog = new Watchdog({ client, ttlSeconds: resolved.watchdogTtlSec, log })
  const safety = new SafetyLayer({ client, config: resolved, audit, watchdog, log })
  const events = new EventManager({ client, config: resolved, audit, log })
  let scripts
  const notifyAgent = async (agent, text, wake, script) => {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `[undersilicon script ${script?.name || script?.id || ''}] ${text}` }],
      source: { kind: 'undersilicon' },
    }
    if (wake) agent.followup(message)
    else agent.inject(message)
  }
  const stopDevices = async ({ sessionId, source, reason }) => {
    const result = await safety.emergencyStop({ sessionId, source, reason })
    watchdog.stop(sessionId)
    return result
  }
  const statusProvider = async () => {
    const [mode, devices, clientState, game, runtime] = await Promise.all([
      safety.getMode().catch(() => 'unknown'),
      client.devices().catch(() => []),
      client.clientState().catch((error) => ({ available: false, error: error.message })),
      client.gameStatus().catch(() => null),
      client.gameRuntimeStatus().catch(() => null),
    ])
    return {
      mode,
      baseUrl: client.baseUrl,
      deviceCount: (devices || []).length,
      devices: (devices || []).map((device) => ({
        id: device.id, name: device.nickname || device.name, type: device.type,
        connected: device.connected, controlConnection: device.controlConnection,
        data: pickPanelData(device.data),
      })),
      client: clientState,
      game: { status: game, runtime },
      scripts: scripts?.list() || [],
      subscriptions: events.list(),
      watchdog: watchdog.status(),
      stream: events.state,
      thresholds: resolved.limits,
      audit: audit.recent(12),
    }
  }
  scripts = new ScriptManager({
    client, safety, events, audit, config: resolved, log,
    notifyAgent, emergencyStop: stopDevices, statusProvider,
  })
  const deps = {
    client, safety, watchdog, scripts, events, audit, config: resolved, log,
    getAttachments: () => ctx.get('attachments'),
    canUseImage: (exec) => canUseImage(ctx, exec),
  }
  registerStatusTools(ctx, deps)
  registerDeviceTools(ctx, deps)
  registerGameTools(ctx, deps)
  registerClientTools(ctx, deps)
  registerScriptTools(ctx, deps)
  registerEventTools(ctx, deps)
  registerApiTools(ctx, deps)

  // Optional: a built-in skill teaches the model the workflow and API details.
  ctx.inject(['skills'], (scoped) => {
    try { scoped.skills.register(SKILL) } catch (error) { log('skill registration failed', { error: error.message }) }
  })

  // Right-sidebar panel RPC. `connection.rpc.handle` is unusable on dsh
  // 0.2.1-rc.3 (it reads `webServer` from the connection plugin's own
  // context, which does not inject it), so the panel uses one exact
  // authenticated `/api` Fetch route instead.
  ctx.inject(['connection'], (scoped) => {
    const handler = createPanelHandler({
      status: statusProvider,
      audit,
      scripts,
      events,
      emergencyStop: async (payload) => {
        const stopped = scripts.stopAll('panel-emergency-stop', undefined, { explicit: false })
        events.dispose()
        const result = await stopDevices({
          sessionId: payload?.sessionId || 'panel', source: { kind: 'panel', name: 'emergency_stop' },
          reason: payload?.reason || 'panel emergency stop',
        })
        return { ...result, stoppedScripts: stopped }
      },
    })
    const dispose = scoped.connection.fetch.register({
      path: '/api/undersilicon',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: { code: 'BAD_REQUEST', message: 'body is not JSON', details: {} } }, { status: 400 })
        }
        const result = await handler(String(body?.endpoint || ''), body?.payload ?? {})
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      },
    })
    scoped.effect(() => dispose)
  })

  // Session lifecycle: stop that session's scripts/subscriptions and, when the
  // user opted in, stop every device.
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    scripts.stopSession(sessionId, 'session-end')
    events.unsubscribeOwner(sessionId)
    audit.record({
      sessionId, source: { kind: 'system', name: 'session-end' }, action: 'session.end',
      result: { ok: true, stopOnSessionEnd: resolved.stopOnSessionEnd },
    })
    if (resolved.stopOnSessionEnd) {
      void stopDevices({
        sessionId, source: { kind: 'system', name: 'session-end' }, reason: 'session-end stopOnSessionEnd',
      }).catch((error) => log('session-end stop failed', { error: error.message }))
    }
  })

  ctx.effect(() => () => {
    scripts.dispose()
    events.dispose()
    watchdog.dispose()
    audit.record({ source: { kind: 'system', name: 'plugin-dispose' }, action: 'plugin.dispose', result: { ok: true } })
    void audit.flush()
  })

  // Restore persisted scripts after the plugin is active.
  void scripts.restore().catch((error) => log('script restore failed', { error: error.message }))
}

/** Gate image attachments on the current model route, like read_image does. */
async function canUseImage(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (!provider || !model || !llm?.resolveModelInfo) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}


/** Small live-value projection used by the sidebar panel. */
function pickPanelData(data) {
  if (!data || typeof data !== 'object') return {}
  const keys = ['power', 'voltage', 'shock', 'vibration', 'suction', 'heart_rate', 'hr_status', 'pressure', 'pressure1', 'distance', 'weight', 'open']
  const out = {}
  for (const key of keys) if (data[key] !== undefined) out[key] = data[key]
  return out
}
