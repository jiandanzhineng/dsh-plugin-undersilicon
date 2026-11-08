import { SafetyError } from '../util/errors.js'
import { extractApiRanges, mergeRanges } from './ranges.js'
import { scaleCapabilityInput, scaleOperationInput } from './scale.js'
import { normalizeRequestPath, queryObject } from '../util/paths.js'
import {
  assertConnectionBody, assertNicknameBody, assertPatchBody, classifyRawWrite,
} from './whitelist.js'
import { resolveOperation } from './operations.js'
import { gameSchemaMap, scaleGameParameters } from './games.js'
import { watchdogClientId } from './watchdog.js'

const ALLOWED_ACTIONS = {
  strength: new Set(['set', 'stop']),
  shock: new Set(['start', 'stop']),
  vibration: new Set(['set', 'stop']),
  suction: new Set(['set', 'stop']),
  estim: new Set(['set', 'stop']),
  motors: new Set(['set', 'stop']),
  pump: new Set(['start', 'stop']),
  lock: new Set(['setopen']),
  reporting: new Set(['setreportdelay']),
  distance: new Set(['configure']),
  attitude: new Set(['startmagcalibration', 'endmagcalibration']),
}

const STOP_KINDS = new Set(['remote-emergency', 'stop-all'])
const SETTLE_MS = 2000
const GAME_SCHEMA_TTL_MS = 30000

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SafetyError('request body must be a JSON object', 'INVALID_BODY')
  }
  return body
}

function pathParts(sendPath) {
  return sendPath.split('/').filter(Boolean).map((item) => decodeURIComponent(item))
}

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
    this.haltEpoch = 0
    this.haltedAt = null
    this.latch = null
    this.inFlight = new Set()
    this.gameSchemas = new Map()
    this.gameSchemasAt = 0
  }

  get limits() {
    return this.config?.limits || {}
  }

  /** Refresh and cache the remote-session mode. */
  async refreshMode({ force = false, signal } = {}) {
    const now = Date.now()
    if (!force && this.mode !== 'unknown' && now - this.statusCheckedAt < 10000) return this.mode
    try {
      await this.client.remoteStatus({ signal })
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

  /** Backwards-compatible raw gate used by tests and external callers. */
  assertRawAllowed(method, path) {
    const normalized = normalizeRequestPath(path, { baseUrl: this.client?.baseUrl })
    classifyRawWrite(method, normalized.matchPath)
    return normalized.matchPath
  }

  /** Backwards-compatible helper: renew one lease unless remote mode owns it. */
  async maybeTouchWatchdog(sessionId, { source, path } = {}) {
    if (!sessionId) return undefined
    if (!this.watchdog) return { ok: true, disabled: true }
    const mode = await this.getMode()
    if (mode === 'remote-operator') return { ok: false, disabled: true, reason: 'remote-operator' }
    return this.watchdog.touch(sessionId, { reason: `${source?.kind || 'control'}:${path || ''}` })
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

  // ---------- emergency epoch / latch ----------

  captureEpoch() {
    return this.haltEpoch
  }

  assertEpoch(epoch) {
    if (epoch !== this.haltEpoch) {
      throw new SafetyError('command superseded by an emergency stop; it was not sent', 'EMERGENCY_STOP', {
        capturedEpoch: epoch, haltEpoch: this.haltEpoch,
      })
    }
  }

  assertActive() {
    if (this.latch) {
      throw new SafetyError(
        'the user pressed the sidebar emergency stop and the plugin is latched; ' +
        'ask the user to click "resume" in the sidebar before any control can be sent',
        'EMERGENCY_LATCHED',
        { latchedAt: this.latch.at, reason: this.latch.reason },
      )
    }
  }

  emergencyState() {
    return {
      latched: Boolean(this.latch),
      latchedAt: this.latch?.at ?? null,
      reason: this.latch?.reason ?? null,
      epoch: this.haltEpoch,
      haltedAt: this.haltedAt,
      inFlight: this.inFlight.size,
    }
  }

  /** Invalidate in-flight commands, optionally latch the plugin off. */
  halt({ reason = 'emergency-stop', latch = false } = {}) {
    this.haltEpoch += 1
    this.haltedAt = new Date().toISOString()
    if (latch) this.latch = { at: this.haltedAt, reason }
    const error = new SafetyError('emergency stop: in-flight command aborted', 'EMERGENCY_STOP', { epoch: this.haltEpoch })
    for (const entry of this.inFlight) {
      try { entry.controller.abort(error) } catch { /* already aborted */ }
    }
    return this.haltEpoch
  }

  /** Only the authenticated panel calls this. There is intentionally no tool. */
  resume({ sessionId, source } = {}) {
    const before = this.emergencyState()
    this.latch = null
    this.audit?.record({ sessionId, source, action: 'emergency.resume', result: { ok: true, before } })
    return this.emergencyState()
  }

  begin({ sessionId, source, signal, epoch, allowLatched = false } = {}) {
    if (!allowLatched) this.assertActive()
    const captured = epoch ?? this.captureEpoch()
    this.assertEpoch(captured)
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const entry = { controller, epoch: captured, sessionId, source }
    this.inFlight.add(entry)
    return {
      epoch: captured,
      signal: controller.signal,
      finish: () => {
        this.inFlight.delete(entry)
        if (signal) signal.removeEventListener('abort', forward)
      },
    }
  }

  async waitInFlight(maxMs = SETTLE_MS) {
    const started = Date.now()
    while (this.inFlight.size > 0 && Date.now() - started < maxMs) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 20)
        timer.unref?.()
      })
    }
  }

  /** Renew the lease before a control command; refuse when the lease is down. */
  async ensureWatchdog(sessionId, { signal, epoch, reason = 'agent-control' } = {}) {
    if (!sessionId || !this.watchdog) return { ok: true, disabled: true }
    if (epoch !== undefined) this.assertEpoch(epoch)
    const mode = await this.getMode({ signal })
    if (mode === 'remote-operator') return { ok: true, disabled: true, reason: 'remote-operator' }
    if (epoch !== undefined) this.assertEpoch(epoch)
    const result = await this.watchdog.touch(sessionId, { reason, signal })
    if (result?.ok) return result
    if (result?.disabled || result?.status === 423 || result?.code === 'REMOTE_LOCKED') {
      return { ...result, disabled: true }
    }
    throw new SafetyError(
      `device watchdog lease is unavailable, refusing to send a control command: ${result?.error || result?.code || 'unknown error'}`,
      'WATCHDOG_UNAVAILABLE', result || {},
    )
  }

  // ---------- device control ----------

  async control({ sessionId, source, deviceId, capability, action, input, signal, epoch }) {
    const scope = this.begin({ sessionId, source, signal, epoch })
    const started = Date.now()
    let outcome
    let scaled
    try {
      const ranges = await this.getRanges({ signal: scope.signal })
      scaled = scaleCapabilityInput({
        capability, action, input, limits: this.limits, ranges,
      })
      this.assertEpoch(scope.epoch)
      this.assertActive()
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: `control:${capability}.${action}` })
      this.assertEpoch(scope.epoch)
      this.assertActive()
      const result = await this.client.control(deviceId, capability, action, scaled.input, { signal: scope.signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled, _mode: await this.getMode() }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: 'device.control',
        request: { deviceId, capability, action, input: scaled?.input, requested: input },
        scaling: scaled ? { clamped: scaled.clamped, unscaled: scaled.unscaled } : undefined,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async getDeviceDefinition(deviceId, operation, signal) {
    const device = await this.client.device(deviceId, { signal })
    const typeConfig = await this.client.deviceTypeConfig(device.type, { signal })
    const definition = (typeConfig?.operations || []).find((item) => item.key === operation)
    return { device, definition }
  }

  async executeOperation({
    sessionId, source, deviceId, operation, params, definition, deviceType, signal, epoch, auditAction = 'device.operation',
  }) {
    const policy = resolveOperation({ deviceType, operationKey: operation, definition, params })
    const captured = epoch ?? this.captureEpoch()
    if (policy.mode === 'translate') {
      const started = Date.now()
      const results = []
      try {
        for (const item of policy.actions) {
          const result = await this.control({
            sessionId, source, deviceId, capability: item.capability,
            action: item.action, input: item.input, signal, epoch: captured,
          })
          results.push({ capability: item.capability, action: item.action, result })
        }
        return {
          ok: true, translated: true, actions: results.map((item) => `${item.capability}.${item.action}`),
          results, _mode: await this.getMode(),
        }
      } finally {
        this.audit.record({
          sessionId, source, action: auditAction, method: 'POST',
          request: { deviceId, operation, params, translated: policy.actions },
          result: { ok: results.length === policy.actions.length }, durationMs: Date.now() - started,
        })
      }
    }
    const scope = this.begin({ sessionId, source, signal, epoch: captured })
    const started = Date.now()
    let outcome
    let scaled
    try {
      const merged = policy.mode === 'mapped' && !policy.fixedInput
        ? { ...(definition?.input || {}), ...(params || {}) }
        : { ...(definition?.input || {}) }
      if (policy.mode === 'invoke-safe') {
        scaled = { input: {}, clamped: [], unscaled: [] }
      } else {
        const ranges = await this.getRanges({ signal: scope.signal })
        scaled = scaleOperationInput({
          operation: definition || { key: operation }, input: merged, limits: this.limits, ranges,
        })
      }
      this.assertEpoch(scope.epoch)
      this.assertActive()
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: `operation:${operation}` })
      this.assertEpoch(scope.epoch)
      const result = await this.client.operate(deviceId, operation, scaled.input, { signal: scope.signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled, _mode: await this.getMode() }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: auditAction, method: 'POST',
        request: { deviceId, operation, params: scaled?.input, requested: params },
        scaling: scaled ? { clamped: scaled.clamped, unscaled: scaled.unscaled } : undefined,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async operate({ sessionId, source, deviceId, operation, params, definition, deviceType, signal }) {
    return this.executeOperation({
      sessionId, source, deviceId, operation, params, definition, deviceType, signal,
    })
  }

  // ---------- raw requests ----------

  async raw({ sessionId, source, method, path, body, query, signal }) {
    const normalized = normalizeRequestPath(path, { baseUrl: this.client.baseUrl })
    const info = classifyRawWrite(method, normalized.matchPath)
    const verb = String(method || 'GET').toUpperCase()
    const mergedQuery = { ...normalized.query, ...queryObject(new URLSearchParams(), query) }
    if (info.kind === 'read') {
      return this.client.request(verb, normalized.sendPath, { body, query: mergedQuery, signal })
    }
    if (info.kind === 'remote-emergency') {
      return this.emergencyStop({ sessionId, source, reason: 'raw remote emergency stop', signal })
    }
    if (info.kind === 'stop-all') {
      const payload = body === undefined ? {} : bodyObject(body)
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : 'dsh-raw'
      return this.auditedRequest({
        sessionId, source, verb, path: normalized.sendPath,
        body: { clientId, reason: payload.reason }, query: mergedQuery, signal, allowLatched: true,
      })
    }
    const parts = pathParts(normalized.sendPath)
    if (info.kind === 'capability') return this.rawCapability({ sessionId, source, parts, body, query: mergedQuery, signal })
    if (info.kind === 'operation') return this.rawOperation({ sessionId, source, parts, body, query: mergedQuery, signal })
    if (info.kind === 'device-patch') {
      const patch = assertPatchBody(body)
      return this.auditedRequest({ sessionId, source, verb: 'PATCH', path: normalized.sendPath, body: patch, query: mergedQuery, signal })
    }
    if (info.kind === 'nickname') {
      return this.auditedRequest({ sessionId, source, verb: 'POST', path: normalized.sendPath, body: assertNicknameBody(body), query: mergedQuery, signal })
    }
    if (info.kind === 'connection') {
      return this.auditedRequest({ sessionId, source, verb: 'PUT', path: normalized.sendPath, body: assertConnectionBody(body), query: mergedQuery, signal })
    }
    if (info.kind === 'client') return this.rawClient({ sessionId, source, parts, body, query: mergedQuery, signal })
    if (info.kind === 'game-start') return this.rawGameStart({ sessionId, source, parts, body, signal })
    if (info.kind === 'game-runtime-start') return this.rawGameRuntimeStart({ sessionId, source, body, signal })
    if (info.kind === 'game-runtime-params') {
      const payload = bodyObject(body)
      assertKeys(payload, ['params', 'parameters'])
      return this.gameParams({
        sessionId, source, params: payload.params ?? payload.parameters ?? {}, signal, auditAction: 'api.request',
      })
    }
    if (info.kind === 'game-runtime-action') {
      const payload = bodyObject(body)
      assertKeys(payload, ['action', 'payload'])
      return this.gameAction({
        sessionId, source, action: String(payload.action || ''), payload: payload.payload || {}, signal, auditAction: 'api.request',
      })
    }
    if (info.kind === 'game-stop') {
      const payload = body === undefined ? {} : bodyObject(body)
      assertKeys(payload, ['reason'])
      return this.gameStop({ sessionId, source, reason: payload.reason, signal, auditAction: 'api.request' })
    }
    if (info.kind === 'brand-connect') {
      const payload = bodyObject(body)
      assertKeys(payload, ['brand', 'host', 'port', 'mode'])
      if (typeof payload.brand !== 'string' || !payload.brand) throw new SafetyError('brand is required', 'INVALID_BODY')
      return this.auditedRequest({ sessionId, source, verb: 'POST', path: normalized.sendPath, body: payload, query: mergedQuery, signal })
    }
    if (info.kind === 'brand-disconnect') {
      return this.auditedRequest({ sessionId, source, verb: 'POST', path: normalized.sendPath, body: {}, query: mergedQuery, signal })
    }
    throw new SafetyError(`unhandled whitelisted write kind: ${info.kind}`, 'ENDPOINT_BLOCKED')
  }

  rawGameStart({ sessionId, source, parts, body, signal }) {
    const payload = body === undefined ? {} : bodyObject(body)
    assertKeys(payload, ['deviceMapping', 'deviceMap', 'parameters', 'params', 'defer', 'show'])
    return this.gameStart({
      sessionId, source, gameId: parts[1],
      deviceMapping: payload.deviceMapping ?? payload.deviceMap,
      parameters: payload.parameters ?? payload.params ?? {}, launch: true, show: payload.show,
      signal, auditAction: 'api.request',
    })
  }

  rawGameRuntimeStart({ sessionId, source, body, signal }) {
    const payload = bodyObject(body)
    assertKeys(payload, ['gameId', 'deviceMap', 'deviceMapping', 'params', 'parameters', 'show'])
    return this.gameStart({
      sessionId, source, gameId: String(payload.gameId || ''),
      deviceMapping: payload.deviceMap ?? payload.deviceMapping,
      parameters: payload.params ?? payload.parameters ?? {}, launch: false, show: payload.show,
      signal, auditAction: 'api.request',
    })
  }

  async rawCapability({ sessionId, source, parts, body, query, signal }) {
    const payload = body === undefined ? {} : bodyObject(body)
    const hasInput = Object.prototype.hasOwnProperty.call(payload, 'input')
    const hasParams = Object.prototype.hasOwnProperty.call(payload, 'params')
    if (hasInput && hasParams) throw ambiguousBody()
    const rawInput = hasInput ? payload.input : hasParams ? payload.params : payload
    const capability = parts[3].toLowerCase()
    const action = parts[5].toLowerCase()
    if (!ALLOWED_ACTIONS[capability]?.has(action)) {
      throw new SafetyError(
        `capability action ${parts[3]}.${parts[5]} is not on the agent whitelist; use device_get to inspect supported actions`,
        'UNKNOWN_CAPABILITY_ACTION', { capability: parts[3], action: parts[5] },
      )
    }
    const scope = this.begin({ sessionId, source, signal })
    const started = Date.now()
    let outcome
    let scaled
    try {
      const ranges = await this.getRanges({ signal: scope.signal })
      scaled = scaleCapabilityInput({ capability, action, input: rawInput, limits: this.limits, ranges })
      this.assertEpoch(scope.epoch)
      this.assertActive()
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: 'raw-capability' })
      this.assertEpoch(scope.epoch)
      const sendPath = `/${parts.map(encodeURIComponent).join('/')}`
      const result = await this.client.request('POST', sendPath, {
        body: { input: scaled.input }, query, signal: scope.signal,
      })
      outcome = { ok: true, status: 200 }
      return { ...result, _scaled: scaled }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: 'api.request', method: 'POST',
        path: `/${parts.map(encodeURIComponent).join('/')}`,
        request: { body: { input: scaled?.input } },
        scaling: scaled ? { clamped: scaled.clamped, unscaled: scaled.unscaled } : undefined,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async rawOperation({ sessionId, source, parts, body, query, signal }) {
    const payload = body === undefined ? {} : bodyObject(body)
    if (Object.prototype.hasOwnProperty.call(payload, 'input')) throw ambiguousBody()
    const params = Object.prototype.hasOwnProperty.call(payload, 'params') ? payload.params : payload
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new SafetyError('operation params must be a JSON object', 'INVALID_BODY')
    }
    const deviceId = parts[1]
    const operation = parts[3]
    const epoch = this.captureEpoch()
    const { device, definition } = await this.getDeviceDefinition(deviceId, operation, signal)
    return this.executeOperation({
      sessionId, source, deviceId, operation, params, definition,
      deviceType: device.type, signal, epoch, auditAction: 'api.request',
    })
  }

  async rawClient({ sessionId, source, parts, body, query, signal }) {
    const payload = body === undefined ? {} : bodyObject(body)
    if (parts[1] === 'games' && parts[3] === 'launch') {
      assertKeys(payload, ['deviceMap', 'deviceMapping', 'parameters', 'params', 'show'])
      return this.gameStart({
        sessionId, source, gameId: parts[2],
        deviceMapping: payload.deviceMap ?? payload.deviceMapping,
        parameters: payload.parameters ?? payload.params ?? {}, launch: true, show: payload.show,
        signal, auditAction: 'api.request',
      })
    }
    if (parts[1] === 'window') {
      assertKeys(payload, ['action'])
      if (!['show', 'hide', 'focus', 'minimize', 'maximize', 'restore'].includes(payload.action)) {
        throw new SafetyError('window action must be show/hide/focus/minimize/maximize/restore', 'INVALID_BODY')
      }
    }
    if (parts[1] === 'navigate') {
      assertKeys(payload, ['path', 'show'])
      if (typeof payload.path !== 'string' || payload.path.length > 500) {
        throw new SafetyError('navigate path is required', 'INVALID_BODY')
      }
    }
    if (parts[1] === 'screenshot') {
      assertKeys(payload, ['format', 'maxWidth'])
      payload.maxWidth = Math.max(64, Math.min(4096, Number(payload.maxWidth) || 1280))
    }
    return this.auditedRequest({
      sessionId, source, verb: 'POST',
      path: `/${parts.map(encodeURIComponent).join('/')}`, body: payload, query, signal,
    })
  }

  async auditedRequest({ sessionId, source, verb, path, body, query, signal, allowLatched = false }) {
    const scope = this.begin({ sessionId, source, signal, allowLatched })
    const started = Date.now()
    let outcome
    try {
      this.assertEpoch(scope.epoch)
      if (!allowLatched) this.assertActive()
      const result = await this.client.request(verb, path, { body, query, signal: scope.signal })
      outcome = { ok: true, status: 200 }
      return result
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: 'api.request', method: verb, path,
        request: { body, query }, result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  // ---------- games ----------

  async getGameSchemas({ force = false, signal } = {}) {
    const now = Date.now()
    if (!force && this.gameSchemas.size > 0 && now - this.gameSchemasAt < GAME_SCHEMA_TTL_MS) return this.gameSchemas
    try {
      const [games, hostGames] = await Promise.all([
        this.client.games({ signal }),
        this.client.request('GET', '/game-runtime/games', { signal }).catch(() => []),
      ])
      this.gameSchemas = gameSchemaMap(games, hostGames)
      this.gameSchemasAt = now
    } catch (error) {
      this.log('game schema unavailable', { error: error?.message })
    }
    return this.gameSchemas
  }

  async scaleGameParameters(gameId, parameters, signal) {
    const schemas = await this.getGameSchemas({ signal })
    const ranges = await this.getRanges({ signal })
    return scaleGameParameters({
      gameId, parameters, schema: schemas.get(String(gameId)), limits: this.limits, ranges,
    })
  }

  async gameStart({
    sessionId, source, gameId, deviceMapping, parameters, launch = false, show = true,
    signal, auditAction = 'game.start',
  }) {
    const scope = this.begin({ sessionId, source, signal })
    const started = Date.now()
    let outcome
    let scaled
    try {
      if (!gameId) throw new SafetyError('gameId is required', 'INVALID_GAME')
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: 'game-start' })
      this.assertEpoch(scope.epoch)
      this.assertActive()
      scaled = await this.scaleGameParameters(gameId, parameters || {}, scope.signal)
      this.assertEpoch(scope.epoch)
      const result = launch
        ? await this.client.launchClientGame(gameId, {
          deviceMap: deviceMapping, parameters: scaled.parameters, show: show !== false,
        }, { signal: scope.signal })
        : await this.client.startGame(gameId, {
          deviceMapping, parameters: scaled.parameters,
        }, { signal: scope.signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: auditAction, method: 'POST',
        request: { gameId, deviceMapping, parameters: scaled?.parameters, requested: parameters },
        scaling: scaled ? { clamped: scaled.clamped, scaledFields: scaled.scaledFields } : undefined,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async gameParams({ sessionId, source, params, gameId, signal, auditAction = 'game.params' }) {
    const scope = this.begin({ sessionId, source, signal })
    const started = Date.now()
    let outcome
    let scaled
    try {
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: 'game-params' })
      const id = gameId || await this.currentGameId(scope.signal)
      scaled = await this.scaleGameParameters(id, params || {}, scope.signal)
      this.assertEpoch(scope.epoch)
      const result = await this.client.gameRuntimeParams(scaled.parameters, { signal: scope.signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: auditAction, method: 'POST', gameId,
        request: { params: scaled?.parameters, requested: params },
        scaling: scaled ? { clamped: scaled.clamped, scaledFields: scaled.scaledFields } : undefined,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async gameAction({ sessionId, source, action, payload, gameId, signal, auditAction = 'game.action' }) {
    const scope = this.begin({ sessionId, source, signal })
    const started = Date.now()
    let outcome
    let scaled
    try {
      if (!action) throw new SafetyError('game action is required', 'INVALID_GAME_ACTION')
      await this.ensureWatchdog(sessionId, { signal: scope.signal, epoch: scope.epoch, reason: 'game-action' })
      const id = gameId || await this.currentGameId(scope.signal)
      scaled = await this.scaleGameParameters(id, payload || {}, scope.signal)
      this.assertEpoch(scope.epoch)
      const result = await this.client.gameRuntimeAction(action, scaled.parameters, { signal: scope.signal })
      outcome = { ok: true, status: 200, result }
      return { ...result, _scaled: scaled }
    } catch (error) {
      outcome = { ok: false, status: error?.status || 0, code: error?.code, message: error?.message }
      throw error
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: auditAction, method: 'POST', gameId,
        request: { action, payload: scaled?.parameters }, result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  async currentGameId(signal) {
    try {
      const status = await this.client.gameRuntimeStatus({ signal })
      return status?.gameId || status?.snapshot?.gameId || ''
    } catch {
      return ''
    }
  }

  async gameStop({ sessionId, source, reason, signal, auditAction = 'game.stop' }) {
    const scope = this.begin({ sessionId, source, signal, allowLatched: true })
    const started = Date.now()
    let outcome
    try {
      const [current, runtime] = await Promise.allSettled([
        this.client.stopCurrentGame({ signal: scope.signal }),
        this.client.gameRuntimeStop(reason || 'agent-stop', { signal: scope.signal }),
      ])
      outcome = {
        ok: current.status === 'fulfilled' || runtime.status === 'fulfilled',
        current: current.status === 'fulfilled' ? current.value : current.reason?.message,
        runtime: runtime.status === 'fulfilled' ? runtime.value : runtime.reason?.message,
      }
      return outcome
    } finally {
      scope.finish()
      this.audit.record({
        sessionId, source, action: auditAction, method: 'POST', reason,
        result: outcome, durationMs: Date.now() - started,
      })
    }
  }

  // ---------- emergency stop ----------

  async emergencyStop({ sessionId, source, reason = 'agent-emergency-stop', signal, skipHalt = false } = {}) {
    if (!skipHalt) this.halt({ reason })
    await this.waitInFlight(SETTLE_MS)
    const started = Date.now()
    const mode = await this.refreshMode({ force: true })
    const results = []
    const run = async (name, fn, { required = true, benign = [] } = {}) => {
      let lastError
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const result = await fn()
          results.push({ name, ok: true, required, attempts: attempt, result })
          return true
        } catch (error) {
          lastError = error
          if (benign.includes(error?.status) || benign.includes(error?.code)) {
            results.push({ name, ok: true, required, attempts: attempt, benign: true, status: error?.status, code: error?.code })
            return true
          }
          if (attempt < 3) {
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 150 * attempt)
              timer.unref?.()
            })
          }
        }
      }
      results.push({
        name, ok: false, required, attempts: 3,
        status: lastError?.status || 0, code: lastError?.code, message: lastError?.message,
      })
      return false
    }
    let stopAllRemote = false
    if (mode === 'remote-operator') {
      await run('remote-session/emergency-stop', () => this.client.emergencyStopRemote({ signal }))
    } else {
      const clientId = watchdogClientId(sessionId)
      const stopped = await run('device-watchdog/stop-all', () => this.client.stopAll(clientId, reason, { signal }))
      if (!stopped) {
        const last = results[results.length - 1]
        if (last?.status === 423 || last?.code === 'REMOTE_LOCKED') stopAllRemote = true
      }
    }
    if (stopAllRemote) {
      await run('remote-session/emergency-stop', () => this.client.emergencyStopRemote({ signal }))
    }
    await run('games/stop-current', () => this.client.stopCurrentGame({ signal }), { benign: [404, 409] })
    await run('game-runtime/stop', () => this.client.gameRuntimeStop(reason, { signal }), { benign: [404, 409] })
    const ok = results.every((item) => item.ok)
    this.audit.record({
      sessionId, source, action: 'emergency.stop', reason, mode,
      result: { ok, results }, durationMs: Date.now() - started,
    })
    return { mode, results, ok, latch: this.emergencyState() }
  }
}

/** Convert an API path to the legacy normalized form used by tests. */
export function normalizeApiPath(path) {
  return normalizeRequestPath(path).matchPath
}

function ambiguousBody() {
  return new SafetyError(
    'send either "input" or "params" in a capability body, never both (the backend would prefer the unscaled one)',
    'AMBIGUOUS_BODY',
  )
}

function assertKeys(object, allowed) {
  const extra = Object.keys(object).filter((key) => !allowed.includes(key))
  if (extra.length > 0) {
    throw new SafetyError(`refused fields: ${extra.join(', ')}; allowed: ${allowed.join(', ')}`, 'UNSAFE_BODY', { refused: extra })
  }
}
