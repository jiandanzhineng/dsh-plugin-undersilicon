import { SafetyError } from '../util/errors.js'
import { extractApiRanges, mergeRanges } from './ranges.js'
import { scaleCapabilityInput, scaleOperationInput } from './scale.js'

/** Raw endpoints that would bypass the safety layer. Reads stay allowed. */
const DENY_RULES = [
  { methods: ['POST'], re: /^\/devices\/[^/]+\/message(?:\/|$)/, why: 'raw device messages bypass capability checks' },
  { methods: ['*'], re: /^\/devices\/batch(?:\/|$)/, why: 'batch device writes bypass per-field scaling' },
  { methods: ['*'], re: /^\/mqtt-client(?:\/|$)/, why: 'direct MQTT publishing bypasses device checks' },
  { methods: ['*'], re: /^\/serial(?:\/|$)/, why: 'serial access is local-only hardware control' },
  { methods: ['*'], re: /^\/wired-flash(?:\/|$)/, why: 'wired flashing is local-only hardware control' },
  { methods: ['*'], re: /^\/devices\/(?:firmware|[^/]+\/firmware)(?:\/|$)/, why: 'firmware operations are local-only hardware control' },
  { methods: ['POST'], re: /^\/mqtt\/(?:start|stop)$/, why: 'MQTT broker lifecycle is local-only' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/local-apps(?:\/|$)/, why: 'launching arbitrary local apps is outside the plugin contract' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/plugins(?:\/|$)/, why: 'plugin installation is outside the plugin contract' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/auth(?:\/|$)/, why: 'account writes are outside the plugin contract' },
  { methods: ['POST', 'DELETE'], re: /^\/models(?:\/|$)/, why: 'model downloads are outside the plugin contract' },
  { methods: ['DELETE'], re: /^\/devices\/all$/, why: 'clearing every device is destructive' },
  { methods: ['DELETE'], re: /^\/devices\/[^/]+$/, why: 'deleting a device is destructive' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], re: /^\/remote-session\/(?:create|join|authorize|revoke|kick|stop)$/, why: 'remote session lifecycle is user-owned' },
]

/** One request through the safety layer. */
export class SafetyLayer {
  constructor({ client, config, audit, watchdog, log = () => {}, clock = globalThis } = {}) {
    this.client = client
    this.config = config
    this.audit = audit
    this.watchdog = watchdog
    this.log = log
    this.clock = clock
    this.apiRanges = null
    this.rangesLoadedAt = 0
    this.mode = 'unknown'
    this.statusCheckedAt = 0
  }

  /** Refresh and cache the remote-session mode. */
  async refreshMode({ force = false, signal } = {}) {
    const now = Date.now()
    if (!force && this.mode !== 'unknown' && now - this.statusCheckedAt < 10000) return this.mode
    try {
      const status = await this.client.remoteStatus({ signal })
      this.mode = this.client.lastMode
      this.statusCheckedAt = now
      return this.mode
    } catch (error) {
      this.statusCheckedAt = now
      if (this.mode === 'unknown') this.mode = 'local'
      this.log('remote mode check failed', { error: error?.message })
      return this.mode
    }
  }

  async getMode(options) {
    return this.refreshMode(options)
  }

  /** Load capability ranges, preferring the backend's machine-readable data. */
  async getRanges({ force = false, signal } = {}) {
    const now = Date.now()
    if (!force && this.apiRanges && now - this.rangesLoadedAt < 60000) return this.apiRanges
    try {
      const payload = await this.client.deviceCapabilities({ signal })
      this.apiRanges = mergeRanges(extractApiRanges(payload))
      this.rangesLoadedAt = now
    } catch (error) {
      if (!this.apiRanges) this.apiRanges = mergeRanges({})
      this.log('capability ranges unavailable; using built-in fallback', { error: error?.message })
    }
    return this.apiRanges
  }

  /** Throw when a raw request targets a blocked endpoint. */
  assertRawAllowed(method, path) {
    const verb = String(method || 'GET').toUpperCase()
    const clean = normalizeApiPath(path)
    for (const rule of DENY_RULES) {
      if (!rule.methods.includes('*') && !rule.methods.includes(verb)) continue
      if (rule.re.test(clean)) {
        throw new SafetyError(`blocked ${verb} ${clean}: ${rule.why}`, 'ENDPOINT_BLOCKED', {
          method: verb, path: clean, reason: rule.why,
        })
      }
      // fall through to the next rule
    }
    return clean
  }

  /** Whether a route counts as device control for watchdog purposes. */
  isDeviceControl(method, path) {
    const verb = String(method || 'GET').toUpperCase()
    const clean = normalizeApiPath(path)
    if (verb === 'GET') return false
    return /^\/devices\/[^/]+\/capabilities\/[^/]+\/actions\/[^/]+$/.test(clean)
      || /^\/devices\/[^/]+\/operations\/[^/]+$/.test(clean)
      || /^\/devices\/[^/]+\/nickname$/.test(clean)
      || /^\/games\/[^/]+\/start$/.test(clean)
      || /^\/game-runtime\/(?:start|params|action)$/.test(clean)
      || /^\/client\/games\/[^/]+\/launch$/.test(clean)
  }

  async maybeTouchWatchdog(sessionId, { source, path } = {}) {
    if (!sessionId) return undefined
    const mode = await this.getMode()
    if (mode === 'remote-operator') return { ok: false, disabled: true, reason: 'remote-operator' }
    const result = await this.watchdog.touch(sessionId, { reason: `${source?.kind || 'control'}:${path || ''}` })
    return result
  }

  /** Scale, execute and audit one capability action. */
  async control({ sessionId, source, deviceId, capability, action, input, signal }) {
    const ranges = await this.getRanges({ signal })
    const scaled = scaleCapabilityInput({ capability, action, input, limits: this.config.limits, ranges })
    const started = Date.now()
    let outcome
    try {
      const result = await this.client.control(deviceId, capability, action, scaled.input, { signal })
      outcome = { ok: true, status: 200, result }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      await this.maybeTouchWatchdog(sessionId, { source, path: `capabilities/${capability}/${action}` })
      this.audit.record({
        sessionId, source, action: 'device.control',
        request: { deviceId, capability, action, input: scaled.input, requested: input },
        scaling: { clamped: scaled.clamped, unscaled: scaled.unscaled },
        result: outcome, durationMs: Date.now() - started,
      })
    }
    return { ...outcome.result, _scaled: scaled, _mode: await this.getMode() }
  }

  /** Scale, execute and audit one preset operation. */
  async operate({ sessionId, source, deviceId, operation, params, definition, signal }) {
    const ranges = await this.getRanges({ signal })
    // Merge the operation's declared defaults so a dangerous default cannot bypass scaling.
    const merged = { ...(definition?.input || {}), ...(params || {}) }
    const scaled = scaleOperationInput({
      operation: definition || { key: operation }, input: merged, limits: this.config.limits, ranges,
    })
    const started = Date.now()
    let outcome
    try {
      const result = await this.client.operate(deviceId, operation, scaled.input, { signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled, _mode: await this.getMode() }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      await this.maybeTouchWatchdog(sessionId, { source, path: `operations/${operation}` })
      this.audit.record({
        sessionId, source, action: 'device.operation',
        request: { deviceId, operation, params: scaled.input, requested: params },
        scaling: { clamped: scaled.clamped, unscaled: scaled.unscaled },
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  /** Raw request gate used by panel_api and script `us.api`. */
  async raw({ sessionId, source, method, path, body, query, signal }) {
    const clean = this.assertRawAllowed(method, path)
    let effectiveBody = body
    let scaling
    const capMatch = /^\/devices\/([^/]+)\/capabilities\/([^/]+)\/actions\/([^/]+)$/.exec(clean)
    if (capMatch && body && typeof body === 'object') {
      const ranges = await this.getRanges({ signal })
      const rawInput = body.input ?? body.params ?? body
      scaling = scaleCapabilityInput({
        capability: decodeURIComponent(capMatch[2]), action: decodeURIComponent(capMatch[3]),
        input: rawInput, limits: this.config.limits, ranges,
      })
      effectiveBody = body.input !== undefined ? { ...body, input: scaling.input }
        : body.params !== undefined ? { ...body, params: scaling.input } : scaling.input
    } else {
      const opMatch = /^\/devices\/([^/]+)\/operations\/([^/]+)$/.exec(clean)
      if (opMatch && body && typeof body === 'object') {
        const ranges = await this.getRanges({ signal })
        scaling = scaleOperationInput({
          operation: { key: decodeURIComponent(opMatch[2]) },
          input: body.params ?? body, limits: this.config.limits, ranges,
        })
        effectiveBody = body.params !== undefined ? { ...body, params: scaling.input } : scaling.input
      }
    }
    const started = Date.now()
    let outcome
    try {
      const result = await this.client.request(String(method).toUpperCase(), clean, {
        body: effectiveBody, query, signal,
      })
      outcome = { ok: true, status: 200 }
      return scaling ? { ...result, _scaled: scaling } : result
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      const verb = String(method).toUpperCase()
      if (verb !== 'GET' && verb !== 'HEAD') {
        if (this.isDeviceControl(verb, clean)) await this.maybeTouchWatchdog(sessionId, { source, path: clean })
        this.audit.record({
          sessionId: source, action: 'api.request', method: verb, path: clean,
          request: { body: effectiveBody, query }, scaling: scaling ? { clamped: scaling.clamped, unscaled: scaling.unscaled } : undefined,
          result: outcome, durationMs: Date.now() - started,
        })
      }
    }
  }

  /** Emergency stop: always allowed, mode-aware and never dependent on prior state. */
  async emergencyStop({ sessionId, source, reason = 'agent-emergency-stop', signal } = {}) {
    const started = Date.now()
    const mode = await this.refreshMode({ force: true, signal })
    const results = []
    const run = async (name, fn) => {
      try {
        results.push({ name, ok: true, result: await fn() })
      } catch (error) {
        results.push({ name, ok: false, status: error?.status || 0, code: error?.code, message: error?.message })
      }
    }
    if (mode === 'remote-operator') {
      await run('remote-session/emergency-stop', () => this.client.emergencyStopRemote({ signal }))
    } else {
      const clientId = `dsh-${String(sessionId || 'session').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80)}`
      await run('device-watchdog/stop-all', () => this.client.stopAll(clientId, reason, { signal }))
      await run('games/stop-current', () => this.client.stopCurrentGame({ signal }))
      await run('game-runtime/stop', () => this.client.gameRuntimeStop(reason, { signal }))
      if (results[0]?.status === 423) {
        await run('remote-session/emergency-stop', () => this.client.emergencyStopRemote({ signal }))
      }
    }
    this.audit.record({
      sessionId, source, action: 'emergency.stop', reason, mode,
      result: { ok: results.some((item) => item.ok), results }, durationMs: Date.now() - started,
    })
    return { mode, results, ok: results.some((item) => item.ok) }
  }
}

/** Normalize an API path to the form rules match: no `/api` prefix, leading slash. */
export function normalizeApiPath(path) {
  let clean = String(path || '/').split('?')[0].split('#')[0]
  clean = clean.replace(/^https?:\/\/[^/]+/i, '')
  if (clean === '/api') return '/'
  if (clean.startsWith('/api/')) clean = clean.slice(4)
  if (!clean.startsWith('/')) clean = `/${clean}`
  return clean.replace(/\/{2,}/g, '/')
}
