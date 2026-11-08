import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockServer } from '../mock/server.js'
import { ControlPanelClient } from '../src/sdk/client.js'
import { Watchdog, watchdogClientId } from '../src/safety/watchdog.js'

function fakeClock() {
  const intervals = new Set()
  return {
    setInterval(fn, ms) {
      const handle = { fn, ms, unref() {} }
      intervals.add(handle)
      return handle
    },
    clearInterval(handle) { intervals.delete(handle) },
    size() { return intervals.size },
    async fire() { for (const handle of [...intervals]) handle.fn() },
  }
}

test('watchdog client ids satisfy the backend grammar', () => {
  assert.equal(watchdogClientId('abc-123'), 'dsh-abc-123')
  assert.match(watchdogClientId('a b/c'), /^dsh-[A-Za-z0-9._:-]+$/)
  assert.ok(watchdogClientId('x'.repeat(200)).length <= 96)
})

test('a lease is created on first touch and refreshed on the timer', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const clock = fakeClock()
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const watchdog = new Watchdog({ client, ttlSeconds: 30, clock })
  await watchdog.touch('s1', { reason: 'test' })
  assert.equal(mock.state.watchdog.has('dsh-s1'), true)
  assert.equal(clock.size(), 1)
  await clock.fire()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const beats = mock.state.requests.filter((request) => request.path === '/api/device-watchdog/heartbeat')
  assert.ok(beats.length >= 2)
  assert.equal(watchdog.status()[0].clientId, 'dsh-s1')
  watchdog.stop('s1')
  assert.equal(watchdog.status().length, 0)
  assert.equal(clock.size(), 0)
})

test('423 in remote mode disables the lease instead of retrying forever', async (t) => {
  const mock = await createMockServer({ mode: 'remote-operator' }).start()
  t.after(() => mock.close())
  const clock = fakeClock()
  const client = new ControlPanelClient({ baseUrl: mock.url })
  const watchdog = new Watchdog({ client, ttlSeconds: 30, clock })
  const result = await watchdog.touch('s1')
  assert.equal(result.disabled, true)
  assert.equal(watchdog.status().length, 0)
  assert.equal(clock.size(), 0)
  assert.equal(mock.state.watchdog.size, 0)
})

test('dispose clears every timer without another request', async (t) => {
  const mock = await createMockServer().start()
  t.after(() => mock.close())
  const clock = fakeClock()
  const watchdog = new Watchdog({ client: new ControlPanelClient({ baseUrl: mock.url }), ttlSeconds: 30, clock })
  await watchdog.touch('a')
  await watchdog.touch('b')
  assert.equal(clock.size(), 2)
  watchdog.dispose()
  assert.equal(clock.size(), 0)
  assert.equal(watchdog.status().length, 0)
})
