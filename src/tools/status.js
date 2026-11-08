import { jsonTool } from './helpers.js'
import { compact, renderJson, sessionIdOf } from './helpers.js'

/** Render a panel status payload compactly as JSON. */
function summaryContent(value) {
  const text = JSON.stringify(value, null, 2)
  return [{ type: 'text', text: text.length > 20000 ? `${text.slice(0, 20000)}\n…[truncated]` : text }]
}

/** Register status/read tools. */
export function registerStatusTools(ctx, deps) {
  const { client, safety, scripts, events, watchdog, audit, config } = deps

  ctx.tools.register(jsonTool({
    name: 'panel_status',
    description: 'One-call overview of the 硅基之下控制中心 PC client: connection and session mode (local / remote-operator / remote-controlled), client window and current page, devices with key live values, current game, running scripts and event subscriptions, configured safety thresholds, watchdog leases, and recent audit entries. Start here before acting.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => summaryContent(value) },
    async execute(_args, exec) {
      const signal = exec.signal
      const sessionId = sessionIdOf(exec)
      const [remote, clientState, devices, game, runtime, ranges] = await Promise.all([
        client.remoteStatus({ signal }).catch((error) => ({ error: error.message, code: error.code })),
        client.clientState({ signal }).catch((error) => ({ available: false, error: error.message, code: error.code })),
        client.devices({ signal }).catch(() => []),
        client.gameStatus({ signal }).catch(() => null),
        client.gameRuntimeStatus({ signal }).catch(() => null),
        safety.getRanges({ signal }).catch(() => ({})),
      ])
      const mode = await safety.getMode({ signal })
      const payload = {
        mode,
        remote,
        client: compact(clientState, 20),
        devices: (devices || []).map((device) => ({
          id: device.id,
          name: device.nickname || device.name,
          type: device.type,
          connected: device.connected,
          controlConnection: device.controlConnection,
          lastReport: device.lastReport,
          keyData: pickLiveData(device.data),
        })),
        game: { status: compact(game, 20), runtime: compact(runtime, 20) },
        scripts: scripts.list({ sessionId }),
        subscriptions: events.list().filter((item) => item.ownerId === sessionId || item.kind === 'panel'),
        thresholds: config.limits,
        settings: {
          stopOnSessionEnd: config.stopOnSessionEnd,
          watchdogTtlSec: config.watchdogTtlSec,
        },
        emergency: safety.emergencyState(),
        eventStream: events.state,
        availableCapabilities: Object.keys(ranges || {}),
        watchdog: watchdog.status(),
        recentAudit: audit.recent(8),
        sessionId,
      }
      return payload
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'device_list',
    description: 'List devices visible to the plugin. In remote-operator mode the backend returns only devices projected from the authorized remote session, so these are the only devices you can control. Returns id, name, type, connected state, transport and (optionally) live data. Use device_get for capabilities, parameter ranges and thresholds.',
    parameters: {
      connectedOnly: { type: 'boolean', description: 'Only connected devices. Default false.' },
      type: { type: 'string', description: 'Filter by exact device type, e.g. PJ01, DIANJI, ZIDONGSUO.' },
      includeData: { type: 'boolean', description: 'Include the latest reported data object. Default true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      let devices = await client.devices({ signal: exec.signal })
      if (args.connectedOnly) devices = devices.filter((device) => device.connected)
      if (args.type) devices = devices.filter((device) => device.type === args.type)
      return {
        mode: await safety.getMode(),
        count: devices.length,
        devices: devices.map((device) => ({
          id: device.id,
          name: device.nickname || device.name,
          type: device.type,
          connected: device.connected,
          controlConnection: device.controlConnection,
          connections: (device.connections || []).map((connection) => connection.type),
          lastReport: device.lastReport,
          ...(args.includeData === false ? {} : { data: device.data || {} }),
        })),
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'device_get',
    description: 'Inspect one device: metadata, capabilities available on its type, preset operations, monitor-data fields, the numeric parameter ranges used by threshold scaling, and the currently configured percentage limit for each capability. Use this before device_control when you need exact capability/action names or ranges.',
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device id from device_list.' },
      includeMonitor: { type: 'boolean', description: 'Fetch the latest monitor-data snapshot. Default true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const device = await client.device(args.deviceId, { signal: exec.signal })
      const [typeConfig, monitor, allRanges] = await Promise.all([
        client.deviceTypeConfig(device.type, { signal: exec.signal }).catch(() => null),
        args.includeMonitor === false ? null : client.monitorData(args.deviceId, { signal: exec.signal }).catch(() => null),
        safety.getRanges({ signal: exec.signal }).catch(() => ({})),
      ])
      const capabilities = typeConfig?.capabilities || Object.keys(typeConfig?.capabilityConfig || {})
      const ranges = {}
      for (const capability of capabilities) if (allRanges[capability]) ranges[capability] = allRanges[capability]
      return {
        mode: await safety.getMode(),
        device,
        capabilities,
        capabilityConfig: compact(typeConfig?.capabilityConfig || {}, 30),
        operations: typeConfig?.operations || [],
        monitorDataSpec: typeConfig?.monitorData || [],
        ranges,
        thresholds: Object.fromEntries(capabilities.map((capability) => [capability, config.limits?.capabilities?.[capability] ?? config.limits?.default ?? 60])),
        monitor,
      }
    },
  }))
}

function pickLiveData(data) {
  if (!data || typeof data !== 'object') return {}
  const keys = ['power', 'voltage', 'shock', 'vibration', 'suction', 'heart_rate', 'hr_status', 'pressure', 'pressure1', 'distance', 'weight', 'open', 'quat']
  const out = {}
  for (const key of keys) if (data[key] !== undefined) out[key] = data[key]
  return out
}
