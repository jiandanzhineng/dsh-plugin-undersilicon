import { jsonTool } from './helpers.js'
import { renderJson, sessionIdOf, toolSource } from './helpers.js'

/** Register device control/management tools. */
export function registerDeviceTools(ctx, deps) {
  const { client, safety, scripts, events, watchdog } = deps

  ctx.tools.register(jsonTool({
    name: 'device_control',
    description: [
      'Control a device by capability action or by preset operation. Provide EITHER capability+action+input OR operation+params.',
      'Capability actions: strength.set {value 0-255}, strength.stop; shock.start {voltage 0-100}, shock.stop; vibration.set {value 0-100}, vibration.stop; suction.set {value 0-100}, suction.stop; lock.setOpen {open boolean}; reporting.setReportDelay {ms}; distance.configure {lowBand,highBand,reportDelayMs}; motors.set {channels:{name:{value 0-255,direction}}}, motors.stop; estim.set {intensity 0-255,channel}, estim.stop; pump.start {scene,ss}, pump.stop; attitude.startMagCalibration/endMagCalibration.',
      'Preset operations are device-type specific; list them with device_get. Every numeric input is automatically clamped to the configured percentage threshold (default 60% of the physical range); the result reports clamped fields. The backend agent lease clamps once more before the device write; backendFieldCaps in the result shows the final backend field caps. Do not retry with a higher value to bypass a clamp: that is the user-set safety limit.',
    ].join('\n'),
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device id from device_list.' },
      capability: { type: 'string', description: 'Capability key, e.g. strength, shock, vibration, suction, motors.' },
      action: { type: 'string', description: 'Action key inside the capability, e.g. set, start, stop, setOpen, configure.' },
      input: { type: 'object', additionalProperties: true, description: 'Capability action input object. Numeric fields are threshold-scaled.' },
      operation: { type: 'string', description: 'Preset operation key from device_get (alternative to capability+action).' },
      params: { type: 'object', additionalProperties: true, description: 'Preset operation params. Numeric fields are threshold-scaled.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const source = toolSource('device_control', exec)
      const scoped = client.forSession(sessionId)
      if (args.operation) {
        if (args.capability || args.action) throw new Error('use either operation or capability+action, not both')
        const device = await scoped.device(args.deviceId, { signal: exec.signal })
        const typeConfig = await scoped.deviceTypeConfig(device.type, { signal: exec.signal }).catch(() => null)
        const definition = (typeConfig?.operations || []).find((item) => item.key === args.operation)
        if (!definition) {
          const keys = (typeConfig?.operations || []).map((item) => item.key)
          throw new Error(`operation "${args.operation}" is not defined for device type ${device.type}; available: ${keys.join(', ') || 'none'}`)
        }
        const result = await safety.operate({
          sessionId, source, deviceId: args.deviceId, operation: args.operation,
          params: args.params || {}, definition, deviceType: device.type, signal: exec.signal,
        })
        if (result.translated) {
          return {
            ok: true, deviceId: args.deviceId, operation: args.operation,
            translated: true, actions: result.actions, results: result.results,
          }
        }
        const { _scaled, _mode, _backendFieldCaps, ...rest } = result
        return {
          ok: true, mode: _mode, deviceId: args.deviceId, operation: args.operation,
          appliedParams: _scaled.input, clamped: _scaled.clamped, unscaled: _scaled.unscaled,
          ...(_backendFieldCaps ? { backendFieldCaps: _backendFieldCaps } : {}),
          result: rest,
        }
      }
      if (!args.capability || !args.action) throw new Error('provide capability and action, or operation')
      const result = await safety.control({
        sessionId, source, deviceId: args.deviceId, capability: args.capability,
        action: args.action, input: args.input || {}, signal: exec.signal,
      })
      const { _scaled, _mode, _backendFieldCaps, ...rest } = result
      return {
        ok: true, mode: _mode, deviceId: args.deviceId,
        capability: args.capability, action: args.action,
        appliedInput: _scaled.input, clamped: _scaled.clamped,
        unscaled: _scaled.unscaled, thresholdPercent: _scaled.percent,
        ...(_backendFieldCaps ? { backendFieldCaps: _backendFieldCaps } : {}),
        result: rest,
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'device_manage',
    description: [
      'Manage devices and brand connections. Actions:',
      'rename (PATCH name), nickname (persist local nickname), set_connection (MQTT/BLE/serial/remote/brand transport), brand_status, brand_discover, brand_connect, brand_disconnect.',
      'Brand discovery/connect are local-only and return 423 REMOTE_LOCKED in remote-operator mode. Rename in remote-operator mode is forwarded to the controlled host.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['rename', 'nickname', 'set_connection', 'brand_status', 'brand_discover', 'brand_connect', 'brand_disconnect'],
        description: 'Management action.',
      },
      deviceId: { type: 'string', description: 'Target device id (rename, nickname, set_connection, brand_disconnect).' },
      name: { type: 'string', description: 'New name/nickname.' },
      connectionType: { type: 'string', enum: ['mqtt', 'serial', 'ble', 'remote', 'brand', 'brandBle'], description: 'Transport for set_connection.' },
      brand: { type: 'string', description: 'Brand key for discovery/connect, e.g. dglab, ycy.' },
      host: { type: 'string', description: 'Brand discovery host (optional).' },
      port: { type: 'integer', description: 'Brand discovery port (optional).' },
      mode: { type: 'string', description: 'Brand mode, e.g. bridge or ble.' },
      timeoutMs: { type: 'integer', description: 'Discovery timeout in ms.' },
      hosts: { type: 'array', items: { type: 'string' }, description: 'Multiple discovery hosts.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const source = toolSource('device_manage', exec)
      const scoped = client.forSession(sessionId)
      const runRaw = (method, path, body) => safety.raw({ sessionId, source, method, path, body, signal: exec.signal })
      switch (args.action) {
        case 'rename':
          requireArg(args.deviceId, 'deviceId'); requireArg(args.name, 'name')
          return runRaw('PATCH', `/devices/${encodeURIComponent(args.deviceId)}`, { name: args.name })
        case 'nickname':
          requireArg(args.deviceId, 'deviceId')
          return runRaw('POST', `/devices/${encodeURIComponent(args.deviceId)}/nickname`, { nickname: args.name ?? '' })
        case 'set_connection':
          requireArg(args.deviceId, 'deviceId'); requireArg(args.connectionType, 'connectionType')
          return runRaw('PUT', `/devices/${encodeURIComponent(args.deviceId)}/control-connection`, { type: args.connectionType })
        case 'brand_status':
          return scoped.brandsStatus({ signal: exec.signal })
        case 'brand_discover':
          requireArg(args.brand, 'brand')
          return scoped.brandsDiscover({
            brand: args.brand, host: args.host, port: args.port, mode: args.mode,
            timeoutMs: args.timeoutMs, hosts: args.hosts,
          }, { signal: exec.signal })
        case 'brand_connect':
          requireArg(args.brand, 'brand')
          return runRaw('POST', '/brands/connect', {
            brand: args.brand, host: args.host, port: args.port, mode: args.mode,
          })
        case 'brand_disconnect':
          requireArg(args.deviceId, 'deviceId')
          return runRaw('POST', `/brands/${encodeURIComponent(args.deviceId)}/disconnect`, {})
        default:
          throw new Error(`unknown action: ${args.action}`)
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'emergency_stop',
    description: 'Emergency stop. Always allowed and never asks for confirmation. In local/remote-controlled mode it stops every device (watchdog stop-all), the current game, the game runtime, all scripts and all event subscriptions; in remote-operator mode it calls the remote session emergency stop, stops the local game/runtime, scripts and subscriptions. The agent stop does not latch the plugin; if the user pressed the sidebar stop, controls stay refused (bilingual reason) until the user resumes in the panel. Use immediately if anything goes wrong.',
    parameters: {
      reason: { type: 'string', description: 'Short reason recorded in the audit log.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const source = toolSource('emergency_stop', exec)
      const reason = args.reason || 'agent emergency stop'
      safety.halt({ reason })
      const stoppedScripts = scripts.stopAll('emergency-stop', undefined, { explicit: false })
      events.dispose()
      watchdog.stop(sessionId)
      const stop = await safety.emergencyStop({
        sessionId, source, reason, signal: exec.signal, skipHalt: true,
      })
      return { ...stop, stoppedScripts, subscriptions: 'all cancelled' }
    },
  }))
}

function requireArg(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required for this action`)
}
