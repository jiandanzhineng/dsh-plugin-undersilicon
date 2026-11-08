import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient } from '../src/sdk/client.js'
import { SafetyLayer } from '../src/safety/safety.js'
import { AuditLog } from '../src/safety/audit.js'
import { Watchdog } from '../src/safety/watchdog.js'
import { SettingsStore } from '../src/settings.js'
import { createPanelHandler } from '../src/client-rpc.js'
import { scaleCapabilityInput } from '../src/safety/scale.js'
import { mergeRanges } from '../src/safety/ranges.js'
import { SafetyError } from '../src/util/errors.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function harness({ mode = 'local', limits = { default: 60, capabilities: { shock: 30 } } } = {}) {
  const mock = await createMockServer({ mode }).start()
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const audit = new AuditLog({ enabled: false })
  const watchdog = new Watchdog({ client, ttlSeconds: 30 })
  const safety = new SafetyLayer({
    client, config: { limits, stopOnSessionEnd: true }, audit, watchdog,
  })
  return { mock, client, audit, watchdog, safety }
}

test('path variants cannot reach blocked writes (case, dot, trailing, encoded)', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const variants = [
    '/API/Devices/pj-1/Message',
    '/devices/pj-1/./message',
    '/devices/pj-1/message/',
    '/devices/pj-1/%2e/message',
    '/api/api/devices/pj-1/message',
  ]
  for (const path of variants) {
    await assert.rejects(
      h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path, body: { message: {} } }),
      (error) => error instanceof SafetyError && error.code === 'ENDPOINT_BLOCKED',
      path,
    )
  }
  assert.equal(h.mock.state.requests.some((request) => request.path.toLowerCase().includes('/message')), false)
  await assert.rejects(
    h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path: '/devices/x/%2fmessage', body: {} }),
    /encoded or literal slashes/,
  )
})

test('test, remote and virtual-device writes stay blocked; rename is body-whitelisted', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const blocked = [
    ['POST', '/test/start', {}],
    ['POST', '/test/device/pj-1/start', {}],
    ['POST', '/remote-projection/create', {}],
    ['POST', '/remote-game/command', {}],
    ['POST', '/virtual-devices/batch', {}],
    ['POST', '/virtual-devices/emit', {}],
    ['POST', '/devices/batch/operations', {}],
    ['DELETE', '/devices/pj-1', {}],
  ]
  for (const [method, path, body] of blocked) {
    await assert.rejects(
      h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method, path, body }),
      (error) => error instanceof SafetyError,
      `${method} ${path}`,
    )
  }
  await assert.rejects(
    h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method: 'PATCH', path: '/devices/pj-1', body: { power: 255 } }),
    (error) => error.code === 'UNSAFE_DEVICE_PATCH',
  )
  await h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method: 'PATCH', path: '/devices/pj-1', body: { name: 'renamed' } })
  const patch = h.mock.state.requests.filter((request) => request.method === 'PATCH').at(-1)
  assert.deepEqual(patch.body, { name: 'renamed' })
  assert.equal(h.audit.recent(1)[0].sessionId, 's1')
})

test('numeric strings are parsed, unknown intensity fields and NaN are refused', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1',
    capability: 'strength', action: 'set', input: { value: '200' },
  })
  assert.equal(result._scaled.input.value, 120)
  assert.equal(typeof result._scaled.input.value, 'number')
  await assert.rejects(
    h.safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1',
      capability: 'strength', action: 'set', input: { value: 50, power: 255 },
    }),
    (error) => error.code === 'UNKNOWN_INTENSITY_FIELD',
  )
  await assert.rejects(
    h.safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1',
      capability: 'strength', action: 'set', input: { value: 'abc' },
    }),
    (error) => error.code === 'INVALID_INTENSITY_VALUE',
  )
  await assert.rejects(
    h.safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1',
      capability: 'strength', action: 'set', input: { value: NaN },
    }),
    (error) => error.code === 'INVALID_INTENSITY_VALUE',
  )
})

test('pump.ss is scaled and integer caps floor instead of rounding up', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1',
    capability: 'pump', action: 'start', input: { rate: '255', ss: '255' },
  })
  assert.equal(result._scaled.input.rate, 153)
  assert.equal(result._scaled.input.ss, 153)
  const floored = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 255 },
    limits: { default: 30 }, ranges: mergeRanges({}),
  })
  assert.equal(floored.input.value, 76)
  assert.equal(floored.clamped[0].limit, 76.5)
})

test('shock.start always sends explicit scaled voltage and refuses below 1V', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'di-1',
    capability: 'shock', action: 'start', input: {},
  })
  assert.equal(result._scaled.input.voltage, 24)
  const sent = h.mock.state.requests.filter((request) => request.path.includes('/capabilities/shock/actions/start')).at(-1)
  assert.deepEqual(sent.body, { input: { voltage: 24 } })
  await assert.rejects(
    h.safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'di-1',
      capability: 'shock', action: 'start', input: { voltage: 0 },
    }),
    (error) => error.code === 'INTENSITY_BELOW_MINIMUM',
  )
  const zero = await harness({ limits: { default: 0, capabilities: {} } })
  t.after(() => zero.mock.close())
  await assert.rejects(
    zero.safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'di-1',
      capability: 'shock', action: 'start', input: { voltage: 80 },
    }),
    (error) => error.code === 'INTENSITY_BELOW_MINIMUM',
  )
})

test('raw capability rejects input+params and sends only the scaled input field', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  await assert.rejects(
    h.safety.raw({
      sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path: '/devices/pj-1/capabilities/strength/actions/set',
      body: { input: { value: 0 }, params: { value: 255 } },
    }),
    (error) => error.code === 'AMBIGUOUS_BODY',
  )
  const result = await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path: '/devices/pj-1/capabilities/strength/actions/set',
    body: { params: { value: '200' } },
  })
  assert.equal(result._scaled.input.value, 120)
  const sent = h.mock.state.requests.filter((request) => request.path.endsWith('/capabilities/strength/actions/set')).at(-1)
  assert.deepEqual(sent.body, { input: { value: 120 } })
})

test('raw operations merge defaults, translate invoke operations and reject unsafe ones', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/devices/cz-1/operations/start', body: { params: { voltage: 99 } },
  })
  const shock = h.mock.state.requests.filter((request) => request.path.includes('/cz-1/capabilities/shock/actions/start')).at(-1)
  const strength = h.mock.state.requests.filter((request) => request.path.includes('/cz-1/capabilities/strength/actions/set')).at(-1)
  assert.deepEqual(shock.body, { input: { voltage: 24 } })
  assert.deepEqual(strength.body, { input: { value: 120 } })

  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/devices/enema-1/operations/pumpStart', body: { params: { rate: 255, ss: 255 } },
  })
  const pump = h.mock.state.requests.filter((request) => request.path.includes('/enema-1/capabilities/pump/actions/start')).at(-1)
  assert.deepEqual(pump.body, { input: { rate: 153, ss: 153 } })

  await assert.rejects(
    h.safety.raw({
      sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
      path: '/devices/enema-1/operations/trigger', body: { params: { commandId: 'x' } },
    }),
    (error) => error.code === 'OPERATION_NOT_SAFE',
  )

  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/devices/pj-1/operations/stop', body: { params: { value: 200 } },
  })
  const stop = h.mock.state.requests.filter((request) => request.path.includes('/pj-1/operations/stop')).at(-1)
  assert.deepEqual(stop.body, { params: { value: 0 } })
})

test('game parameters are scaled and unknown intensity params are refused', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const started = await h.safety.gameStart({
    sessionId: 's1', source: { kind: 'tool' }, gameId: 'demo', launch: false,
    parameters: { maxMotorIntensity: 255, shockVoltage: 80, speed: 5, duration: 20 },
  })
  assert.equal(started._scaled.parameters.maxMotorIntensity, 120)
  assert.equal(started._scaled.parameters.shockVoltage, 30)
  assert.equal(started._scaled.parameters.speed, 5)

  const changed = await h.safety.gameParams({
    sessionId: 's1', source: { kind: 'tool' }, gameId: 'demo',
    params: { maxMotorIntensity: '255', shockVoltage: 80, duration: 30 },
  })
  assert.deepEqual(
    { motor: changed._scaled.parameters.maxMotorIntensity, shock: changed._scaled.parameters.shockVoltage },
    { motor: 120, shock: 30 },
  )
  await assert.rejects(
    h.safety.gameParams({ sessionId: 's1', source: { kind: 'tool' }, gameId: 'demo', params: { percent: 100 } }),
    (error) => error.code === 'UNKNOWN_GAME_INTENSITY_PARAM',
  )

  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/client/games/demo/launch', body: { parameters: { maxMotorIntensity: 255 } },
  })
  const launch = h.mock.state.requests.filter((request) => request.path === '/api/client/games/demo/launch').at(-1)
  assert.equal(launch.body.parameters.maxMotorIntensity, 120)

  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/games/demo/start', body: { parameters: { maxMotorIntensity: 255 } },
  })
  const start = h.mock.state.requests.filter((request) => request.path === '/api/games/demo/start').at(-1)
  assert.equal(start.body.parameters.maxMotorIntensity, 120)

  await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
    path: '/game-runtime/params', body: { params: { shockVoltage: 80 } },
  })
  const params = h.mock.state.requests.filter((request) => request.path === '/api/game-runtime/params').at(-1)
  assert.equal(params.body.params.shockVoltage, 30)

  await assert.rejects(
    h.safety.raw({
      sessionId: 's1', source: { kind: 'tool' }, method: 'POST',
      path: '/games/demo/start', body: { gamePath: 'https://evil.example/app' },
    }),
    (error) => error.code === 'UNSAFE_BODY',
  )
})

test('panel latch refuses every control path until the panel resumes', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  h.safety.halt({ reason: 'panel test', latch: true })
  const latch = (error) => error.code === 'EMERGENCY_LATCHED'
  await assert.rejects(h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1', capability: 'strength', action: 'set', input: { value: 10 },
  }), latch)
  await assert.rejects(h.safety.raw({
    sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path: '/devices/pj-1/nickname', body: { nickname: 'x' },
  }), latch)
  await assert.rejects(h.safety.gameStart({
    sessionId: 's1', source: { kind: 'tool' }, gameId: 'demo', parameters: {},
  }), latch)
  const stop = await h.safety.emergencyStop({ sessionId: 's1', source: { kind: 'tool' }, reason: 'stop while latched' })
  assert.equal(stop.ok, true)
  h.safety.resume({ sessionId: 'panel', source: { kind: 'panel' } })
  const allowed = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'pj-1', capability: 'strength', action: 'set', input: { value: 10 },
  })
  assert.equal(allowed._scaled.input.value, 10)
})

test('emergency halt aborts in-flight work and prevents a late command from being sent', async (t) => {
  const audit = new AuditLog({ enabled: false })
  const order = []
  let releaseRanges
  const rangesGate = new Promise((resolve) => { releaseRanges = resolve })
  let controlCalled = false
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    deviceCapabilities: async () => { await rangesGate; return {} },
    control: async () => { controlCalled = true; return { ok: true } },
    operate: async () => ({ ok: true }),
    gameRuntimeStatus: async () => ({ gameId: 'demo' }),
    stopAll: async () => { order.push('stop-all'); return { ok: true } },
    emergencyStopRemote: async () => { order.push('remote-stop'); return { ok: true } },
    stopCurrentGame: async () => { order.push('stop-current'); return { ok: true } },
    gameRuntimeStop: async () => { order.push('runtime-stop'); return { ok: true } },
    remoteStatus: async () => ({ active: false }),
  }
  const safety = new SafetyLayer({
    client, config: { limits: { default: 60 } }, audit,
    watchdog: { touch: async () => ({ ok: true }) },
  })
  const pending = safety.control({
    sessionId: 's1', source: { kind: 'tool' }, deviceId: 'd1', capability: 'strength', action: 'set', input: { value: 10 },
  })
  await safety.emergencyStop({ sessionId: 's1', source: { kind: 'tool' }, reason: 'race' })
  releaseRanges()
  await assert.rejects(pending, (error) => error.code === 'EMERGENCY_STOP')
  assert.equal(controlCalled, false)
  assert.equal(order[0], 'stop-all')
  assert.ok(order.includes('stop-current'))
  assert.ok(order.includes('runtime-stop'))
})

test('emergency stop retries every step and reports per-step failures', async (t) => {
  const audit = new AuditLog({ enabled: false })
  let stopAllAttempts = 0
  let runtimeCalls = 0
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    lastMode: 'local',
    remoteStatus: async () => { client.lastMode = 'local'; return { active: false } },
    stopAll: async () => {
      stopAllAttempts += 1
      if (stopAllAttempts < 3) {
        const error = new Error('stop-all busy')
        error.status = 500
        throw error
      }
      return { ok: true }
    },
    stopCurrentGame: async () => {
      const error = new Error('game stop failed')
      error.status = 500
      throw error
    },
    gameRuntimeStop: async () => { runtimeCalls += 1; return { ok: true } },
  }
  const safety = new SafetyLayer({
    client, config: { limits: { default: 60 } }, audit,
    watchdog: { touch: async () => ({ ok: true }) },
  })
  const stop = await safety.emergencyStop({
    sessionId: 's1', source: { kind: 'tool' }, reason: 'retry test',
  })
  assert.equal(stopAllAttempts, 3)
  assert.equal(stop.ok, false)
  assert.equal(runtimeCalls, 1)
  const stopAll = stop.results.find((item) => item.name === 'device-watchdog/stop-all')
  const game = stop.results.find((item) => item.name === 'games/stop-current')
  assert.deepEqual({ ok: stopAll.ok, attempts: stopAll.attempts }, { ok: true, attempts: 3 })
  assert.deepEqual({ ok: game.ok, attempts: game.attempts, status: game.status }, { ok: false, attempts: 3, status: 500 })
})

test('watchdog lease failure before a control refuses to send the command', async (t) => {
  const audit = new AuditLog({ enabled: false })
  let called = false
  const client = {
    baseUrl: 'http://127.0.0.1:1/api',
    deviceCapabilities: async () => ({}),
    control: async () => { called = true; return { ok: true } },
    remoteStatus: async () => ({ active: false }),
  }
  const safety = new SafetyLayer({
    client, config: { limits: { default: 60 } }, audit,
    watchdog: { touch: async () => ({ ok: false, error: 'backend down' }) },
  })
  await assert.rejects(
    safety.control({
      sessionId: 's1', source: { kind: 'tool' }, deviceId: 'd1',
      capability: 'strength', action: 'set', input: { value: 10 },
    }),
    (error) => error.code === 'WATCHDOG_UNAVAILABLE',
  )
  assert.equal(called, false)
})

test('panel endpoints expose settings/resume; no agent tool can do either', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-us-panel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new SettingsStore({
    file: join(dir, 'settings.json'),
    config: { limits: { default: 60, capabilities: { shock: 30 } }, watchdogTtlSec: 30, scripts: { allowPersist: false } },
  })
  let applied = 0
  const handler = createPanelHandler({
    status: async () => ({}),
    audit: new AuditLog({ enabled: false }),
    scripts: { list: () => [], logs: () => null, stop: () => false },
    events: { list: () => [], unsubscribe: () => false },
    emergencyStop: async () => ({ ok: true, latched: true }),
    emergencyResume: async () => ({ latched: false }),
    updateSettings: async (patch) => { applied += 1; return store.update(patch) },
    getSettings: async () => store.snapshot(),
  })
  const saved = await handler('settings.set', { limits: { default: 35 } })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.limits.default, 35)
  assert.equal(store.applyTo().limits.default, 35)
  assert.equal(applied, 1)
  const resumed = await handler('emergency.resume', {})
  assert.equal(resumed.ok, true)
  assert.equal(resumed.value.latched, false)
  assert.equal((await handler('settings.set', { limits: { default: 999 } })).ok, false)
})

test('settings file overrides profile config, validates and applies immediately', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-us-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')
  const store = new SettingsStore({
    file,
    config: { limits: { default: 60, capabilities: { shock: 30, strength: 60 } }, stopOnSessionEnd: true, watchdogTtlSec: 30, scripts: { allowPersist: false } },
  })
  assert.equal(store.applyTo().limits.default, 60)
  await store.update({ limits: { default: 45, capabilities: { shock: 10 } }, stopOnSessionEnd: false, watchdogTtlSec: 60, scripts: { allowPersist: true } })
  const effective = store.applyTo()
  assert.equal(effective.limits.default, 45)
  assert.equal(effective.limits.capabilities.shock, 10)
  assert.equal(effective.limits.capabilities.strength, 60)
  assert.equal(effective.stopOnSessionEnd, false)
  assert.equal(effective.watchdogTtlSec, 60)
  assert.equal(effective.scripts.allowPersist, true)
  await assert.rejects(store.update({ limits: { default: 101 } }), /between 0 and 100/)
  await assert.rejects(store.update({ nope: 1 }), /unknown setting/)
  const reloaded = new SettingsStore({ file, config: store.base })
  assert.equal(reloaded.applyTo().limits.default, 45)
})
