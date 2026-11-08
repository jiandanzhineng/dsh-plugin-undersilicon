import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'

const limits = {
  maxTimers: 50, minIntervalMs: 200, syncTimeoutMs: 5000, maxLogs: 500,
  ...workerData.limits,
}
const pendingRpc = new Map()
const hostTimers = new Map()
let rpcSeq = 1
let logCount = 0
let stopping = false
let api

function post(message) {
  try { parentPort.postMessage(message) } catch { /* channel closed */ }
}

function safeText(value) {
  if (typeof value === 'string') return value.slice(0, 4000)
  if (value && typeof value.stack === 'string') return value.stack.slice(0, 4000)
  if (value && typeof value.message === 'string') return value.message.slice(0, 4000)
  try {
    const text = api?.stringify(value)
    return typeof text === 'string' ? text.slice(0, 4000) : String(value)
  } catch {
    return '[unserializable value]'
  }
}

/** Host-side bridge. It is passed only as a closure variable, never exposed on an object. */
const bridge = Object.freeze({
  rpc(method, args, timeoutMs, onOk, onError) {
    if (stopping) { onError('script is stopping'); return }
    const id = rpcSeq++
    const payload = api.stringify(args ?? [])
    const timer = setTimeout(() => {
      const entry = pendingRpc.get(id)
      if (!entry) return
      pendingRpc.delete(id)
      entry.onError(`us.${method} timed out`)
    }, Math.max(1000, Number(timeoutMs) || 30000))
    timer.unref?.()
    post({ type: 'rpc', id, method, argsJson: payload ?? '[]', meta: { timeoutMs: Number(timeoutMs) || 30000 } })
    pendingRpc.set(id, { onOk, onError, method, timer })
  },
  setTimer(localId, delay, repeat) {
    const handle = repeat
      ? setInterval(() => api.dispatchTimer(localId), delay)
      : setTimeout(() => { hostTimers.delete(localId); api.dispatchTimer(localId) }, delay)
    handle.unref?.()
    hostTimers.set(localId, handle)
  },
  clearTimer(localId) {
    const handle = hostTimers.get(localId)
    if (!handle) return
    clearTimeout(handle)
    clearInterval(handle)
    hostTimers.delete(localId)
  },
  subscribe(localId, type, filterJson) {
    post({ type: 'subscribe', localId, eventType: type, filterJson })
  },
  unsubscribe(localId) { post({ type: 'unsubscribe', localId }) },
  notify(text, wake) { post({ type: 'notify', text: String(text).slice(0, 4000), wake: wake === true }) },
  log(level, argsJson) { post({ type: 'log', level, text: argsJson }) },
  stop(reason) {
    if (stopping) return
    stopping = true
    for (const [id, handle] of hostTimers) {
      clearTimeout(handle)
      clearInterval(handle)
      hostTimers.delete(id)
    }
    post({ type: 'stopped', reason: String(reason || 'us.stop()') })
  },
})

/** Context-realm API factory. Every callable it returns belongs to the vm realm. */
const FACTORY = String.raw`
const state = {}
const pending = new Map()
const timerHandlers = new Map()
const eventHandlers = new Map()
let seq = 1
const parse = (text) => JSON.parse(text)
const stringify = (value) => {
  try { return JSON.stringify(value) } catch { return undefined }
}
const bridgeLog = (level, args) => bridge.log(level, stringify(args))
const call = (method, args, timeoutMs) => new Promise((resolve, reject) => {
  const id = 'r' + (seq++)
  pending.set(id, { resolve, reject })
  bridge.rpc(method, Array.isArray(args) ? args : [], timeoutMs, (ok, json) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (!ok) { entry.reject(new Error(String(json || 'RPC failed'))); return }
    try { entry.resolve(json === undefined ? undefined : parse(json)) }
    catch (error) { entry.reject(error) }
  }, (message) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    entry.reject(new Error(String(message || 'RPC failed')))
  })
})
function addTimer(kind, ms, fn) {
  if (typeof fn !== 'function') throw new Error('timer needs a function')
  if (timerHandlers.size >= ${limits.maxTimers}) throw new Error('too many timers (max ${limits.maxTimers})')
  const delay = Math.max(${limits.minIntervalMs}, Math.min(3600000, Number(ms) || 0))
  const id = 't' + (seq++)
  const entry = { id, fn, repeat: kind === 'every' }
  timerHandlers.set(id, entry)
  bridge.setTimer(id, delay, entry.repeat)
  return id
}
function clearTimer(id) {
  if (!timerHandlers.delete(id)) return false
  bridge.clearTimer(id)
  return true
}
const log = (...args) => bridgeLog('info', args)
const us = Object.freeze({
  state,
  mode: () => call('mode', []),
  status: () => call('status', []),
  devices: (filter) => call('devices', [filter]),
  device: (id) => call('device', [id]),
  control: (deviceId, capability, action, input) => call('control', [deviceId, capability, action, input]),
  operate: (deviceId, operation, params) => call('operate', [deviceId, operation, params]),
  game: Object.freeze({
    list: () => call('game.list', []),
    status: () => call('game.status', []),
    start: (id, options) => call('game.start', [id, options], 60000),
    launch: (id, options) => call('game.launch', [id, options], 60000),
    params: (params) => call('game.params', [params]),
    action: (action, payload) => call('game.action', [action, payload]),
    stop: () => call('game.stop', [], 30000),
  }),
  client: Object.freeze({
    state: () => call('client.state', []),
    routes: () => call('client.routes', []),
    window: (action) => call('client.window', [action]),
    navigate: (path, show) => call('client.navigate', [path, show]),
    screenshot: (options) => call('client.screenshot', [options], 60000),
  }),
  api: (method, path, body, query) => call('api', [method, path, body, query], 60000),
  recent: (limit, types) => call('events.recent', [limit, types]),
  notify: (text, options) => bridge.notify(String(text), options && options.wake === true),
  on: (type, handler, filter) => {
    if (typeof handler !== 'function') throw new Error('us.on(type, handler) needs a function')
    if (!type || typeof type !== 'string') throw new Error('us.on needs an event type')
    const localId = 'e' + (seq++)
    eventHandlers.set(localId, handler)
    bridge.subscribe(localId, type, stringify(filter || {}))
    return () => {
      if (!eventHandlers.delete(localId)) return
      bridge.unsubscribe(localId)
    }
  },
  every: (ms, fn) => addTimer('every', ms, fn),
  after: (ms, fn) => addTimer('after', ms, fn),
  clearTimer,
  sleep: (ms) => new Promise((resolve) => { addTimer('after', ms, resolve) }),
  stopAll: () => call('stopAll', [], 60000),
  stop: (reason) => bridge.stop(reason || 'us.stop()'),
  log,
})
const logger = Object.freeze({
  log: (...args) => bridgeLog('info', args),
  info: (...args) => bridgeLog('info', args),
  warn: (...args) => bridgeLog('warn', args),
  error: (...args) => bridgeLog('error', args),
  debug: (...args) => bridgeLog('debug', args),
})
function dispatchTimer(id) {
  const entry = timerHandlers.get(id)
  if (!entry) return
  if (!entry.repeat) timerHandlers.delete(id)
  try { Promise.resolve(entry.fn()).catch((error) => bridgeLog('error', ['timer failed', String(error)])) }
  catch (error) { bridgeLog('error', ['timer failed', String(error)]) }
}
function dispatchEvent(localId, json) {
  const handler = eventHandlers.get(localId)
  if (!handler) return
  try { handler(parse(json)) } catch (error) { bridgeLog('error', ['event handler failed', String(error)]) }
}
return {
  us, logger, state, dispatchTimer, dispatchEvent, stringify, parse,
  busy: () => timerHandlers.size + eventHandlers.size + pending.size > 0,
  timerApi: {
    setTimeout: (fn, ms) => addTimer('after', ms, fn),
    setInterval: (fn, ms) => addTimer('every', ms, fn),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
  },
}
`

const context = vm.createContext({}, {
  name: 'undersilicon-script',
  codeGeneration: { strings: false, wasm: false },
})
const factoryFn = vm.compileFunction(FACTORY, ['bridge'], {
  parsingContext: context,
  filename: 'undersilicon-api.js',
})
api = factoryFn(bridge)
context.us = api.us
context.console = api.logger
context.setTimeout = api.timerApi.setTimeout
context.setInterval = api.timerApi.setInterval
context.clearTimeout = api.timerApi.clearTimeout
context.clearInterval = api.timerApi.clearInterval

post({ type: 'ready' })
const heartbeat = setInterval(() => post({ type: 'heartbeat' }), 250)
heartbeat.unref?.()

function finish(reason, payload = {}) {
  const busy = hostTimers.size > 0 || pendingRpc.size > 0 || api?.busy?.() === true
  post({ type: 'result', reason, ...payload, busy })
  if (!busy) bridge.stop(reason)
}

async function run() {
  const source = `(async () => {\n"use strict";\n${workerData.code}\n})()`
  try {
    const value = vm.runInContext(source, context, {
      timeout: limits.syncTimeoutMs,
      filename: 'undersilicon-script.js',
    })
    const resolved = await value
    const json = resolved === undefined ? undefined : api.stringify(resolved)
    finish('completed', json === undefined ? {} : { resultJson: json })
  } catch (error) {
    finish('error', { error: safeText(error) })
  }
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'rpc-result') {
    const entry = pendingRpc.get(message.id)
    if (!entry) return
    pendingRpc.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.onOk(true, message.json)
    else entry.onError(String(message.error || 'RPC failed'))
    return
  }
  if (message.type === 'event') {
    try { api.dispatchEvent(message.localId, message.json) } catch { /* ignore */ }
    return
  }
  if (message.type === 'timer') {
    try { api.dispatchTimer(message.localId) } catch { /* ignore */ }
    return
  }
  if (message.type === 'shutdown') {
    stopping = true
    for (const [id, handle] of hostTimers) {
      clearTimeout(handle)
      clearInterval(handle)
      hostTimers.delete(id)
    }
    post({ type: 'stopped', reason: 'shutdown' })
  }
})

void run()
