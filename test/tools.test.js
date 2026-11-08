import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockServer } from '../mock/server.js'
import { apply } from '../index.js'
import { registerScriptTools } from '../src/tools/scripts.js'

function fakeCtx() {
  const tools = new Map()
  const effects = []
  const listeners = new Map()
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    get() { return undefined },
    on(event, handler) { listeners.set(event, handler) },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return { dispose: async () => {} } },
    inject(_deps, callback) { /* optional services are absent in this test */ return callback },
    logger: null,
  }
  return { ctx, tools, effects, listeners }
}

function fakeExec(extra = {}) {
  return {
    callId: 'call-1',
    signal: AbortSignal.timeout(15000),
    agent: { session: { id: 's1' }, options: {}, inject() {}, followup() {} },
    ...extra,
  }
}

async function pluginHarness(config = {}) {
  const mock = await createMockServer().start()
  const { ctx, tools, listeners, effects } = fakeCtx()
  apply(ctx, { baseUrl: mock.url, auditEnabled: false, scripts: { allowPersist: false }, ...config })
  return { mock, ctx, tools, listeners, effects }
}

test('the plugin registers the complete tool surface', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const names = [...h.tools.keys()].sort()
  for (const expected of [
    'panel_status', 'device_list', 'device_get', 'device_control', 'device_manage', 'emergency_stop',
    'game_list', 'game_status', 'game_start', 'game_control',
    'client_control', 'client_screenshot',
    'script_run', 'script_list', 'script_stop', 'script_logs',
    'events_subscribe', 'events_unsubscribe', 'events_recent', 'panel_api',
  ]) assert.ok(names.includes(expected), expected)
  assert.equal(names.length, 20)
  for (const [name, definition] of h.tools) {
    assert.ok(definition.description.length > 20, `${name} description`)
    assert.ok(definition.output && typeof definition.output.render === 'function', `${name} output`)
  }
})

test('panel_status reports mode, devices and thresholds', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('panel_status').execute({}, fakeExec())
  assert.equal(value.mode, 'local')
  assert.equal(value.devices.length, 5)
  assert.equal(value.thresholds.default, 60)
  assert.equal(value.devices.find((device) => device.id === 'hr-1').keyData.heart_rate, 80)
})

test('device_control applies the configured threshold and reports clamped fields', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('device_control').execute({
    deviceId: 'pj-1', capability: 'strength', action: 'set', input: { value: 200 },
  }, fakeExec())
  assert.equal(value.appliedInput.value, 120)
  assert.equal(value.clamped[0].requested, 200)
  const shock = await h.tools.get('device_control').execute({
    deviceId: 'di-1', capability: 'shock', action: 'start', input: { voltage: 80 },
  }, fakeExec())
  assert.equal(shock.appliedInput.voltage, 30)
})

test('device_control can run a preset operation by key', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('device_control').execute({
    deviceId: 'pj-1', operation: 'start', params: {},
  }, fakeExec())
  assert.equal(value.operation, 'start')
  assert.equal(value.appliedParams.value, 120)
})

test('device_control rejects unknown operations with the available list', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  await assert.rejects(
    h.tools.get('device_control').execute({ deviceId: 'pj-1', operation: 'nope' }, fakeExec()),
    /available: start, stop/,
  )
})

test('panel_api blocks bypass endpoints and allows normal reads', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const list = await h.tools.get('panel_api').execute({ method: 'GET', path: '/devices' }, fakeExec())
  assert.equal(list.length, 5)
  await assert.rejects(
    h.tools.get('panel_api').execute({ method: 'POST', path: '/devices/batch/operations', body: {} }, fakeExec()),
    /blocked/,
  )
})

test('device rename only forwards the name field', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('device_manage').execute({ action: 'rename', deviceId: 'pj-1', name: 'new name' }, fakeExec())
  assert.equal(value.name, 'new name')
  const patch = h.mock.state.requests.filter((request) => request.method === 'PATCH').at(-1)
  assert.deepEqual(patch.body, { name: 'new name' })
  await assert.rejects(
    h.tools.get('panel_api').execute({ method: 'PATCH', path: '/devices/pj-1', body: { name: 'x', power: 255 } }, fakeExec()),
    /only change name|refused fields/i,
  )
})

test('game_start and game_control scale intensity parameters', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const started = await h.tools.get('game_start').execute({
    gameId: 'demo', parameters: { maxMotorIntensity: 255, shockVoltage: 80, speed: 5 },
  }, fakeExec())
  assert.equal(started.scaledParameters.maxMotorIntensity, 120)
  assert.equal(started.scaledParameters.shockVoltage, 30)
  assert.equal(started.scaledParameters.speed, 5)
  const changed = await h.tools.get('game_control').execute({
    action: 'params', params: { maxMotorIntensity: '255', duration: 10 },
  }, fakeExec())
  assert.equal(changed.scaledParameters.maxMotorIntensity, 120)
  assert.ok(changed.scaledFields.includes('maxMotorIntensity'))
})

test('preset operations translate invoke-style starts to scaled capability actions', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('device_control').execute({
    deviceId: 'cz-1', operation: 'start', params: { voltage: 99 },
  }, fakeExec())
  assert.equal(value.translated, true)
  assert.deepEqual(value.actions, ['shock.start', 'strength.set'])
  const shock = h.mock.state.requests.filter((request) => request.path.includes('/cz-1/capabilities/shock/actions/start')).at(-1)
  const strength = h.mock.state.requests.filter((request) => request.path.includes('/cz-1/capabilities/strength/actions/set')).at(-1)
  assert.deepEqual(shock.body, { input: { voltage: 24 } })
  assert.deepEqual(strength.body, { input: { value: 120 } })
})

test('emergency_stop stops devices and scripts', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const value = await h.tools.get('emergency_stop').execute({ reason: 'test' }, fakeExec())
  assert.equal(value.mode, 'local')
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), true)
})

test('events_subscribe validates types and registers an agent subscription', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  await assert.rejects(
    h.tools.get('events_subscribe').execute({ types: ['not.real'] }, fakeExec()),
    /unknown event type/,
  )
  const subscription = await h.tools.get('events_subscribe').execute({
    types: ['device.updated'], deviceId: 'hr-1', mode: 'inject', prompt: 'watch',
  }, fakeExec())
  assert.match(subscription.id, /^sub_/)
  const cancelled = await h.tools.get('events_unsubscribe').execute({ subscriptionId: subscription.id }, fakeExec())
  assert.equal(cancelled.ok, true)
})

test('client_control rejects unknown routes before calling the backend', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  await assert.rejects(
    h.tools.get('client_control').execute({ action: 'navigate', path: '/nope' }, fakeExec()),
    /unknown client route/,
  )
  const value = await h.tools.get('client_control').execute({ action: 'navigate', path: '/games' }, fakeExec())
  assert.equal(value.route, '/games')
})

test('session end stops the session scripts and all devices by default', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  const handler = h.listeners.get('agent/disposed')
  assert.equal(typeof handler, 'function')
  handler({ agent: { session: { id: 's1' } } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), true)
})

test('stopOnSessionEnd=false leaves devices running', async (t) => {
  const h = await pluginHarness({ stopOnSessionEnd: false })
  t.after(() => h.mock.close())
  h.listeners.get('agent/disposed')({ agent: { session: { id: 's1' } } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), false)
})

test('plugin dispose stops devices with a bounded wait when stopOnSessionEnd is true', async (t) => {
  const h = await pluginHarness()
  t.after(() => h.mock.close())
  assert.equal(h.effects.length >= 1, true)
  await h.effects.at(-1)()
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), true)
})

test('plugin dispose does not stop devices when stopOnSessionEnd is false', async (t) => {
  const h = await pluginHarness({ stopOnSessionEnd: false })
  t.after(() => h.mock.close())
  await h.effects.at(-1)()
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), false)
})

test('script_run refuses before starting when the panel is latched', async () => {
  const tools = new Map()
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition) } } }
  let started = false
  registerScriptTools(ctx, {
    safety: {
      assertActive() {
        const error = new Error('emergency stop latched; resume in the panel')
        error.code = 'EMERGENCY_LATCHED'
        throw error
      },
    },
    scripts: { run: async () => { started = true; return {} } },
  })
  await assert.rejects(
    tools.get('script_run').execute({ code: 'us.log("hi")' }, fakeExec()),
    (error) => error.code === 'EMERGENCY_LATCHED',
  )
  assert.equal(started, false)
})

test('script_stop gives a clear rejection for a script owned by another session', async () => {
  const tools = new Map()
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition) } } }
  const calls = []
  registerScriptTools(ctx, {
    safety: { assertActive() {} },
    scripts: {
      stop(id, reason, options) {
        calls.push({ id, reason, options })
        return false
      },
    },
  })
  const otherSession = fakeExec({
    agent: { session: { id: 's2' }, options: {}, inject() {}, followup() {} },
  })
  await assert.rejects(
    tools.get('script_stop').execute({ scriptId: 'script_x' }, otherSession),
    /another session|其他会话/,
  )
  assert.equal(calls[0].id, 'script_x')
  assert.equal(calls[0].options.sessionId, 's2')
})
