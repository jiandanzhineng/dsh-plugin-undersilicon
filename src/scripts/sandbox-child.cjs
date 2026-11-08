'use strict'

const vm = require('node:vm')

/**
 * Sandbox child. It is spawned with Node's permission model and only this file
 * is readable. Scripts get one vm context each; the host bridge lives in this
 * module's closure and is never exposed as a property of the context.
 */

const scripts = new Map()
const MAX_RPC_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 2 * 1024 * 1024

function post(message) {
  try {
    if (process.connected) process.send(message)
  } catch { /* parent gone */ }
}

function textOf(error) {
  if (typeof error === 'string') return error.slice(0, 4000)
  if (error && typeof error.stack === 'string') return error.stack.slice(0, 4000)
  if (error && typeof error.message === 'string') return error.message.slice(0, 4000)
  try { return JSON.stringify(error).slice(0, 4000) } catch { return String(error) }
}

function makeBridge(script) {
  return Object.freeze({
    rpc(method, args, timeoutMs, onOk, onError) {
      if (script.stopping) { onError('script is stopping'); return }
      let argsJson
      try { argsJson = JSON.stringify(args ?? []) } catch (error) { onError(`arguments are not JSON: ${textOf(error)}`); return }
      if (typeof argsJson !== 'string' || argsJson.length > MAX_RPC_BYTES) {
        onError(`RPC arguments exceed ${MAX_RPC_BYTES} bytes`)
        return
      }
      const id = `r${script.seq++}`
      const timer = setTimeout(() => {
        const entry = script.pending.get(id)
        if (!entry) return
        script.pending.delete(id)
        entry.onError(`us.${method} timed out`)
      }, Math.max(1000, Number(timeoutMs) || 30000))
      timer.unref?.()
      script.pending.set(id, { onOk, onError, timer })
      post({ type: 'rpc', scriptId: script.id, id, method, argsJson })
    },
    setTimer(localId, delay, repeat) {
      const handle = repeat
        ? setInterval(() => script.api?.dispatchTimer(localId), delay)
        : setTimeout(() => {
          script.timers.delete(localId)
          script.api?.dispatchTimer(localId)
        }, delay)
      handle.unref?.()
      script.timers.set(localId, { handle, repeat })
    },
    clearTimer(localId) {
      const entry = script.timers.get(localId)
      if (!entry) return
      clearTimeout(entry.handle)
      clearInterval(entry.handle)
      script.timers.delete(localId)
    },
    subscribe(localId, type, filterJson) {
      post({ type: 'subscribe', scriptId: script.id, localId, eventType: type, filterJson })
    },
    unsubscribe(localId) {
      post({ type: 'unsubscribe', scriptId: script.id, localId })
    },
    notify(text, wake) {
      post({ type: 'notify', scriptId: script.id, text: String(text).slice(0, 4000), wake: wake === true })
    },
    log(level, argsJson) {
      post({ type: 'log', scriptId: script.id, level, text: String(argsJson ?? '').slice(0, 4000) })
    },
    stop(reason) {
      if (script.stopping) return
      script.stopping = true
      clearScriptTimers(script)
      post({ type: 'stopped', scriptId: script.id, reason: String(reason || 'us.stop()') })
    },
  })
}

function clearScriptTimers(script) {
  for (const entry of script.timers.values()) {
    clearTimeout(entry.handle)
    clearInterval(entry.handle)
  }
  script.timers.clear()
  for (const entry of script.pending.values()) clearTimeout(entry.timer)
  script.pending.clear()
}

function apiFactory(limits) {
  return String.raw`
const state = {}
const pending = new Map()
const timerHandlers = new Map()
const eventHandlers = new Map()
let seq = 1
const parse = (text) => JSON.parse(text)
const stringify = (value) => {
  try { return JSON.stringify(value) } catch { return undefined }
}
const bridgeLog = (level, args) => {
  let text
  try { text = stringify(args) } catch { text = undefined }
  bridge.log(level, text === undefined ? String(args) : text)
}
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
  us, logger, state, dispatchTimer, dispatchEvent,
  busy: () => timerHandlers.size + eventHandlers.size + pending.size > 0,
  timerApi: {
    setTimeout: (fn, ms) => addTimer('after', ms, fn),
    setInterval: (fn, ms) => addTimer('every', ms, fn),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
  },
}
`
}

function runScript(message) {
  const { scriptId, code, limits } = message
  if (scripts.has(scriptId)) return
  const script = {
    id: scriptId, seq: 1, stopping: false, timers: new Map(), pending: new Map(), api: null,
  }
  scripts.set(scriptId, script)
  const bridge = makeBridge(script)
  let context
  try {
    context = vm.createContext(vm.constants?.DONT_CONTEXTIFY ?? Object.create(null), {
      name: `undersilicon-${scriptId}`,
      codeGeneration: { strings: false, wasm: false },
    })
    const factory = vm.compileFunction(apiFactory(limits), ['bridge'], {
      parsingContext: context,
      filename: 'undersilicon-api.js',
    })
    script.api = factory(bridge)
    context.us = script.api.us
    context.console = script.api.logger
    context.setTimeout = script.api.timerApi.setTimeout
    context.setInterval = script.api.timerApi.setInterval
    context.clearTimeout = script.api.timerApi.clearTimeout
    context.clearInterval = script.api.timerApi.clearInterval
  } catch (error) {
    scripts.delete(scriptId)
    post({ type: 'result', scriptId, reason: 'error', error: `sandbox setup failed: ${textOf(error)}` })
    return
  }
  post({ type: 'ready', scriptId })
  void (async () => {
    let value
    try {
      const source = `(async () => {\n"use strict";\n${code}\n})()`
      value = await vm.runInContext(source, context, {
        timeout: Math.max(100, Number(limits.syncTimeoutMs) || 5000),
        filename: 'undersilicon-script.js',
      })
    } catch (error) {
      finish(script, 'error', { error: textOf(error) })
      return
    }
    let resultJson
    try {
      resultJson = value === undefined ? undefined : JSON.stringify(value)
    } catch (error) {
      finish(script, 'error', { error: `result is not JSON: ${textOf(error)}` })
      return
    }
    if (typeof resultJson === 'string' && resultJson.length > MAX_RESULT_BYTES) {
      finish(script, 'error', { error: 'script result exceeds 2MB; return a smaller summary' })
      return
    }
    finish(script, 'completed', resultJson === undefined ? {} : { resultJson })
  })()
}

function finish(script, reason, payload = {}) {
  if (script.stopping) return
  const busy = script.api?.busy?.() === true
  post({ type: 'result', scriptId: script.id, reason, ...payload, busy })
  if (!busy) {
    script.stopping = true
    clearScriptTimers(script)
    post({ type: 'stopped', scriptId: script.id, reason })
  }
}

function stopScript(scriptId, reason = 'shutdown') {
  const script = scripts.get(scriptId)
  if (!script) {
    post({ type: 'stopped', scriptId, reason })
    return
  }
  script.stopping = true
  clearScriptTimers(script)
  scripts.delete(scriptId)
  post({ type: 'stopped', scriptId, reason })
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'run') return runScript(message)
  if (message.type === 'shutdown') return stopScript(message.scriptId, message.reason)
  const script = scripts.get(message.scriptId)
  if (!script) return
  if (message.type === 'rpc-result') {
    const entry = script.pending.get(message.id)
    if (!entry) return
    script.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok) entry.onOk(true, message.json)
    else entry.onError(String(message.error || 'RPC failed'))
    return
  }
  if (message.type === 'event') {
    try { script.api.dispatchEvent(message.localId, message.json) } catch { /* context gone */ }
    return
  }
  if (message.type === 'kill') {
    process.exit(0)
  }
})

process.on('disconnect', () => process.exit(0))

const heartbeat = setInterval(() => {
  post({ type: 'heartbeat', scriptIds: [...scripts.keys()] })
}, 250)
heartbeat.unref?.()
