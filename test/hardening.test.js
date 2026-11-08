import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient } from '../src/sdk/client.js'
import { SafetyLayer } from '../src/safety/safety.js'
import { Watchdog } from '../src/safety/watchdog.js'
import { AgentLease } from '../src/safety/lease.js'
import { AuditLog } from '../src/safety/audit.js'
import { EventManager } from '../src/events/manager.js'
import { ScriptManager } from '../src/scripts/manager.js'
import { classifyRawWrite, classifyRawRead } from '../src/safety/whitelist.js'
import { scaleCapabilityInput } from '../src/safety/scale.js'
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

function leaseHarness(client) {
  const audit = new AuditLog({ enabled: false })
  const watchdog = new Watchdog({ client, ttlSeconds: 5 })
  const lease = new AgentLease({
    client, ttlSeconds: 5, limits: { default: 60, capabilities: { shock: 30 } },
  })
  const safety = new SafetyLayer({
    client, config: { limits: { default: 60, capabilities: { shock: 30 } } }, audit, watchdog, lease,
  })
  return { audit, watchdog, lease, safety }
}

test('a device write carries X-Agent-Client and creates a lease with the configured limits', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const h = leaseHarness(client)
  t.after(() => h.watchdog.dispose())
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool', name: 'device_control' },
    deviceId: 'pj-1', capability: 'strength', action: 'set', input: { value: 200 },
  })
  assert.equal(result._scaled.input.value, 120)
  const write = mock.state.requests.filter((item) => item.path.endsWith('/capabilities/strength/actions/set')).at(-1)
  assert.equal(write.headers['x-agent-client'], 'dsh-s1')
  assert.ok(mock.state.leases.has('dsh-s1'))
  assert.deepEqual(mock.state.leases.get('dsh-s1').limits.capabilities, {
    strength: 60, shock: 30, vibration: 60, suction: 60, estim: 60, motors: 60, pump: 60,
  })
  assert.ok(result._backendFieldCaps)
})

test('settings changes push new limits immediately and session end releases the lease', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const h = leaseHarness(client)
  t.after(() => h.watchdog.dispose())
  await h.lease.ensure('s1')
  h.lease.setLimits({ default: 20, capabilities: { shock: 5 } })
  await waitFor(() => mock.state.requests.filter((item) => item.path === '/api/agent-control/lease'
    && item.body?.limits?.default === 20).length > 0)
  assert.equal(mock.state.leases.get('dsh-s1').limits.capabilities.shock, 5)
  assert.equal(await h.lease.release('s1'), true)
  assert.equal(mock.state.leases.has('dsh-s1'), false)
  assert.equal(await h.lease.release('s1'), false)
})

test('an old client without agent-control is refused before any device write', async (t) => {
  const calls = { control: 0, lease: 0 }
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    forSession() { return this },
    remoteStatus: async () => ({ active: false }),
    deviceCapabilities: async () => ({}),
    watchdogHeartbeat: async () => ({ ok: true }),
    agentLeaseCreate: async () => { calls.lease += 1; const error = new Error('not found'); error.status = 404; throw error },
    control: async () => { calls.control += 1; return { ok: true } },
  }
  const h = leaseHarness(client)
  await assert.rejects(h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'd1',
    capability: 'strength', action: 'set', input: { value: 10 },
  }), (error) => error.code === 'AGENT_LEASE_UNSUPPORTED' && /升级/.test(error.message))
  assert.equal(calls.control, 0)
  assert.equal(calls.lease, 1)
  // The unsupported state is sticky: the next control fails fast without another lease call.
  await assert.rejects(h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'd1',
    capability: 'strength', action: 'set', input: { value: 10 },
  }), (error) => error.code === 'AGENT_LEASE_UNSUPPORTED')
  assert.equal(calls.lease, 1)
})

test('a 428 rebuilds the lease once and retries the same write', async () => {
  let attempts = 0
  let leases = 0
  const sent = []
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    forSession() { return this },
    remoteStatus: async () => ({ active: false }),
    deviceCapabilities: async () => ({}),
    watchdogHeartbeat: async () => ({ ok: true }),
    agentLeaseCreate: async () => {
      leases += 1
      return { ok: true, fieldCaps: { power: 153 } }
    },
    control: async (_id, _cap, _action, input) => {
      attempts += 1
      sent.push(input)
      if (attempts === 1) { const error = new Error('lease required'); error.status = 428; error.code = 'AGENT_LEASE_REQUIRED'; throw error }
      return { ok: true }
    },
  }
  const h = leaseHarness(client)
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'd1',
    capability: 'strength', action: 'set', input: { value: 100 },
  })
  assert.equal(result.ok, true)
  assert.equal(attempts, 2)
  assert.equal(leases, 2)
  assert.deepEqual(sent, [{ value: 100 }, { value: 100 }])
})

test('GET reads are limited to the agent whitelist and SSRF/probing reads are denied', () => {
  for (const path of [
    '/devices', '/devices/pj-1', '/devices/pj-1/monitor-data', '/device-capabilities',
    '/device-types/PJ01/config', '/games', '/games/status', '/games/demo', '/games/demo/meta',
    '/game-runtime/status', '/client/state', '/client/routes', '/events/recent',
    '/remote-session/status', '/brands/status', '/voice/status',
  ]) {
    assert.equal(classifyRawWrite('GET', path.toLowerCase()).kind, 'read', path)
  }
  for (const path of [
    '/games/external/meta', '/brands/discover', '/auth/status', '/models/settings',
    '/logs/current', '/test/provision', '/virtual-devices', '/mqtt-client/status',
    '/serial/settings', '/network/interfaces', '/events/stream', '/agent-control/status',
  ]) {
    assert.throws(() => classifyRawRead(path), (error) => error.code === 'ENDPOINT_BLOCKED', path)
  }
})

test('a GET through us.api with an omitted body sends no request body', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const h = leaseHarness(client)
  t.after(() => h.watchdog.dispose())
  const devices = await h.safety.raw({
    sessionId: 's1', source: { kind: 'script' }, method: 'GET', path: '/devices', body: null,
  })
  assert.ok(Array.isArray(devices))
  const read = mock.state.requests.filter((item) => item.path === '/api/devices').at(-1)
  assert.equal(read.method, 'GET')
  assert.deepEqual(read.body, {})
})

test('motors dot keys/prototype keys/arrays and non-numeric intensity values are refused', () => {
  const ranges = mergeRanges({})
  const limits = { default: 60, capabilities: { shock: 30 } }
  const cases = [
    ['motors', 'set', JSON.parse('{"channels":{"a.value":255}}')],
    ['motors', 'set', JSON.parse('{"channels":{"__proto__":{"value":255}}}')],
    ['motors', 'set', JSON.parse('{"channels":{"constructor":{"value":255}}}')],
    ['motors', 'set', { channels: [{ value: 255 }] }],
    ['motors', 'set', { channels: { a: { value: 255, direction: 99 } } }],
    ['motors', 'set', { channels: { a: { value: true } } }],
    ['strength', 'set', { value: true }],
    ['strength', 'set', { value: {} }],
    ['strength', 'set', { value: [] }],
    ['pump', 'start', { rate: true, ss: true }],
  ]
  for (const [capability, action, input] of cases) {
    assert.throws(() => scaleCapabilityInput({ capability, action, input, limits, ranges }),
      (error) => error.code === 'INVALID_INTENSITY_VALUE' || error.code === 'UNKNOWN_INTENSITY_FIELD',
      `${capability}.${action} ${JSON.stringify(input)}`)
  }
  assert.throws(() => scaleCapabilityInput({
    capability: 'motors', action: 'set', input: { channels: { a: 100 } }, limits, ranges, deviceType: 'YCY_CUP',
  }), (error) => error.code === 'UNKNOWN_CHANNEL' && /stroke, vibe, axis/.test(error.message))
  const ok = scaleCapabilityInput({
    capability: 'motors', action: 'set', input: { channels: { stroke: { value: 200, direction: 1 } } },
    limits, ranges, deviceType: 'YCY_CUP',
  })
  assert.equal(ok.input.channels.stroke.value, 153)
})

test('a translated operation pre-scales every action and stops what it already sent on failure', async () => {
  const calls = []
  let count = 0
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    forSession() { return this },
    remoteStatus: async () => ({ active: false }),
    deviceCapabilities: async () => ({}),
    watchdogHeartbeat: async () => ({ ok: true }),
    agentLeaseCreate: async () => ({ ok: true, fieldCaps: {} }),
    control: async (_id, capability, action, input) => {
      calls.push(`${capability}.${action}:${JSON.stringify(input)}`)
      count += 1
      if (count === 2) { const error = new Error('second action failed'); error.status = 500; throw error }
      return { ok: true }
    },
  }
  const h = leaseHarness(client)
  await assert.rejects(h.safety.operate({
    sessionId: 's1', source: { kind: 'tool', name: 'device_control' },
    deviceId: 'cz-1', operation: 'start', params: {},
    definition: { key: 'start', invoke: true }, deviceType: 'CUNZHI01',
  }), (error) => {
    assert.deepEqual(error.details.compensatingStops, ['shock'])
    return true
  })
  assert.deepEqual(calls, [
    'shock.start:{"voltage":24}',
    'strength.set:{"value":153}',
    'shock.stop:{}',
  ])
})

test('raw stop-all and remote emergency run the full in-plugin emergency flow', async () => {
  const calls = []
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    forSession() { return this },
    remoteStatus: async () => ({ active: false }),
    deviceCapabilities: async () => ({}),
    watchdogHeartbeat: async () => ({ ok: true }),
    agentLeaseCreate: async () => ({ ok: true }),
    stopAll: async () => { calls.push('stop-all'); return { ok: true } },
    emergencyStopRemote: async () => { calls.push('remote-stop'); return { ok: true } },
    stopCurrentGame: async () => { calls.push('stop-current'); return { ok: true } },
    gameRuntimeStop: async () => { calls.push('runtime-stop'); return { ok: true } },
  }
  const h = leaseHarness(client)
  const hooks = { scripts: 0, subscriptions: 0, watchdog: [] }
  h.safety.setEmergencyHooks({
    stopScripts: () => { hooks.scripts += 1 },
    stopSubscriptions: () => { hooks.subscriptions += 1 },
    stopWatchdog: (sessionId) => hooks.watchdog.push(sessionId),
  })
  const result = await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool', name: 'panel_api' },
    method: 'POST', path: '/device-watchdog/stop-all', body: { reason: 'raw test' },
  })
  assert.equal(result.ok, true)
  assert.ok(calls.includes('stop-all'))
  assert.ok(calls.includes('stop-current'))
  assert.ok(calls.includes('runtime-stop'))
  assert.equal(hooks.scripts, 1)
  assert.equal(hooks.subscriptions, 1)
  assert.deepEqual(hooks.watchdog, ['s1'])
})

function scriptHarness({ maxConcurrent = 8, maxSessions = 4, heartbeatTimeoutMs = 1500 } = {}) {
  const dir = join(tmpdir(), `dsh-us-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const audit = new AuditLog({ enabled: false })
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    devices: async () => [], device: async (id) => ({ id, type: 'PJ01' }),
    deviceTypeConfig: async () => ({ capabilities: [], operations: [] }),
    monitorData: async () => ({}), games: async () => [], gameStatus: async () => ({}),
    gameRuntimeStatus: async () => ({}),
  }
  const safety = { getMode: async () => 'local', getRanges: async () => mergeRanges({}) }
  const events = new EventManager({ client, config: { events: {} }, audit })
  const scripts = new ScriptManager({
    client, safety, events, audit,
    config: { scripts: { maxConcurrent, maxSessions, memoryMb: 32, syncTimeoutMs: 2000, heartbeatTimeoutMs, maxLogs: 50, allowPersist: false } },
    dir, notifyAgent: async () => {}, emergencyStop: async () => ({ ok: true }), statusProvider: async () => ({}),
  })
  return { scripts, events, dir }
}

test('script logs/stops and subscription cancels are limited to the calling session', async (t) => {
  const h = scriptHarness()
  t.after(async () => { h.scripts.dispose(); h.events.dispose(); await rm(h.dir, { recursive: true, force: true }) })
  const a = await h.scripts.run({ code: 'setInterval(() => {}, 1000); await us.sleep(60000)', name: 'A-loop', sessionId: 'A' })
  await waitFor(() => h.scripts.workers.get(a.id)?.status === 'running')
  assert.equal(h.scripts.list({ sessionId: 'B' }).length, 0)
  assert.equal(h.scripts.logs(a.id, 10, { sessionId: 'B' }), null)
  assert.equal(h.scripts.stop(a.id, 'cross-session', { sessionId: 'B' }), false)
  assert.ok(h.scripts.logs(a.id, 10, { sessionId: 'A' }))
  assert.equal(h.scripts.list({ sessionId: 'A' }).length, 1)

  const sub = h.events.subscribe({ kind: 'agent', ownerId: 'A', agent: { inject() {}, followup() {} }, types: ['device.updated'], throttleMs: 500 })
  assert.equal(h.events.unsubscribe(sub.id, { ownerId: 'B' }), false)
  assert.equal(h.events.unsubscribe(sub.id, { ownerId: 'A' }), true)
  h.scripts.stop(a.id, 'cleanup', { sessionId: 'A' })
})

test('a runaway script only kills its own session sandbox', async (t) => {
  const h = scriptHarness()
  t.after(async () => { h.scripts.dispose(); h.events.dispose(); await rm(h.dir, { recursive: true, force: true }) })
  const runaway = await h.scripts.run({
    code: 'await us.sleep(10); while (true) {}', name: 'runaway', sessionId: 'A',
  })
  const bystander = await h.scripts.run({
    code: 'return 42', name: 'bystander', sessionId: 'B',
  })
  const doneB = await waitFor(() => {
    const info = h.scripts.list({ sessionId: 'B' }).find((item) => item.id === bystander.id)
    return info && !['starting', 'running'].includes(info.status) ? info : undefined
  }, 4000)
  assert.equal(doneB.status, 'completed')
  assert.equal(doneB.result, 42)
  const doneA = await waitFor(() => {
    const info = h.scripts.list({ sessionId: 'A' }).find((item) => item.id === runaway.id)
    return info && !['starting', 'running'].includes(info.status) ? info : undefined
  }, 9000)
  assert.equal(doneA.status, 'error')
  assert.match(doneA.lastError, /heartbeat|blocked/i)
})

test('a global cap limits the number of sandbox child processes', async (t) => {
  const h = scriptHarness({ maxSessions: 1 })
  t.after(async () => { h.scripts.dispose(); h.events.dispose(); await rm(h.dir, { recursive: true, force: true }) })
  const a = await h.scripts.run({ code: 'setInterval(() => {}, 1000); await us.sleep(60000)', sessionId: 'A' })
  await waitFor(() => h.scripts.workers.get(a.id)?.status === 'running')
  await assert.rejects(
    h.scripts.run({ code: 'return 1', sessionId: 'B' }),
    /too many script sandbox processes/,
  )
  h.scripts.stop(a.id, 'cleanup')
})

test('scripts cannot reach fetch, WebSocket or EventSource', async (t) => {
  const h = scriptHarness()
  t.after(async () => { h.scripts.dispose(); h.events.dispose(); await rm(h.dir, { recursive: true, force: true }) })
  const started = await h.scripts.run({
    code: `return {
      fetch: typeof fetch, WebSocket: typeof WebSocket, EventSource: typeof EventSource,
      XMLHttpRequest: typeof XMLHttpRequest, navigator: typeof navigator,
      globalFetch: typeof globalThis.fetch,
      net: await (async () => { try { await fetch('http://127.0.0.1:1'); return 'reachable' } catch (error) { return 'blocked' } })(),
    }`, sessionId: 'A',
  })
  const done = await waitFor(() => {
    const info = h.scripts.list({ sessionId: 'A' }).find((item) => item.id === started.id)
    return info && !['starting', 'running'].includes(info.status) ? info : undefined
  }, 5000)
  assert.equal(done.status, 'completed', done.lastError)
  assert.deepEqual(done.result, {
    fetch: 'undefined', WebSocket: 'undefined', EventSource: 'undefined',
    XMLHttpRequest: 'undefined', navigator: 'undefined', globalFetch: 'undefined',
    net: 'blocked',
  })
})


test('event quotas are per session with a separate plugin-wide cap', () => {
  const h = scriptHarness()
  h.events.config = { events: { maxSubscriptions: 2, maxTotalSubscriptions: 4 } }
  const make = (owner) => h.events.subscribe({ kind: 'agent', ownerId: owner, agent: { inject() {}, followup() {} }, types: ['device.updated'], throttleMs: 500 })
  make('A'); make('A')
  assert.throws(() => make('A'), /2 subscriptions/)
  make('B'); make('B')
  assert.throws(() => make('C'), /max 4/)
  h.events.dispose()
})




