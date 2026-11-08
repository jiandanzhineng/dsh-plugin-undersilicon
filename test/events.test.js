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
    client, config: { events: { maxSubscriptions: 8, minThrottleMs: 200, defaultThrottleMs: 200, maxEvents: 30 } },
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
    mode: 'wake', prompt: 'watch heart rate', throttleMs: 200, maxEvents: 10,
  })
  await sleep(120)
  assert.equal(h.events.state.connected, true)
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 100 } })
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 160 } })
  await sleep(400)
  assert.equal(agent.followed.length, 1)
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
    mode: 'inject', throttleMs: 200, maxEvents: 10,
  })
  await sleep(120)
  h.mock.emit({ type: 'device.updated', deviceId: 'other', data: { heart_rate: 200 } })
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 100 } })
  await sleep(400)
  assert.equal(agent.injected.length, 0)
  h.mock.emit({ type: 'device.updated', deviceId: 'hr-1', data: { heart_rate: 180 } })
  await sleep(400)
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
    mode: 'wake', throttleMs: 200, maxEvents: 1,
  })
  await sleep(120)
  h.mock.emit({ type: 'client.route', path: '/games' })
  await sleep(400)
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.injected.length, 1)
  assert.match(agent.injected[0].content[0].text, /subscription ended/)
  assert.equal(h.events.list().length, 0)
})

test('script subscriptions receive every matching event through their callback', async (t) => {
  const h = await harness()
  t.after(() => h.mock.close())
  const received = []
  h.events.subscribe({
    kind: 'script', ownerId: 'script_1', types: ['game.state'],
    onEvent: (event) => received.push(event), maxEvents: 10,
  })
  await sleep(120)
  h.mock.emit({ type: 'game.state', gameId: 'demo', snapshot: { score: 1 } })
  h.mock.emit({ type: 'game.state', gameId: 'demo', snapshot: { score: 2 } })
  await sleep(120)
  assert.equal(received.length, 2)
  assert.equal(received[1].snapshot.score, 2)
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
