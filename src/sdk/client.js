import { PanelHttp } from '../util/http.js'
import { UsApiError } from '../util/errors.js'

/** Classify the control-panel session into the modes the safety layer cares about. */
export function classifyMode(status) {
  if (!status || status.active !== true) return 'local'
  const projectionRoom = status.links?.projection?.roomId
  if (status.role === 'operator' && status.authorized === true && projectionRoom) return 'remote-operator'
  if (status.role === 'owner' && status.authorized === true) return 'remote-controlled'
  return 'local'
}

/** True when device/watchdog routes are expected to answer 423 REMOTE_LOCKED. */
export function isRemoteOperatorMode(status) {
  return classifyMode(status) === 'remote-operator'
}

/**
 * Typed facade over the control-panel HTTP API.
 * Endpoint contracts live in the main repo; this class adds no policy.
 */
export class ControlPanelClient {
  constructor({ baseUrl, fetchImpl, timeoutMs } = {}) {
    this.http = new PanelHttp({ baseUrl, fetchImpl, timeoutMs })
    this.lastMode = 'unknown'
    this.lastStatus = null
  }

  get baseUrl() {
    return this.http.baseUrl
  }

  request(method, path, options) {
    return this.http.request(method, path, options)
  }

  raw(method, path, options) {
    return this.http.request(method, path, options)
  }

  async remoteStatus({ signal } = {}) {
    const status = await this.request('GET', '/remote-session/status', { signal })
    this.lastStatus = status
    this.lastMode = classifyMode(status)
    return status
  }

  async mode({ signal, refresh = false } = {}) {
    if (!refresh && this.lastStatus) return this.lastMode
    await this.remoteStatus({ signal })
    return this.lastMode
  }

  async devices({ signal } = {}) {
    return this.request('GET', '/devices', { signal })
  }

  async device(id, { signal } = {}) {
    return this.request('GET', `/devices/${encodeURIComponent(id)}`, { signal })
  }

  async monitorData(id, { signal } = {}) {
    return this.request('GET', `/devices/${encodeURIComponent(id)}/monitor-data`, { signal })
  }

  async deviceTypeConfig(type, { signal } = {}) {
    return this.request('GET', `/device-types/${encodeURIComponent(type)}/config`, { signal })
  }

  async deviceCapabilities({ signal } = {}) {
    return this.request('GET', '/device-capabilities', { signal })
  }

  async control(deviceId, capability, action, input, { signal } = {}) {
    return this.request('POST',
      `/devices/${encodeURIComponent(deviceId)}/capabilities/${encodeURIComponent(capability)}/actions/${encodeURIComponent(action)}`,
      { body: { input: input || {} }, signal })
  }

  async operate(deviceId, operation, params, { signal } = {}) {
    return this.request('POST', `/devices/${encodeURIComponent(deviceId)}/operations/${encodeURIComponent(operation)}`, {
      body: { params: params || {} }, signal,
    })
  }

  async updateDevice(deviceId, patch, { signal } = {}) {
    return this.request('PATCH', `/devices/${encodeURIComponent(deviceId)}`, { body: patch, signal })
  }

  async setNickname(deviceId, nickname, { signal } = {}) {
    return this.request('POST', `/devices/${encodeURIComponent(deviceId)}/nickname`, { body: { nickname }, signal })
  }

  async setControlConnection(deviceId, type, { signal } = {}) {
    return this.request('PUT', `/devices/${encodeURIComponent(deviceId)}/control-connection`, { body: { type }, signal })
  }

  async watchdogHeartbeat(clientId, ttlSeconds, { signal } = {}) {
    return this.request('POST', '/device-watchdog/heartbeat', { body: { clientId, ttlSeconds }, signal })
  }

  async stopAll(clientId, reason, { signal } = {}) {
    return this.request('POST', '/device-watchdog/stop-all', { body: { clientId, reason }, signal, timeoutMs: 30000 })
  }

  async emergencyStopRemote({ signal } = {}) {
    return this.request('POST', '/remote-session/emergency-stop', { body: {}, signal, timeoutMs: 30000 })
  }

  async games({ signal } = {}) {
    return this.request('GET', '/games', { signal })
  }

  async gameStatus({ signal } = {}) {
    return this.request('GET', '/games/status', { signal })
  }

  async stopCurrentGame({ signal } = {}) {
    return this.request('POST', '/games/stop-current', { body: {}, signal, timeoutMs: 30000 })
  }

  async startGame(gameId, { deviceMapping, parameters, source } = {}, { signal } = {}) {
    return this.request('POST', `/games/${encodeURIComponent(gameId)}/start`, {
      body: { deviceMapping: deviceMapping || {}, parameters: parameters || {}, source, defer: false },
      signal,
    })
  }

  async gameRuntimeStatus({ signal } = {}) {
    return this.request('GET', '/game-runtime/status', { signal })
  }

  async gameRuntimeParams(params, { signal } = {}) {
    return this.request('POST', '/game-runtime/params', { body: { params }, signal })
  }

  async gameRuntimeAction(action, payload, { signal } = {}) {
    return this.request('POST', '/game-runtime/action', { body: { action, payload }, signal })
  }

  async gameRuntimeStop(reason, { signal } = {}) {
    return this.request('POST', '/game-runtime/stop', { body: { reason }, signal })
  }

  async clientState({ signal } = {}) {
    return this.request('GET', '/client/state', { signal })
  }

  async clientRoutes({ signal } = {}) {
    return this.request('GET', '/client/routes', { signal })
  }

  async clientWindow(action, { signal } = {}) {
    return this.request('POST', '/client/window', { body: { action }, signal })
  }

  async clientNavigate(path, show = true, { signal } = {}) {
    return this.request('POST', '/client/navigate', { body: { path, show }, signal })
  }

  async clientScreenshot({ format = 'png', maxWidth = 1280 } = {}, { signal } = {}) {
    return this.request('POST', '/client/screenshot', { body: { format, maxWidth }, signal, timeoutMs: 30000 })
  }

  async launchClientGame(gameId, { deviceMap, parameters, show = true } = {}, { signal } = {}) {
    return this.request('POST', `/client/games/${encodeURIComponent(gameId)}/launch`, {
      body: { deviceMap, parameters, show }, signal, timeoutMs: 60000,
    })
  }

  async eventsRecent({ limit = 100, types } = {}, { signal } = {}) {
    return this.request('GET', '/events/recent', {
      query: { limit, types: Array.isArray(types) ? types.join(',') : types }, signal,
    })
  }

  /** Brands device discovery/connection (local mode only). */
  async brandsStatus({ signal } = {}) {
    return this.request('GET', '/brands/status', { signal })
  }

  async brandsDiscover({ brand, host, port, mode, timeoutMs, hosts } = {}, { signal } = {}) {
    return this.request('GET', '/brands/discover', {
      query: { brand, host, port, mode, timeoutMs, hosts: hosts?.join(',') }, signal,
    })
  }

  async brandsConnect(payload, { signal } = {}) {
    return this.request('POST', '/brands/connect', { body: payload, signal })
  }

  async brandsDisconnect(deviceId, { signal } = {}) {
    return this.request('POST', `/brands/${encodeURIComponent(deviceId)}/disconnect`, { body: {}, signal })
  }
}

export { UsApiError }
