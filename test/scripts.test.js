import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptManager } from '../src/scripts/manager.js'
import { AuditLog } from '../src/safety/audit.js'
import { mergeRanges } from '../src/safety/ranges.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeout = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  throw new Error('timed out waiting for condition')
}

function harness(overrides = {}) {
  const calls = { control: [], operate: [], raw: [], subscribe: [], notify: [] }
  const subscriptions = new Map()
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    devices: async () => [{ id: 'd1', type: 'PJ01', connected: true }],
    device: async (id) => ({ id, type: 'PJ01' }),
    deviceTypeConfig: async () => ({
      capabilities: ['strength'],
      monitorData: [],
      operations: [{ key: 'start', capability: 'strength', action: 'set', input: { value: 255 } }],
    }),
    monitorData: async (id) => ({ deviceId: id, data: {} }),
    games: async () => [], gameStatus: async () => ({ running: false }),
    gameRuntimeStatus: async () => ({ running: false }),
    startGame: async () => ({}), launchClientGame: async () => ({}),
    gameRuntimeParams: async () => ({}), gameRuntimeAction: async () => ({}),
    gameRuntimeStop: async () => ({}), stopCurrentGame: async () => ({}),
    clientState: async () => ({}), clientRoutes: async () => ([]),
    clientWindow: async () => ({}), clientNavigate: async () => ({}),
    clientScreenshot: async () => ({ mime: 'image/png', data: 'AAAA', width: 1, height: 1 }),
  }
  const safety = {
    getMode: async () => 'local',
    getRanges: async () => mergeRanges({}),
    control: async (request) => {
      calls.control.push(request)
      return { ok: true, _scaled: { input: request.input, clamped: [], unscaled: [], percent: 60 }, _mode: 'local' }
    },
    operate: async (request) => {
      calls.operate.push(request)
      return { ok: true, _scaled: { input: request.params, clamped: [], unscaled: [], percent: 60 }, _mode: 'local' }
    },
    raw: async (request) => { calls.raw.push(request); return { ok: true } },
    emergencyStop: async () => ({ ok: true }),
  }
  const events = {
    subscribe(options) {
      calls.subscribe.push(options)
      const id = `sub_${calls.subscribe.length}`
      subscriptions.set(id, options)
      return { id }
    },
    unsubscribe(id) { subscriptions.delete(id); return true },
    unsubscribeOwner(owner) { for (const [id, options] of subscriptions) if (options.ownerId === owner) subscriptions.delete(id) },
    list: () => [...subscriptions.values()],
    recent: async () => [],
  }
  const manager = new ScriptManager({
    client, safety, events, audit: new AuditLog({ enabled: false }),
    config: { scripts: { maxConcurrent: 2, memoryMb: 32, syncTimeoutMs: 1000, heartbeatTimeoutMs: 1500, maxLogs: 50, allowPersist: false, ...overrides } },
    notifyAgent: async (agent, text, wake) => { calls.notify.push({ agent, text, wake }) },
    emergencyStop: async () => ({ ok: true }),
    statusProvider: async () => ({ mode: 'local' }),
    dir: join(tmpdir(), 'dsh-us-test-scripts'),
    ...overrides.managerExtra,
  })
  return { manager, calls, client, safety, events, subscriptions }
}

async function waitStatus(manager, id, statuses, timeout = 6000) {
  return waitFor(() => {
    const script = manager.list().find((item) => item.id === id)
    return script && statuses.includes(script.status) ? script : undefined
  }, timeout)
}

test('a short script completes with its result and logs', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({ code: 'us.log("hello", { n: 1 }); return { value: 42 }', sessionId: 's1' })
  const done = await waitStatus(h.manager, started.id, ['completed'])
  assert.deepEqual(done.result, { value: 42 })
  assert.ok(done.logs.some((line) => line.text.includes('hello')))
})

test('sandbox has no require, process or host-realm Function escape', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const code = `
    const probe = {
      process: typeof process,
      require: typeof require,
      globalProcess: typeof globalThis.process,
      hostFunction: (() => { try { return us.devices.constructor.constructor("return process")() ? "escaped" : "undefined" } catch { return "blocked" } })(),
      evalEscape: (() => { try { const f = Function("return process"); return f() ? "escaped" : "undefined" } catch { return "blocked" } })(),
    }
    return probe
  `
  const started = await h.manager.run({ code, sessionId: 's1', agent: {} })
  const done = await waitStatus(h.manager, started.id, ['completed', 'error'])
  assert.equal(done.status, 'completed', done.lastError)
  assert.deepEqual(done.result, {
    process: 'undefined', require: 'undefined', globalProcess: 'undefined',
    hostFunction: 'blocked', evalEscape: 'blocked',
  })
})

test('us.* RPC reaches the host bridge and returns JSON data', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const code = `
    const devices = await us.devices({ connected: true })
    const detail = await us.device("d1")
    const result = await us.control("d1", "strength", "set", { value: 200 })
    return { count: devices.length, type: detail.device.type, ok: result.ok }
  `
  const started = await h.manager.run({ code, sessionId: 's1', agent: {} })
  const done = await waitStatus(h.manager, started.id, ['completed', 'error'])
  assert.equal(done.status, 'completed', done.lastError)
  assert.deepEqual(done.result, { count: 1, type: 'PJ01', ok: true })
  assert.equal(h.calls.control.length, 1)
  assert.equal(h.calls.control[0].input.value, 200)
})

test('event listeners stay resident and us.notify wakes the agent', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const code = `
    us.on("device.updated", (event) => {
      us.state.hits = (us.state.hits || 0) + 1
      if (event.data && event.data.heart_rate > 150) us.notify("heart rate high", { wake: true })
    }, { deviceId: "hr-1", throttleMs: 500 })
  `
  const started = await h.manager.run({ code, sessionId: 's1', agent: {} })
  await waitFor(() => h.calls.subscribe.length > 0)
  const subscription = h.calls.subscribe[0]
  subscription.onEvent({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 180 } })
  await waitFor(() => h.calls.notify.length > 0)
  assert.equal(h.calls.notify[0].wake, true)
  assert.match(h.calls.notify[0].text, /heart rate high/)
  assert.equal(h.manager.list().find((item) => item.id === started.id).status, 'running')
})

test('a synchronous infinite loop is killed by the vm timeout', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({ code: 'while (true) {}', sessionId: 's1' })
  const done = await waitStatus(h.manager, started.id, ['error'], 5000)
  assert.match(done.lastError, /timed out/i)
})

test('a post-await infinite loop is killed by the heartbeat watchdog', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({ code: 'await us.sleep(10); while (true) {}', sessionId: 's1' })
  const done = await waitStatus(h.manager, started.id, ['error'], 6000)
  assert.match(done.lastError, /heartbeat|blocked/i)
})

test('concurrency limit rejects a third script', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const first = await h.manager.run({ code: 'us.every(1000, () => {})', sessionId: 's1' })
  const second = await h.manager.run({ code: 'us.every(1000, () => {})', sessionId: 's1' })
  await waitFor(() => h.manager.running().length === 2)
  await assert.rejects(
    h.manager.run({ code: 'return 1', sessionId: 's1' }),
    /too many running scripts/,
  )
  assert.ok(first.id && second.id)
})

test('us.stop ends a resident script', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({
    code: 'us.every(500, () => {}); us.after(100, () => us.stop())', sessionId: 's1',
  })
  const done = await waitStatus(h.manager, started.id, ['stopped'])
  assert.equal(done.status, 'stopped')
})

test('script logs are capped by the ring buffer', async (t) => {
  const h = harness()
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({
    code: 'for (let i = 0; i < 120; i += 1) us.log("line", i)', sessionId: 's1',
  })
  const done = await waitStatus(h.manager, started.id, ['completed'])
  assert.ok(done.logs.length <= 50)
})

test('persisted scripts survive a manager restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-us-persist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const h = harness({ allowPersist: true })
  h.manager.dir = dir
  const started = await h.manager.run({
    code: 'us.every(500, () => {})', sessionId: 's1', persist: true, name: 'persisted-demo',
  })
  await waitFor(() => h.manager.running().length === 1)
  await h.manager.savePersisted()
  h.manager.dispose()
  const next = new ScriptManager({
    client: h.client, safety: h.safety, events: h.events, audit: new AuditLog({ enabled: false }),
    config: { scripts: { allowPersist: true, memoryMb: 32, maxConcurrent: 2, syncTimeoutMs: 1000, heartbeatTimeoutMs: 1500 } },
    dir,
  })
  t.after(() => next.dispose())
  const restored = await next.restore()
  assert.equal(restored.length, 1)
  assert.equal(restored[0].name, 'persisted-demo')
  assert.equal(next.running().length, 1)
  assert.ok(started.id)
})

test('worker memory cap stops a runaway allocation', async (t) => {
  const h = harness({ memoryMb: 16 })
  t.after(() => h.manager.dispose())
  const started = await h.manager.run({
    code: 'await us.sleep(10); const junk = []; for (;;) junk.push(new Array(1000000).fill(1))',
    sessionId: 's1',
  })
  const done = await waitStatus(h.manager, started.id, ['error'], 8000)
  assert.match(done.lastError, /memory|worker|exited|heartbeat|blocked/i)
})
