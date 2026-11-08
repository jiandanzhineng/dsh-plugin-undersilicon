import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient, classifyMode } from '../src/sdk/client.js'
import { streamEvents, parseSseBlock } from '../src/sdk/events-stream.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('mode classification matches the main-repo rules', () => {
  assert.equal(classifyMode({ active: false }), 'local')
  assert.equal(classifyMode({ active: true, role: 'operator', authorized: false, links: { projection: { roomId: null } } }), 'local')
  assert.equal(classifyMode({ active: true, role: 'operator', authorized: true, links: { projection: { roomId: 'r' } } }), 'remote-operator')
  assert.equal(classifyMode({ active: true, role: 'owner', authorized: true, links: { projection: { roomId: 'r' } } }), 'remote-controlled')
})

test('SSE parser reads data, id, event and ignores comments', () => {
  assert.deepEqual(parseSseBlock('id: 7\ndata: {"a":1}'), { data: '{"a":1}', id: '7', event: undefined, retry: undefined })
  assert.equal(parseSseBlock(': ping').data, '')
})

test('SDK surfaces the local API', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  assert.equal((await client.remoteStatus()).active, false)
  assert.equal(client.lastMode, 'local')
  assert.equal((await client.devices()).length, 5)
  assert.equal((await client.device('pj-1')).type, 'PJ01')
  assert.equal((await client.deviceTypeConfig('PJ01')).capabilities[0], 'strength')
  const caps = await client.deviceCapabilities()
  assert.equal(caps.capabilityConfig.strength.actionParams.set.value.max, 200)
  assert.equal((await client.control('pj-1', 'strength', 'set', { value: 10 })).success, true)
  assert.equal((await client.operate('pj-1', 'start', {})).ok, true)
  const state = await client.clientState()
  assert.equal(state.available, true)
  const routes = await client.clientRoutes()
  assert.equal(routes[0].titleKey, 'nav.devices')
  const launch = await client.launchClientGame('demo', { show: true })
  assert.equal(launch.ok, true)
  assert.equal(launch.mode, 'iframe')
  assert.equal(launch.started, true)
  const shot = await client.clientScreenshot({ format: 'png', maxWidth: 640 })
  assert.equal(shot.mime, 'image/png')
  assert.ok(shot.data.length > 10)
  assert.ok(Array.isArray(await client.eventsRecent({ limit: 5 })))
})

test('remote-operator filters devices and locks the watchdog', async (t) => {
  const mock = await createMockServer({ mode: 'remote-operator' }).start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  await client.remoteStatus()
  assert.equal(client.lastMode, 'remote-operator')
  assert.deepEqual((await client.devices()).map((device) => device.id), ['remote-1'])
  await assert.rejects(client.watchdogHeartbeat('dsh-x', 30), (error) => error.status === 423)
})

test('pure backend returns available:false and 503 for client control', async (t) => {
  const mock = await createMockServer({ clientAvailable: false }).start()
  t.after(() => mock.close())
  const client = new ControlPanelClient({ baseUrl: mock.url })
  assert.equal((await client.clientState()).available, false)
  await assert.rejects(client.clientWindow('show'), (error) => error.status === 503 && error.code === 'CLIENT_UNAVAILABLE')
  await assert.rejects(client.clientScreenshot(), (error) => error.status === 503)
})

test('the event stream accepts the typed hello frame and forwards events', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const hellos = []
  const events = []
  const controller = new AbortController()
  const running = streamEvents({
    baseUrl: mock.url, types: ['device'], signal: controller.signal,
    onHello: (hello) => hellos.push(hello),
    onEvent: (event) => events.push(event),
  })
  await sleep(150)
  mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 99 } })
  await sleep(150)
  controller.abort()
  await running
  assert.equal(hellos.length, 1)
  assert.equal(hellos[0].type, 'hello')
  assert.equal(hellos[0].mode, 'local')
  assert.equal(events[0].type, 'device.updated')
  assert.equal(events[0]._id, 1)
})
