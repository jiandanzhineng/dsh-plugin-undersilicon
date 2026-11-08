import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorMessage } from '../util/errors.js'
import { SandboxHost } from './sandbox-host.js'

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
  constructor({ client, safety, events, audit, config, log = () => {}, notifyAgent, emergencyStop, statusProvider, dir = DEFAULT_DIR, clock = globalThis, sandbox } = {}) {
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
    this.host = sandbox || new SandboxHost({
      log,
      onMessage: (message) => { void this.onSandboxMessage(message) },
      onExit: (info) => this.onSandboxExit(info),
    })
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
      abort: new AbortController(), finalized: false, stoppedByUser: false,
      notifyTimes: [], notifyPending: null, notifyTimer: null,
    }
    this.workers.set(id, script)
    this.ensureMonitor()
    this.host.ensure({ memoryMb: limits.memoryMb })
    const sent = this.host.post({
      type: 'run', scriptId: id, code: text,
      limits: {
        maxTimers: 50, minIntervalMs: 200,
        syncTimeoutMs: limits.syncTimeoutMs, maxLogs: limits.maxLogs,
      },
    })
    if (!sent) {
      this.finalize(script, 'error', { error: 'sandbox process is unavailable; script was not started' })
      throw new Error('sandbox process is unavailable; script was not started')
    }
    this.audit.record({
      sessionId, source: { kind: source, name: script.name, id }, action: 'script.start',
      result: { ok: true, codeLength: text.length, persist: script.persist },
    })
    return scriptSummary(script, { includeCode: true })
  }

  async onSandboxMessage(message) {
    if (message.type === 'heartbeat') {
      const now = Date.now()
      for (const scriptId of message.scriptIds || []) {
        const script = this.workers.get(scriptId)
        if (script && !script.finalized) script.lastHeartbeat = now
      }
      return
    }
    const script = message.scriptId ? this.workers.get(message.scriptId) : null
    if (!script || script.finalized) return
    script.lastHeartbeat = Date.now()
    switch (message.type) {
      case 'ready':
        if (script.status === 'starting') {
          script.status = 'running'
          script.startedAt = new Date().toISOString()
        }
        break
      case 'fatal':
        this.finalize(script, 'error', { error: `sandbox fatal error: ${message.error}` })
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

  onSandboxExit({ code, signal, intentional }) {
    const reason = intentional ? 'sandbox-disposed' : `sandbox process exited (code ${code ?? '-'} signal ${signal ?? '-'})`
    for (const script of this.workers.values()) {
      if (script.finalized) continue
      this.pushLog(script, 'error', reason)
      if (script.agent && this.notifyAgent) {
        void this.notifyAgent(script.agent, `脚本沙箱进程崩溃，已停止所有脚本：${reason}`, false, script).catch(() => {})
      }
      this.finalize(script, 'error', { error: `crashed: ${reason}` })
    }
  }

  pushLog(script, level, text) {
    const line = { ts: new Date().toISOString(), level: level || 'info', text: String(text ?? '').slice(0, 4000) }
    script.logs.push(line)
    if (script.logs.length > this.limits.maxLogs) script.logs.shift()
    this.log(`[${script.id}] ${line.text}`, { level: line.level })
  }

  /** Deliver at most 3 notifications per 10s; excess becomes one merged summary. */
  async notify(script, text, wake) {
    const body = String(text || '').slice(0, 4000)
    this.pushLog(script, 'notify', body)
    const now = Date.now()
    script.notifyTimes = (script.notifyTimes || []).filter((stamp) => now - stamp < 10000)
    if (script.notifyTimes.length < 3) {
      script.notifyTimes.push(now)
      await this.deliverNotify(script, body, wake, false)
      return
    }
    script.notifyPending ??= { count: 0, texts: [], wake: false }
    script.notifyPending.count += 1
    script.notifyPending.wake = script.notifyPending.wake || wake
    if (script.notifyPending.texts.length < 3) script.notifyPending.texts.push(body.slice(0, 300))
    if (!script.notifyTimer) {
      script.notifyTimer = this.clock.setTimeout(() => { void this.flushNotify(script) }, 10000)
      script.notifyTimer?.unref?.()
    }
  }

  async deliverNotify(script, text, wake, merged) {
    this.audit.record({
      sessionId: script.sessionId, source: { kind: 'script', name: script.name, id: script.id },
      action: 'script.notify', result: { ok: true, wake, merged },
    })
    if (script.agent && this.notifyAgent) {
      try { await this.notifyAgent(script.agent, text, wake, script) } catch { /* agent may be disposed */ }
    }
  }

  async flushNotify(script) {
    if (script.notifyTimer) this.clock.clearTimeout(script.notifyTimer)
    script.notifyTimer = null
    const pending = script.notifyPending
    script.notifyPending = null
    if (!pending) return
    const text = `[merged ${pending.count} notifications] ${pending.texts.join(' | ')}`
    await this.deliverNotify(script, text, pending.wake, true)
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
            this.host.post({ type: 'event', scriptId: script.id, localId: message.localId, json: JSON.stringify(event) })
          } catch { /* child gone */ }
        },
      })
      script.subscriptions.set(message.localId, subscription.id)
    } catch (error) {
      this.pushLog(script, 'error', `subscribe failed: ${errorMessage(error)}`)
      try {
        this.host.post({
          type: 'event', scriptId: script.id, localId: message.localId,
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

  scriptSignal(script) {
    const timeout = AbortSignal.timeout(60000)
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, script.abort.signal])
    const controller = new AbortController()
    const abort = () => controller.abort(script.abort.signal.reason || timeout.reason)
    if (script.abort.signal.aborted) abort()
    else script.abort.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 60000)
    timer.unref?.()
    return controller.signal
  }

  async onRpc(script, message) {
    const fail = (error) => {
      try {
        this.host.post({
          type: 'rpc-result', scriptId: script.id, id: message.id,
          ok: false, error: errorMessage(error).slice(0, 2000),
        })
      } catch { /* child gone */ }
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
      this.host.post({ type: 'rpc-result', scriptId: script.id, id: message.id, ok: true, json })
    } catch (error) {
      fail(error)
    } finally {
      script.rpcInFlight -= 1
    }
  }

  async dispatchRpc(script, method, args) {
    const sessionId = script.sessionId
    const source = { kind: 'script', name: script.name, id: script.id }
    const signal = this.scriptSignal(script)
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
          this.client.deviceTypeConfig(device.type, { signal }),
          this.client.monitorData(id, { signal }),
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
        const typeConfig = await this.client.deviceTypeConfig(device.type, { signal })
        const definition = (typeConfig?.operations || []).find((item) => item.key === operation)
        return this.safety.operate({
          sessionId, source, deviceId: String(deviceId), operation: String(operation),
          params: params || {}, definition, deviceType: device.type, signal,
        })
      }
      case 'game.list':
        return this.client.games({ signal })
      case 'game.status':
        return {
          game: await this.client.gameStatus({ signal }),
          runtime: await this.client.gameRuntimeStatus({ signal }),
        }
      case 'game.start':
        return this.safety.gameStart({
          sessionId, source, gameId: String(args[0]), parameters: args[1]?.parameters ?? args[1]?.params,
          deviceMapping: args[1]?.deviceMapping ?? args[1]?.deviceMap, launch: true, show: args[1]?.show,
          signal, auditAction: 'game.start',
        })
      case 'game.launch':
        return this.safety.gameStart({
          sessionId, source, gameId: String(args[0]), parameters: args[1]?.parameters ?? args[1]?.params,
          deviceMapping: args[1]?.deviceMapping ?? args[1]?.deviceMap, launch: true, show: args[1]?.show,
          signal, auditAction: 'game.start',
        })
      case 'game.params':
        return this.safety.gameParams({ sessionId, source, params: args[0] || {}, signal })
      case 'game.action':
        return this.safety.gameAction({
          sessionId, source, action: String(args[0] || ''), payload: args[1] || {}, signal,
        })
      case 'game.stop':
        return this.safety.gameStop({ sessionId, source, reason: 'script-stop', signal })
      case 'client.state':
        return this.client.clientState({ signal })
      case 'client.routes':
        return this.client.clientRoutes({ signal })
      case 'client.window':
        this.safety.assertActive()
        return this.client.clientWindow(String(args[0] || ''), { signal })
      case 'client.navigate':
        this.safety.assertActive()
        return this.client.clientNavigate(String(args[0] || ''), args[1] !== false, { signal })
      case 'client.screenshot': {
        const shot = await this.client.clientScreenshot(args[0] || {}, { signal })
        if (!shot) return shot
        const { data, ...meta } = shot
        return { ...meta, bytes: typeof data === 'string' ? Math.floor(data.length * 0.75) : meta.bytes }
      }
      case 'api': {
        const [methodName, path, body, apiQuery] = args
        return this.safety.raw({ sessionId, source, method: methodName, path, body, query: apiQuery, signal })
      }
      case 'events.recent':
        return this.events.recent({ limit: Number(args[0]) || 50, types: args[1] })
      case 'stopAll': {
        this.stopAll('script-stop-all', undefined, { explicit: false })
        const result = await this.emergencyStop({ sessionId, source, reason: 'script-stop-all' })
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
    if (script.notifyTimer) this.clock.clearTimeout(script.notifyTimer)
    script.notifyTimer = null
    if (script.notifyPending) void this.flushNotify(script).catch(() => {})
    try { script.abort.abort(new Error('script finalized')) } catch { /* already aborted */ }
    for (const subscriptionId of script.subscriptions.values()) this.events.unsubscribe(subscriptionId)
    script.subscriptions.clear()
    this.host.post({ type: 'shutdown', scriptId: script.id, reason: status })
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
    try { script.abort.abort(new Error(reason)) } catch { /* already aborted */ }
    this.host.post({ type: 'shutdown', scriptId: id, reason })
    const timer = this.clock.setTimeout(() => {
      if (!script.finalized) this.finalize(script, 'stopped', { reason })
    }, 500)
    timer?.unref?.()
    return true
  }

  /** Stop every script, optionally only one agent session's scripts. */
  stopAll(reason = 'script_stop_all', sessionId, { explicit = true } = {}) {
    const targets = []
    for (const script of this.workers.values()) {
      if (sessionId !== undefined && script.sessionId !== sessionId) continue
      if (script.finalized) continue
      targets.push(script)
    }
    for (const script of targets) {
      if (explicit) script.stoppedByUser = true
      try { script.abort.abort(new Error(reason)) } catch { /* already aborted */ }
      this.host.post({ type: 'shutdown', scriptId: script.id, reason })
    }
    if (targets.length > 0) {
      const ids = new Set(targets.map((script) => script.id))
      const timer = this.clock.setTimeout(() => {
        for (const script of this.workers.values()) {
          if (ids.has(script.id) && !script.finalized) this.finalize(script, 'stopped', { reason })
        }
      }, 500)
      timer?.unref?.()
    }
    return targets.length
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
      const stale = [...this.workers.values()].filter((script) => (
        !script.finalized && now - script.lastHeartbeat > this.limits.heartbeatTimeoutMs
      ))
      if (stale.length === 0) return
      const reason = `sandbox blocked (no heartbeat for ${this.limits.heartbeatTimeoutMs}ms); restarted`
      this.host.kill('script-stalled')
      for (const script of this.workers.values()) {
        if (script.finalized) continue
        this.pushLog(script, 'error', reason)
        if (script.agent && this.notifyAgent) {
          void this.notifyAgent(script.agent, `脚本沙箱无响应，已重启并停止所有脚本：${reason}`, false, script).catch(() => {})
        }
        this.finalize(script, 'error', { error: reason })
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

  /** Terminate every script and the shared sandbox child (plugin dispose). */
  dispose() {
    for (const script of this.workers.values()) {
      script.finalized = true
      try { script.abort.abort(new Error('plugin disposed')) } catch { /* already aborted */ }
      if (script.notifyTimer) this.clock.clearTimeout(script.notifyTimer)
      script.notifyTimer = null
      this.host.post({ type: 'shutdown', scriptId: script.id, reason: 'dispose' })
    }
    this.stopMonitor()
    this.workers.clear()
    this.host.dispose()
  }
}
