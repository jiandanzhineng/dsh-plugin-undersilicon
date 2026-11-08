import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient } from '../src/sdk/client.js'
import { EventManager, matchesWhere, matchesTypes } from '../src/events/manager.js'
import { AuditLog } from '../src/safety/audit.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeAgent() {
  return {
    injected: [],
    followed: [],
    inject(message) { this.injected.push(message) },
    followup(message) { this.followed.push(message) },
  }
}

async function harness() {
  const mock = await createMockServer().start()
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const events = new EventManager({
    client, config: { events: { maxSubscriptions: 8, minThrottleMs: 500, defaultThrottleMs: 500, maxEvents: 30 } },
    audit: new AuditLog({ enabled: false }),
  })
  return { mock, events }
}

test('type prefixes and where conditions match as documented', () => {
  assert.equal(matchesTypes('device.updated', ['device']), true)
  assert.equal(matchesTypes('game.started', ['device']), false)
  assert.equal(matchesWhere({ data: { heart_rate: 150 } }, { field: 'data.heart_rate', op: 'gte', value: 150 }), true)
  assert.equal(matchesWhere({ data: { heart_rate: 100 } }, { field: 'data.heart_rate', op: 'gt', value: 150 }), false)
  assert.equal(matchesWhere({ type: 'x' }, { field: 'data.heart_rate', op: 'exists' }), false)
})

test('wake subscriptions merge events inside the throttle window', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const agent = fakeAgent()
  const subscription = h.events.subscribe({
    kind: 'agent', ownerId: 's1', agent, types: ['device.updated'],
    mode: 'wake', prompt: 'watch heart rate', throttleMs: 500, maxEvents: 10,
  })
  await sleep(120)
  assert.equal(h.events.state.connected, true)
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 100 } })
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 160 } })
  await sleep(800)
  assert.equal(agent.followed.length, 1)
  assert.equal(typeof agent.followed[0].id, 'string')
  assert.equal(agent.followed[0].role, 'user')
  assert.match(agent.followed[0].content[0].text, /device\.updated/)
  assert.match(agent.followed[0].content[0].text, /mergedCount/)
  assert.equal(agent.injected.length, 0)
  assert.equal(h.events.list()[0].delivered, 1)
  h.events.unsubscribe(subscription.id)
})

test('inject mode, device filter and where filter are honored', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const agent = fakeAgent()
  const subscription = h.events.subscribe({
    kind: 'agent', ownerId: 's1', agent, types: ['device.updated'],
    deviceId: 'hr-1', where: { field: 'data.heart_rate', op: 'gte', value: 150 },
    mode: 'inject', throttleMs: 500, maxEvents: 10,
  })
  await sleep(120)
  h.mock.emit({ type: 'device.updated', deviceId: 'other', data: { heart_rate: 200 } })
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 100 } })
  await sleep(800)
  assert.equal(agent.injected.length, 0)
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 180 } })
  await sleep(800)
  assert.equal(agent.injected.length, 1)
  assert.equal(agent.followed.length, 0)
  assert.match(agent.injected[0].content[0].text, /180/)
  h.events.unsubscribe(subscription.id)
})

test('maxEvents auto-unsubscribes and injects a final note', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const agent = fakeAgent()
  h.events.subscribe({
    kind: 'agent', ownerId: 's1', agent, types: ['client.route'],
    mode: 'wake', throttleMs: 500, maxEvents: 1,
  })
  await sleep(120)
  h.mock.emit({ type: 'client.route', path: '/games' })
  await sleep(800)
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.injected.length, 1)
  assert.match(agent.injected[0].content[0].text, /subscription ended/)
  assert.equal(h.events.list().length, 0)
})

test('script subscriptions throttle and merge matching events', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const received = []
  h.events.subscribe({
    kind: 'script', ownerId: 'script_1', types: ['game.state'],
    onEvent: (event) => received.push(event), maxEvents: 10, throttleMs: 500,
  })
  await sleep(120)
  h.mock.emit({ type: 'game.state', gameId: 'demo', snapshot: { score: 1 } })
  h.mock.emit({ type: 'game.state', gameId: 'demo', snapshot: { score: 2 } })
  await sleep(800)
  assert.equal(received.length, 1)
  assert.equal(received[0]._count, 2)
  assert.equal(received[0].snapshot.score, 2)
})

test('subscription limits reject NaN/oversized values and cap per owner', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  h.events.config = { events: { maxSubscriptions: 20, maxTotalSubscriptions: 64, minThrottleMs: 500, defaultThrottleMs: 500, maxEvents: 30 } }
  assert.throws(() => h.events.subscribe({ kind: 'agent', ownerId: 's1', types: ['device'], throttleMs: NaN }), /finite number/)
  assert.throws(() => h.events.subscribe({ kind: 'agent', ownerId: 's1', types: ['device'], maxEvents: 0 }), /between 1 and 1000/)
  assert.throws(() => h.events.subscribe({ kind: 'agent', ownerId: 's1', types: ['device'], maxEvents: 1001 }), /between 1 and 1000/)
  for (let index = 0; index < 20; index += 1) {
    h.events.subscribe({ kind: 'script', ownerId: 'script-x', types: ['device'], throttleMs: 500 })
  }
  assert.throws(() => h.events.subscribe({ kind: 'script', ownerId: 'script-x', types: ['device'], throttleMs: 500 }), /20 subscriptions/)
  h.events.dispose()
})

test('the panel keepalive keeps the shared stream connected without subscriptions', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  h.events.keepPanelAlive(3000)
  await sleep(200)
  assert.equal(h.events.list().length, 0)
  assert.equal(h.events.state.connected, true)
  assert.equal(h.events.state.status, 'connected')
  h.events.dispose()
  assert.equal(h.events.state.status, 'idle')
})

test('recent falls back to /api/events/recent and dispose clears everything', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  h.mock.emit({ type: 'device.added', deviceId: 'x' })
  const recent = await h.events.recent({ limit: 10 })
  assert.equal(recent.length, 1)
  h.events.subscribe({ kind: 'agent', ownerId: 's1', agent: fakeAgent(), types: ['device'] })
  h.events.dispose()
  assert.equal(h.events.list().length, 0)
})

test('a subscription added after the shared stream connects still receives its events', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const first = h.events.subscribe({ kind: 'agent', ownerId: 's1', agent: fakeAgent(), types: ['device.updated'] })
  await sleep(120)
  assert.equal(h.events.state.connected, true)
  const lateAgent = fakeAgent()
  const late = h.events.subscribe({ kind: 'agent', ownerId: 's1', agent: lateAgent, types: ['client.route'], mode: 'inject', throttleMs: 500 })
  h.mock.emit({ type: 'client.route', path: '/devices' })
  await sleep(800)
  assert.equal(lateAgent.injected.length, 1)
  assert.equal(typeof lateAgent.injected[0].id, 'string')
  assert.equal(lateAgent.injected[0].role, 'user')
  assert.match(lateAgent.injected[0].content[0].text, /\/devices/)
  h.events.unsubscribe(first.id)
  h.events.unsubscribe(late.id)
})
