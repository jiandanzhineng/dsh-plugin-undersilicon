import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { ControlPanelClient } from './src/sdk/client.js'
import { AuditLog } from './src/safety/audit.js'
import { SafetyLayer } from './src/safety/safety.js'
import { Watchdog } from './src/safety/watchdog.js'
import { AgentLease } from './src/safety/lease.js'
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
import { SettingsStore } from './src/settings.js'
import { resolvePercent, limitFor } from './src/safety/scale.js'
import { sleep } from './src/util/errors.js'

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
    maxSessions: z.number().min(1).max(32).step(1).default(8),
    allowPersist: z.boolean().default(true),
    memoryMb: z.number().min(16).max(512).step(1).default(64),
    syncTimeoutMs: z.number().min(100).max(60000).step(100).default(5000),
    heartbeatTimeoutMs: z.number().min(1000).max(60000).step(500).default(5000),
    maxLogs: z.number().min(50).max(5000).step(50).default(500),
  }).default({}),
  events: z.object({
    maxSubscriptions: z.number().min(1).max(64).step(1).default(20),
    maxTotalSubscriptions: z.number().min(1).max(256).step(1).default(64),
    minThrottleMs: z.number().min(500).max(3600000).step(100).default(500),
    defaultThrottleMs: z.number().min(500).max(3600000).step(100).default(1000),
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
  const settings = new SettingsStore({ config: resolved, log })
  const runtimeConfig = {}
  Object.assign(runtimeConfig, settings.applyTo())
  settings.config = runtimeConfig
  const applySettings = () => {
    Object.assign(runtimeConfig, settings.applyTo())
    settings.config = runtimeConfig
    watchdog.setTtl(runtimeConfig.watchdogTtlSec)
    lease.setTtl(runtimeConfig.watchdogTtlSec)
    lease.setLimits(runtimeConfig.limits)
    safety.config = runtimeConfig
    events.config = runtimeConfig
    scripts.config = runtimeConfig
  }
  const client = new ControlPanelClient({ baseUrl: runtimeConfig.baseUrl })
  const audit = new AuditLog({ enabled: runtimeConfig.auditEnabled })
  const watchdog = new Watchdog({ client, ttlSeconds: runtimeConfig.watchdogTtlSec, log })
  const lease = new AgentLease({
    client, ttlSeconds: runtimeConfig.watchdogTtlSec, limits: runtimeConfig.limits, log,
  })
  const safety = new SafetyLayer({ client, config: runtimeConfig, audit, watchdog, lease, log })
  const events = new EventManager({ client, config: runtimeConfig, audit, log })
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
    const result = await safety.emergencyStop({ sessionId, source, reason, skipHooks: true })
    watchdog.stop(sessionId)
    return result
  }
  const statusProvider = async ({ panel = false } = {}) => {
    if (panel) events.keepPanelAlive()
    const [mode, devices, clientState, game, runtime, ranges] = await Promise.all([
      safety.getMode().catch(() => 'unknown'),
      client.devices().catch(() => []),
      client.clientState().catch((error) => ({ available: false, error: error.message })),
      client.gameStatus().catch(() => null),
      client.gameRuntimeStatus().catch(() => null),
      safety.getRanges().catch(() => ({})),
    ])
    return {
      mode,
      baseUrl: client.baseUrl,
      deviceCount: (devices || []).length,
      devices: (devices || []).map((device) => ({
        id: device.id, name: device.nickname || device.name, type: device.type,
        connected: device.connected, controlConnection: device.controlConnection,
        data: pickPanelData(device.data),
        bars: panelBars(device.data, ranges, runtimeConfig.limits),
      })),
      client: clientState,
      game: { status: game, runtime },
      scripts: scripts?.list() || [],
      subscriptions: events.list(),
      watchdog: watchdog.status(),
      lease: lease.status(),
      stream: events.state,
      emergency: safety.emergencyState(),
      thresholds: runtimeConfig.limits,
      availableCapabilities: Object.keys(ranges || {}),
      settings: settings.snapshot(),
      audit: audit.recent(12),
    }
  }
  scripts = new ScriptManager({
    client, safety, events, audit, config: runtimeConfig, log,
    notifyAgent, emergencyStop: stopDevices, statusProvider,
  })
  safety.setEmergencyHooks({
    stopScripts: (reason) => scripts.stopAll(reason, undefined, { explicit: false }),
    stopSubscriptions: () => events.dispose(),
    stopWatchdog: (sessionId) => watchdog.stop(sessionId),
  })
  void lease.probe().catch((error) => log('lease probe failed', { error: error.message }))
  const deps = {
    client, safety, watchdog, scripts, events, audit, config: runtimeConfig, log, lease,
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
      status: () => statusProvider({ panel: true }),
      audit,
      scripts,
      events,
      emergencyStop: async (payload) => {
        const reason = payload?.reason || 'panel emergency stop'
        safety.halt({ reason, latch: true })
        const stopped = scripts.stopAll('panel-emergency-stop', undefined, { explicit: false })
        events.dispose()
        watchdog.stop(payload?.sessionId || 'panel')
        const result = await safety.emergencyStop({
          sessionId: payload?.sessionId || 'panel', source: { kind: 'panel', name: 'emergency_stop' },
          reason, signal: AbortSignal.timeout(30000), skipHalt: true,
        })
        return { ...result, stoppedScripts: stopped, latch: safety.emergencyState() }
      },
      emergencyResume: async (payload) => safety.resume({
        sessionId: payload?.sessionId || 'panel',
        source: { kind: 'panel', name: 'emergency_resume' },
      }),
      updateSettings: async (patch) => {
        const before = settings.snapshot()
        const snapshot = await settings.update(patch)
        applySettings()
        audit.record({
          sessionId: 'panel', source: { kind: 'panel', name: 'settings' }, action: 'settings.update',
          request: { patch, before: before.overrides }, result: { ok: true, settings: snapshot },
        })
        return snapshot
      },
      getSettings: async () => settings.snapshot(),
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
    void lease.release(sessionId).catch((error) => log('session-end lease release failed', { error: error.message }))
    audit.record({
      sessionId, source: { kind: 'system', name: 'session-end' }, action: 'session.end',
      result: { ok: true, stopOnSessionEnd: runtimeConfig.stopOnSessionEnd },
    })
    if (runtimeConfig.stopOnSessionEnd) {
      void stopDevices({
        sessionId, source: { kind: 'system', name: 'session-end' }, reason: 'session-end stopOnSessionEnd',
      }).catch((error) => log('session-end stop failed', { error: error.message }))
    }
  })

  ctx.effect(() => async () => {
    scripts.dispose()
    events.dispose()
    if (runtimeConfig.stopOnSessionEnd) {
      const stop = safety.emergencyStop({
        sessionId: 'plugin-dispose', source: { kind: 'system', name: 'plugin-dispose' },
        reason: 'plugin-dispose stopOnSessionEnd', signal: AbortSignal.timeout(3000),
      }).catch((error) => log('dispose stop failed', { error: error.message }))
      await Promise.race([stop, sleep(3000)])
    }
    watchdog.dispose()
    await lease.dispose()
    audit.record({ source: { kind: 'system', name: 'plugin-dispose' }, action: 'plugin.dispose', result: { ok: true } })
    await audit.flush()
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

/** Intensity bars with the reachable threshold, used by the panel. */
function panelBars(data, ranges, limits) {
  if (!data || typeof data !== 'object') return []
  const specs = [
    ['power', 'strength', 'set', 'value'],
    ['voltage', 'shock', 'start', 'voltage'],
    ['vibration', 'vibration', 'set', 'value'],
    ['suction', 'suction', 'set', 'value'],
  ]
  const bars = []
  for (const [key, capability, action, field] of specs) {
    const value = Number(data[key])
    if (!Number.isFinite(value)) continue
    const range = ranges?.[capability]?.[action]?.[field]
    if (!range) continue
    const percent = resolvePercent(limits, capability, action, field)
    bars.push({
      key, label: key, value, min: range.min, max: range.max,
      limit: Math.floor(limitFor(range, percent)), percent,
      ...(range.unit ? { unit: range.unit } : {}),
    })
  }
  return bars
}
