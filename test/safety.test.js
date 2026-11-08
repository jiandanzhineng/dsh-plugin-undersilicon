import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient } from '../src/sdk/client.js'
import { SafetyLayer, normalizeApiPath } from '../src/safety/safety.js'
import { AuditLog } from '../src/safety/audit.js'
import { Watchdog } from '../src/safety/watchdog.js'
import { normalizeBaseUrl } from '../src/util/http.js'
import { SafetyError } from '../src/util/errors.js'

async function harness(options = {}) {
  const mock = await createMockServer(options).start()
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const audit = new AuditLog({ enabled: false })
  const watchdog = new Watchdog({ client, ttlSeconds: 30 })
  const safety = new SafetyLayer({
    client,
    config: { limits: { default: 60, capabilities: { shock: 30 } } },
    audit,
    watchdog,
  })
  return { mock, client, audit, watchdog, safety }
}

test('base URLs must stay on loopback', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5278').toString(), 'http://127.0.0.1:5278/api')
  assert.equal(normalizeBaseUrl('http://localhost:5278/api/').toString(), 'http://localhost:5278/api')
  assert.throws(() => normalizeBaseUrl('http://192.168.1.2:5278/api'), /loopback/)
  assert.throws(() => normalizeBaseUrl('https://example.com/api'), /loopback/)
  assert.throws(() => normalizeBaseUrl('ftp://127.0.0.1/api'))
})

test('raw path normalization strips /api and absolute origins', () => {
  assert.equal(normalizeApiPath('/api/devices'), '/devices')
  assert.equal(normalizeApiPath('http://127.0.0.1:5278/api/devices?x=1'), '/devices')
  assert.equal(normalizeApiPath('devices'), '/devices')
  assert.equal(normalizeApiPath('/api'), '/')
})

test('dangerous raw endpoints are blocked, safe ones pass', () => {
  const safety = new SafetyLayer({ config: { limits: {} }, audit: new AuditLog({ enabled: false }) })
  assert.throws(() => safety.assertRawAllowed('POST', '/devices/pj-1/message'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/devices/batch/operations'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/mqtt-client/publish'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/serial/write'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/wired-flash'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/devices/pj-1/firmware/update-latest'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/local-apps/launch'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('DELETE', '/devices/pj-1'), SafetyError)
  assert.throws(() => safety.assertRawAllowed('POST', '/remote-session/create'), SafetyError)
  assert.equal(safety.assertRawAllowed('GET', '/devices'), '/devices')
  assert.equal(safety.assertRawAllowed('POST', '/devices/pj-1/capabilities/strength/actions/set'), '/devices/pj-1/capabilities/strength/actions/set')
  assert.equal(safety.assertRawAllowed('POST', '/events/recent'), '/events/recent')
})

test('control applies API ranges, audits and touches the watchdog', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.control({
    sessionId: 's1', source: { kind: 'tool', name: 'device_control' },
    deviceId: 'pj-1', capability: 'strength', action: 'set', input: { value: 180 },
  })
  // The mock advertises 0-200 for strength.value, so 60% = 120.
  assert.equal(result._scaled.input.value, 120)
  assert.equal(result._mode, 'local')
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/heartbeat'), true)
  const entry = h.audit.recent(1)[0]
  assert.equal(entry.action, 'device.control')
  assert.equal(entry.request.input.value, 120)
})

test('preset operations resolve the capability from the device type', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.operate({
    sessionId: 's1', source: { kind: 'tool', name: 'device_control' },
    deviceId: 'di-1', operation: 'start', params: {},
    definition: { key: 'start', capability: 'shock', action: 'start', input: { voltage: 24 } },
  })
  assert.equal(result._scaled.input.voltage, 24)
})

test('remote-operator mode skips the watchdog and uses the remote stop path', async (t) => {
  const h = await harness({ mode: 'remote-operator' })
  t.after(() => h.mock.close())
  await h.safety.refreshMode({ force: true })
  assert.equal(h.safety.mode, 'remote-operator')
  const touch = await h.safety.maybeTouchWatchdog('s1', { source: { kind: 'tool' }, path: 'x' })
  assert.equal(touch.disabled, true)
  const stop = await h.safety.emergencyStop({ sessionId: 's1', source: { kind: 'tool' }, reason: 'test' })
  assert.equal(stop.mode, 'remote-operator')
  assert.equal(stop.ok, true)
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/remote-session/emergency-stop'), true)
  assert.equal(h.mock.state.requests.some((request) => request.path === '/api/device-watchdog/stop-all'), false)
})

test('local emergency stop hits devices, game and runtime', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const stop = await h.safety.emergencyStop({ sessionId: 's1', source: { kind: 'tool' }, reason: 'test' })
  assert.equal(stop.mode, 'local')
  assert.equal(stop.ok, true)
  for (const path of ['/api/device-watchdog/stop-all', '/api/games/stop-current', '/api/game-runtime/stop']) {
    assert.equal(h.mock.state.requests.some((request) => request.path === path), true, path)
  }
})

test('raw API still scales capability bodies and blocks bypasses', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const result = await h.safety.raw({
    sessionId: 's1', source: { kind: 'tool', name: 'panel_api' }, method: 'POST',
    path: '/devices/pj-1/capabilities/strength/actions/set',
    body: { input: { value: 200 } },
  })
  assert.equal(result._scaled.input.value, 120)
  await assert.rejects(
    h.safety.raw({ sessionId: 's1', source: { kind: 'tool' }, method: 'POST', path: '/devices/pj-1/message', body: { message: {} } }),
    /blocked/,
  )
})
