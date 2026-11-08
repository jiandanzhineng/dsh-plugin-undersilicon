import { Worker } from 'node:worker_threads'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../util/errors.js'

const DEFAULT_DIR = join(homedir(), '.dsh', 'undersilicon')
const MAX_RPC_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024
const RPC_METHODS = new Set([
  'mode', 'status', 'devices', 'device', 'control', 'operate',
  'game.list', 'game.status', 'game.start', 'game.launch', 'game.params', 'game.action', 'game.stop',
  'client.state', 'client.routes', 'client.window', 'client.navigate', 'client.screenshot',
  'api', 'events.recent', 'stopAll',
])

/** Tool/panel-facing script metadata. */
export function scriptSummary(script, { includeCode = false } = {}) {
  return {
    id: script.id, name: script.name, status: script.status,
    sessionId: script.sessionId, persist: script.persist,
    createdAt: script.createdAt, startedAt: script.startedAt, endedAt: script.endedAt,
    lastError: script.error, result: script.result,
    logs: script.logs.slice(-20), subscriptions: script.subscriptions.size,
    rpcInFlight: script.rpcInFlight,
    ...(includeCode ? { code: script.code } : {}),
  }
}

/** Host-side script lifecycle and RPC bridge. */
export class ScriptManager {
  constructor({ client, safety, events, audit, config, log = () => {}, notifyAgent, emergencyStop, statusProvider, dir = DEFAULT_DIR, clock = globalThis } = {}) {
    this.client = client
    this.safety = safety
    this.events = events
    this.audit = audit
    this.config = config
    this.log = log
    this.notifyAgent = notifyAgent
    this.emergencyStop = emergencyStop
    this.statusProvider = statusProvider
    this.dir = dir
    this.clock = clock
    this.workers = new Map()
    this.seq = 1
    this.monitor = null
    this.restored = false
  }

  get limits() {
    return {
      maxConcurrent: Math.max(1, Number(this.config?.scripts?.maxConcurrent ?? 8)),
      memoryMb: Math.max(16, Number(this.config?.scripts?.memoryMb ?? 64)),
      syncTimeoutMs: Math.max(100, Number(this.config?.scripts?.syncTimeoutMs ?? 5000)),
      heartbeatTimeoutMs: Math.max(1000, Number(this.config?.scripts?.heartbeatTimeoutMs ?? 5000)),
      maxLogs: Math.max(50, Number(this.config?.scripts?.maxLogs ?? 500)),
      allowPersist: this.config?.scripts?.allowPersist !== false,
    }
  }

  running() {
    return [...this.workers.values()].filter((script) => !script.finalized)
  }

  /** Start one script. Returns immediately; poll script_list for the outcome. */
  async run({ code, name, sessionId, agent, persist = false, source = 'agent' }) {
    const text = String(code ?? '')
    if (!text.trim()) throw new Error('script code must be a non-empty string')
    if (text.length > 200000) throw new Error('script code is too large (max 200000 characters)')
    const limits = this.limits
    if (this.running().length >= limits.maxConcurrent) {
      throw new Error(`too many running scripts (max ${limits.maxConcurrent}); stop one first`)
    }
    const id = `script_${this.seq++}_${Date.now().toString(36)}`
    const script = {
      id, name: name || id, code: text, status: 'starting', sessionId, agent,
      persist: Boolean(persist && limits.allowPersist), source,
      createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
      lastHeartbeat: Date.now(), logs: [], result: null, error: null,
      subscriptions: new Map(), rpcInFlight: 0, timerCount: 0,
      worker: null, finalized: false, stoppedByUser: false,
    }
    let worker
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: {
          code: text,
          limits: {
            maxTimers: 50, minIntervalMs: 200,
            syncTimeoutMs: limits.syncTimeoutMs, maxLogs: limits.maxLogs,
          },
        },
        resourceLimits: {
          maxOldGenerationSizeMb: limits.memoryMb,
          maxYoungGenerationSizeMb: Math.max(8, Math.floor(limits.memoryMb / 2)),
        },
        stdout: false,
        stderr: false,
      })
    } catch (error) {
      throw new Error(`cannot start script worker: ${errorMessage(error)}`)
    }
    script.worker = worker
    this.workers.set(id, script)
    this.ensureMonitor()
    worker.on('message', (message) => { void this.onMessage(script, message) })
    worker.on('error', (error) => this.finalize(script, 'error', { error: `worker error: ${errorMessage(error)}` }))
    worker.on('exit', (code) => {
      if (!script.finalized) {
        this.finalize(script, code === 0 ? 'completed' : 'error', {
          error: code === 0 ? undefined : `worker exited with code ${code}`,
        })
      }
    })
    this.audit.record({
      sessionId, source: { kind: source, name: script.name, id }, action: 'script.start',
      result: { ok: true, codeLength: text.length, persist: script.persist },
    })
    return scriptSummary(script, { includeCode: true })
  }

  async onMessage(script, message) {
    if (!message || typeof message !== 'object' || script.finalized) return
    script.lastHeartbeat = Date.now()
    switch (message.type) {
      case 'ready':
        if (script.status === 'starting') {
          script.status = 'running'
          script.startedAt = new Date().toISOString()
        }
        break
      case 'heartbeat':
        break
      case 'log':
        this.pushLog(script, message.level, message.text)
        break
      case 'notify':
        await this.notify(script, message.text, message.wake === true)
        break
      case 'rpc':
        await this.onRpc(script, message)
        break
      case 'subscribe':
        this.onSubscribe(script, message)
        break
      case 'unsubscribe':
        this.onUnsubscribe(script, message)
        break
      case 'result':
        this.onResult(script, message)
        break
      case 'stopped':
        this.finalize(script, 'stopped', { reason: message.reason })
        break
      default:
        break
    }
  }

  pushLog(script, level, text) {
    const line = { ts: new Date().toISOString(), level: level || 'info', text: String(text ?? '').slice(0, 4000) }
    script.logs.push(line)
    if (script.logs.length > this.limits.maxLogs) script.logs.shift()
    this.log(`[${script.id}] ${line.text}`, { level: line.level })
  }

  async notify(script, text, wake) {
    const body = String(text || '').slice(0, 4000)
    this.pushLog(script, 'notify', body)
    this.audit.record({
      sessionId: script.sessionId, source: { kind: 'script', name: script.name, id: script.id },
      action: 'script.notify', result: { ok: true, wake },
    })
    if (script.agent && this.notifyAgent) {
      try { await this.notifyAgent(script.agent, body, wake, script) } catch { /* agent may be disposed */ }
    }
  }

  onSubscribe(script, message) {
    let filter = {}
    try { filter = message.filterJson ? JSON.parse(message.filterJson) : {} } catch { filter = {} }
    try {
      const subscription = this.events.subscribe({
        kind: 'script', ownerId: script.id, types: [message.eventType],
        deviceId: filter.deviceId, where: filter.where,
        throttleMs: filter.throttleMs, maxEvents: filter.maxEvents,
        onEvent: (event) => {
          try {
            script.worker.postMessage({ type: 'event', localId: message.localId, json: JSON.stringify(event) })
          } catch { /* worker closed */ }
        },
      })
      script.subscriptions.set(message.localId, subscription.id)
    } catch (error) {
      this.pushLog(script, 'error', `subscribe failed: ${errorMessage(error)}`)
      try {
        script.worker.postMessage({
          type: 'event', localId: message.localId,
          json: JSON.stringify({ type: 'subscription.error', message: errorMessage(error) }),
        })
      } catch { /* ignore */ }
    }
  }

  onUnsubscribe(script, message) {
    const id = script.subscriptions.get(message.localId)
    if (!id) return
    script.subscriptions.delete(message.localId)
    this.events.unsubscribe(id)
  }

  onResult(script, message) {
    let result = null
    if (message.resultJson !== undefined) {
      if (String(message.resultJson).length > MAX_RESULT_BYTES) {
        this.finalize(script, 'error', { error: 'script result exceeds 2MB; return a smaller summary' })
        return
      }
      try { result = JSON.parse(message.resultJson) } catch { result = null }
    }
    script.result = result
    if (message.busy) {
      script.status = 'running'
      return
    }
    if (message.reason === 'error') this.finalize(script, 'error', { error: message.error })
    else if (message.reason === 'stopped') this.finalize(script, 'stopped', { reason: 'us.stop()' })
    else this.finalize(script, 'completed')
  }

  async onRpc(script, message) {
    const fail = (error) => {
      try {
        script.worker.postMessage({ type: 'rpc-result', id: message.id, ok: false, error: errorMessage(error) })
      } catch { /* worker closed */ }
    }
    if (!RPC_METHODS.has(message.method)) return fail(new Error(`unknown us method: ${message.method}`))
    if (script.rpcInFlight >= 8) return fail(new Error('too many concurrent us.* calls; await earlier ones'))
    if (String(message.argsJson || '').length > MAX_RPC_BYTES) return fail(new Error('arguments too large'))
    let args
    try { args = JSON.parse(message.argsJson || '[]') } catch { return fail(new Error('arguments are not valid JSON')) }
    if (!Array.isArray(args)) return fail(new Error('arguments must be an array'))
    script.rpcInFlight += 1
    try {
      const value = await this.dispatchRpc(script, message.method, args)
      const json = value === undefined ? undefined : JSON.stringify(value)
      if (json !== undefined && json.length > MAX_RESULT_BYTES) {
        throw new Error('RPC result exceeds 2MB; narrow the request')
      }
      script.worker.postMessage({ type: 'rpc-result', id: message.id, ok: true, json })
    } catch (error) {
      fail(error)
    } finally {
      script.rpcInFlight -= 1
    }
  }

  async dispatchRpc(script, method, args) {
    const sessionId = script.sessionId
    const source = { kind: 'script', name: script.name, id: script.id }
    const signal = AbortSignal.timeout(60000)
    switch (method) {
      case 'mode': return { mode: await this.safety.getMode({ signal }) }
      case 'status': return this.statusProvider ? await this.statusProvider() : {}
      case 'devices': {
        const filter = args[0] || {}
        const devices = await this.client.devices({ signal })
        return (devices || []).filter((device) => (
          (filter.connected === undefined || device.connected === filter.connected)
          && (!filter.type || device.type === filter.type)
        ))
      }
      case 'device': {
        const id = String(args[0] || '')
        if (!id) throw new Error('device id is required')
        const device = await this.client.device(id, { signal })
        const [typeConfig, monitor, ranges] = await Promise.all([
          this.client.deviceTypeConfig(device.type, { signal }).catch(() => null),
          this.client.monitorData(id, { signal }).catch(() => null),
          this.safety.getRanges({ signal }),
        ])
        return { device, typeConfig, monitor, ranges }
      }
      case 'control': {
        const [deviceId, capability, action, input] = args
        if (!deviceId || !capability || !action) throw new Error('deviceId, capability and action are required')
        return this.safety.control({ sessionId, source, deviceId: String(deviceId), capability: String(capability), action: String(action), input, signal })
      }
      case 'operate': {
        const [deviceId, operation, params] = args
        if (!deviceId || !operation) throw new Error('deviceId and operation are required')
        const device = await this.client.device(String(deviceId), { signal })
        const typeConfig = await this.client.deviceTypeConfig(device.type, { signal }).catch(() => null)
        const definition = (typeConfig?.operations || []).find((item) => item.key === operation)
        return this.safety.operate({
          sessionId, source, deviceId: String(deviceId), operation: String(operation),
          params: params || {}, definition, signal,
        })
      }
      case 'game.list': return this.client.games({ signal })
      case 'game.status': return {
        game: await this.client.gameStatus({ signal }).catch(() => null),
        runtime: await this.client.gameRuntimeStatus({ signal }).catch(() => null),
      }
      case 'game.start': {
        const [id, options] = args
        return this.client.startGame(String(id), options || {}, { signal })
      }
      case 'game.launch': {
        const [id, options] = args
        return this.client.launchClientGame(String(id), options || {}, { signal })
      }
      case 'game.params': return this.client.gameRuntimeParams(args[0] || {}, { signal })
      case 'game.action': return this.client.gameRuntimeAction(args[0], args[1], { signal })
      case 'game.stop': {
        const [current, runtime] = await Promise.allSettled([
          this.client.stopCurrentGame({ signal }), this.client.gameRuntimeStop('script-stop', { signal }),
        ])
        return { current, runtime }
      }
      case 'client.state': return this.client.clientState({ signal })
      case 'client.routes': return this.client.clientRoutes({ signal })
      case 'client.window': return this.client.clientWindow(String(args[0] || ''), { signal })
      case 'client.navigate': return this.client.clientNavigate(String(args[0] || ''), args[1] !== false, { signal })
      case 'client.screenshot': {
        const shot = await this.client.clientScreenshot(args[0] || {}, { signal })
        return shot ? { ...shot, data: undefined, bytes: typeof shot.data === 'string' ? Math.floor(shot.data.length * 0.75) : shot.bytes } : shot
      }
      case 'api': {
        const [methodName, path, body, query] = args
        return this.safety.raw({ sessionId, source, method: methodName, path, body, query, signal })
      }
      case 'events.recent': return this.events.recent({ limit: Number(args[0]) || 50, types: args[1] })
      case 'stopAll': {
        const result = await (this.emergencyStop ? this.emergencyStop({ sessionId, source, reason: 'script-stop-all' }) : { ok: false })
        this.clock.setTimeout(() => this.stopAll('script-stop-all'), 100)?.unref?.()
        return result
      }
      default: throw new Error(`unsupported us method: ${method}`)
    }
  }

  async onRpc(script, message) {
    const fail = (error) => {
      try {
        script.worker.postMessage({
          type: 'rpc-result', id: message.id, ok: false, error: errorMessage(error).slice(0, 2000),
        })
      } catch { /* worker closed */ }
    }
    if (!RPC_METHODS.has(message.method)) return fail(new Error(`unknown us method: ${message.method}`))
    if (script.rpcInFlight >= 8) return fail(new Error('too many concurrent us.* calls; await earlier ones'))
    if (String(message.argsJson || '').length > MAX_RPC_BYTES) return fail(new Error('RPC arguments exceed 1MB'))
    let args
    try { args = JSON.parse(message.argsJson || '[]') } catch { return fail(new Error('RPC arguments are not valid JSON')) }
    if (!Array.isArray(args)) return fail(new Error('RPC arguments must be an array'))
    script.rpcInFlight += 1
    try {
      const value = await this.dispatchRpc(script, message.method, args)
      const json = value === undefined ? undefined : JSON.stringify(value)
      if (json !== undefined && json.length > MAX_RESULT_BYTES) {
        throw new Error('RPC result exceeds 2MB; narrow the request')
      }
      script.worker.postMessage({ type: 'rpc-result', id: message.id, ok: true, json })
    } catch (error) {
      fail(error)
    } finally {
      script.rpcInFlight -= 1
    }
  }

  async dispatchRpc(script, method, args) {
    const sessionId = script.sessionId
    const source = { kind: 'script', name: script.name, id: script.id }
    const signal = AbortSignal.timeout(60000)
    switch (method) {
      case 'mode':
        return { mode: await this.safety.getMode({ signal }) }
      case 'status':
        return this.statusProvider ? await this.statusProvider({ sessionId }) : {}
      case 'devices': {
        const filter = args[0] || {}
        const devices = await this.client.devices({ signal })
        return (devices || []).filter((device) => (
          (filter.connected === undefined || device.connected === filter.connected)
          && (!filter.type || device.type === filter.type)
          && (!filter.id || device.id === filter.id)
        ))
      }
      case 'device': {
        const id = String(args[0] || '')
        if (!id) throw new Error('device id is required')
        const device = await this.client.device(id, { signal })
        const [typeConfig, monitor, ranges] = await Promise.all([
          this.client.deviceTypeConfig(device.type, { signal }).catch(() => null),
          this.client.monitorData(id, { signal }).catch(() => null),
          this.safety.getRanges({ signal }),
        ])
        return { device, typeConfig, monitor, ranges }
      }
      case 'control': {
        const [deviceId, capability, action, input] = args
        if (!deviceId || !capability || !action) throw new Error('deviceId, capability and action are required')
        return this.safety.control({
          sessionId, source, deviceId: String(deviceId), capability: String(capability),
          action: String(action), input: input || {}, signal,
        })
      }
      case 'operate': {
        const [deviceId, operation, params] = args
        if (!deviceId || !operation) throw new Error('deviceId and operation are required')
        const device = await this.client.device(String(deviceId), { signal })
        const typeConfig = await this.client.deviceTypeConfig(device.type, { signal }).catch(() => null)
        const definition = (typeConfig?.operations || []).find((item) => item.key === operation)
        return this.safety.operate({
          sessionId, source, deviceId: String(deviceId), operation: String(operation),
          params: params || {}, definition, signal,
        })
      }
      case 'game.list': return this.client.games({ signal })
      case 'game.status': return {
        game: await this.client.gameStatus({ signal }).catch(() => null),
        runtime: await this.client.gameRuntimeStatus({ signal }).catch(() => null),
      }
      case 'game.start': return this.client.startGame(String(args[0]), args[1] || {}, { signal })
      case 'game.launch': return this.client.launchClientGame(String(args[0]), args[1] || {}, { signal })
      case 'game.params': return this.client.gameRuntimeParams(args[0] || {}, { signal })
      case 'game.action': return this.client.gameRuntimeAction(args[0], args[1], { signal })
      case 'game.stop': {
        const [current, runtime] = await Promise.allSettled([
          this.client.stopCurrentGame({ signal }), this.client.gameRuntimeStop('script-stop', { signal }),
        ])
        return { current: current.status, runtime: runtime.status }
      }
      case 'client.state': return this.client.clientState({ signal })
      case 'client.routes': return this.client.clientRoutes({ signal })
      case 'client.window': return this.client.clientWindow(String(args[0] || ''), { signal })
      case 'client.navigate': return this.client.clientNavigate(String(args[0] || ''), args[1] !== false, { signal })
      case 'client.screenshot': {
        const shot = await this.client.clientScreenshot(args[0] || {}, { signal })
        if (!shot) return shot
        const { data, ...meta } = shot
        return { ...meta, bytes: typeof data === 'string' ? Math.floor(data.length * 0.75) : meta.bytes }
      }
      case 'api': {
        const [methodName, path, body, query] = args
        return this.safety.raw({ sessionId, source, method: methodName, path, body, query, signal })
      }
      case 'events.recent':
        return this.events.recent({ limit: Number(args[0]) || 50, types: args[1] })
      case 'stopAll': {
        const result = await this.emergencyStop({ sessionId, source, reason: 'script-stop-all' })
        this.clock.setTimeout(() => this.stopAll('script-stop-all'), 50)?.unref?.()
        return result
      }
      default:
        throw new Error(`unsupported us method: ${method}`)
    }
  }

  finalize(script, status, { error, reason } = {}) {
    if (script.finalized) return
    script.finalized = true
    script.status = status
    script.endedAt = new Date().toISOString()
    if (error) script.error = String(error).slice(0, 4000)
    if (reason) script.result = script.result ?? { reason }
    for (const subscriptionId of script.subscriptions.values()) this.events.unsubscribe(subscriptionId)
    script.subscriptions.clear()
    try { void script.worker.terminate() } catch { /* already gone */ }
    if (this.workers.size <= 1) this.stopMonitor()
    this.audit.record({
      sessionId: script.sessionId, source: { kind: 'script', name: script.name, id: script.id },
      action: 'script.end',
      result: { ok: status === 'completed' || status === 'stopped', status, error, reason },
    })
    void this.savePersisted()
  }

  /** Gracefully stop one script. */
  stop(id, reason = 'script_stop') {
    const script = this.workers.get(id)
    if (!script) return false
    if (script.finalized) return true
    script.stoppedByUser = true
    try { script.worker.postMessage({ type: 'shutdown' }) } catch { /* ignore */ }
    const timer = this.clock.setTimeout(() => {
      if (!script.finalized) this.finalize(script, 'stopped', { reason })
    }, 500)
    timer?.unref?.()
    return true
  }

  /** Stop every script, optionally only one agent session's scripts. */
  stopAll(reason = 'script_stop_all', sessionId, { explicit = true } = {}) {
    let count = 0
    for (const script of this.workers.values()) {
      if (sessionId !== undefined && script.sessionId !== sessionId) continue
      if (script.finalized) continue
      if (explicit) script.stoppedByUser = true
      try { script.worker.postMessage({ type: 'shutdown' }) } catch { /* ignore */ }
      count += 1
    }
    if (count > 0) {
      const timer = this.clock.setTimeout(() => {
        for (const script of this.workers.values()) {
          if (!script.finalized) this.finalize(script, 'stopped', { reason })
        }
      }, 500)
      timer?.unref?.()
    }
    return count
  }

  stopSession(sessionId, reason = 'session-end') {
    return this.stopAll(reason, sessionId, { explicit: false })
  }

  list({ sessionId, includeCode = false } = {}) {
    return [...this.workers.values()]
      .filter((script) => sessionId === undefined || script.sessionId === sessionId)
      .map((script) => scriptSummary(script, { includeCode }))
  }

  logs(id, limit = 100) {
    const script = this.workers.get(id)
    if (!script) return null
    return {
      id: script.id, status: script.status,
      logs: script.logs.slice(-Math.max(1, Math.min(500, limit))),
    }
  }

  ensureMonitor() {
    if (this.monitor || this.workers.size === 0) return
    this.monitor = this.clock.setInterval(() => {
      const now = Date.now()
      for (const script of this.workers.values()) {
        if (script.finalized) continue
        if (now - script.lastHeartbeat > this.limits.heartbeatTimeoutMs) {
          this.finalize(script, 'error', {
            error: `script blocked the event loop or died (no heartbeat for ${this.limits.heartbeatTimeoutMs}ms)`,
          })
        }
      }
    }, 500)
    this.monitor?.unref?.()
  }

  stopMonitor() {
    if (!this.monitor) return
    this.clock.clearInterval(this.monitor)
    this.monitor = null
  }

  async savePersisted() {
    if (!this.limits.allowPersist) return
    const rows = [...this.workers.values()]
      .filter((script) => script.persist && !script.stoppedByUser && (script.status === 'running' || script.status === 'starting'))
      .map((script) => ({
        name: script.name, code: script.code, createdAt: script.createdAt,
        sessionId: script.sessionId === 'persisted' ? undefined : script.sessionId,
      }))
    try {
      await mkdir(this.dir, { recursive: true })
      const file = join(this.dir, 'scripts.json')
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(rows, null, 2), 'utf8')
      await rename(tmp, file)
    } catch (error) {
      this.log('cannot save persisted scripts', { error: errorMessage(error) })
    }
  }

  /** Restore persist=true scripts from the previous dsh run (once). */
  async restore() {
    if (this.restored || !this.limits.allowPersist) return []
    this.restored = true
    let rows = []
    try {
      const text = await readFile(join(this.dir, 'scripts.json'), 'utf8')
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) rows = parsed
    } catch {
      return []
    }
    const started = []
    for (const row of rows.slice(0, this.limits.maxConcurrent)) {
      if (!row?.code) continue
      try {
        started.push(await this.run({
          code: row.code, name: row.name || 'persisted-script',
          sessionId: 'persisted', persist: true, source: 'persist',
        }))
      } catch (error) {
        this.log('cannot restore persisted script', { error: errorMessage(error) })
      }
    }
    return started
  }

  /** Terminate everything without graceful waits (plugin dispose / process exit). */
  dispose() {
    for (const script of this.workers.values()) {
      try { script.worker.postMessage({ type: 'shutdown' }) } catch { /* ignore */ }
      try { void script.worker.terminate() } catch { /* ignore */ }
      script.finalized = true
    }
    this.stopMonitor()
    this.workers.clear()
  }
}
