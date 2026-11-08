import { randomUUID } from 'node:crypto'
import { streamEvents } from '../sdk/events-stream.js'
import { errorMessage } from '../util/errors.js'

const MAX_RING = 200

/** Read a dot path from an event payload. */
export function getPath(value, path) {
  let cursor = value
  for (const part of String(path || '').split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** Evaluate one simple `where` condition. */
export function matchesWhere(event, where) {
  if (!where) return true
  const actual = getPath(event, where.field)
  const expected = where.value
  switch (where.op || 'eq') {
    case 'eq': return actual === expected
    case 'ne': return actual !== expected
    case 'gt': return Number(actual) > Number(expected)
    case 'gte': return Number(actual) >= Number(expected)
    case 'lt': return Number(actual) < Number(expected)
    case 'lte': return Number(actual) <= Number(expected)
    case 'contains': return typeof actual === 'string' && actual.includes(String(expected))
      || Array.isArray(actual) && actual.includes(expected)
    case 'exists': return actual !== undefined && actual !== null
    case 'truthy': return Boolean(actual)
    case 'falsy': return !actual
    default: return false
  }
}

/** Match a type list (`device` matches `device.updated`). */
export function matchesTypes(type, types) {
  if (!types?.length) return true
  return types.some((prefix) => type === prefix || String(type).startsWith(`${prefix}.`))
}

/** Match one event against a subscription. */
export function matchesSubscription(event, subscription) {
  if (!matchesTypes(event.type, subscription.types)) return false
  if (subscription.deviceId) {
    const id = event.deviceId ?? event.device?.id
    if (id !== subscription.deviceId) return false
  }
  return matchesWhere(event, subscription.where)
}

/** Compact one event for a model-facing subscription message. */
export function formatEventText(event, subscription) {
  const body = { type: event.type, ts: event.ts, seq: event.seq }
  if (event.deviceId) body.deviceId = event.deviceId
  if (event.data) body.data = event.data
  if (event.changes) body.changes = event.changes
  if (event.gameId) body.gameId = event.gameId
  if (event.mode) body.mode = event.mode
  if (event.path) body.path = event.path
  if (event._count > 1) body.mergedCount = event._count
  let json = JSON.stringify(body)
  if (json.length > 1800) json = `${json.slice(0, 1800)}…[truncated]`
  return `[undersilicon ${subscription.id}] ${subscription.prompt || 'event'}\n${json}`
}

/** Event stream fan-out shared by agent subscriptions, scripts and the panel. */
export class EventManager {
  constructor({ client, config, audit, log = () => {}, clock = globalThis } = {}) {
    this.client = client
    this.config = config
    this.audit = audit
    this.log = log
    this.clock = clock
    this.subscriptions = new Map()
    this.ring = []
    this.lastSeq = undefined
    this.state = {
      connected: false, status: 'idle', mode: 'unknown', lastEventAt: null,
      error: null, fallback: false, nextRetryAt: null,
    }
    this.abort = null
    this.loopPromise = null
    this.nextId = 1
    this.pollTimer = null
    this.deviceCache = new Map()
    this.panelActive = false
    this.panelTimer = null
  }

  limits() {
    return {
      maxSubscriptions: Math.max(1, Number(this.config?.events?.maxSubscriptions ?? 20)),
      minThrottleMs: Math.max(500, Number(this.config?.events?.minThrottleMs ?? 500)),
      defaultThrottleMs: Math.max(500, Number(this.config?.events?.defaultThrottleMs ?? 1000)),
      defaultMaxEvents: Math.max(1, Number(this.config?.events?.maxEvents ?? 50)),
    }
  }

  /** Keeps the shared SSE warm while the sidebar panel is open (4s polling). */
  keepPanelAlive(ttlMs = 15000) {
    this.panelActive = true
    if (this.panelTimer) this.clock.clearTimeout(this.panelTimer)
    this.panelTimer = this.clock.setTimeout(() => {
      this.panelTimer = null
      this.panelActive = false
      if (this.subscriptions.size === 0) this.stopStream()
    }, ttlMs)
    this.panelTimer?.unref?.()
    void this.ensureStream()
  }

  shouldStream() {
    return this.subscriptions.size > 0 || this.panelActive
  }

  /** Add a subscription and make sure the shared stream is running. */
  subscribe(options) {
    const limits = this.limits()
    if (this.subscriptions.size >= limits.maxSubscriptions) {
      throw new Error(`too many event subscriptions (max ${limits.maxSubscriptions}); unsubscribe one first`)
    }
    const ownerId = options.ownerId
    if (ownerId !== undefined) {
      const owned = [...this.subscriptions.values()].filter((item) => item.ownerId === ownerId).length
      if (owned >= 20) throw new Error('this session already has 20 subscriptions; cancel one before adding another')
    }
    const rawThrottle = options.throttleMs === undefined ? limits.defaultThrottleMs : Number(options.throttleMs)
    if (!Number.isFinite(rawThrottle)) throw new Error('throttleMs must be a finite number between 500 and 3600000')
    const throttleMs = Math.max(500, Math.min(3600000, rawThrottle))
    const rawMax = options.maxEvents === undefined ? limits.defaultMaxEvents : Number(options.maxEvents)
    if (!Number.isFinite(rawMax) || rawMax < 1 || rawMax > 1000) {
      throw new Error('maxEvents must be an integer between 1 and 1000')
    }
    const id = `sub_${this.nextId++}`
    const subscription = {
      id,
      kind: options.kind || 'agent',
      ownerId,
      agent: options.agent,
      onEvent: options.onEvent,
      types: options.types || [],
      deviceId: options.deviceId,
      where: options.where,
      prompt: options.prompt || '',
      mode: options.mode === 'inject' ? 'inject' : 'wake',
      throttleMs,
      maxEvents: Math.floor(rawMax),
      delivered: 0,
      pending: null,
      pendingCount: 0,
      firstTs: null,
      timer: null,
      createdAt: new Date().toISOString(),
    }
    this.subscriptions.set(id, subscription)
    void this.ensureStream()
    return this.describe(subscription)
  }

  /** Remove one subscription; the shared stream stops when nothing needs it. */
  unsubscribe(id) {
    const subscription = this.subscriptions.get(id)
    if (!subscription) return false
    if (subscription.timer) this.clock.clearTimeout(subscription.timer)
    this.subscriptions.delete(id)
    if (!this.shouldStream()) this.stopStream()
    return true
  }

  /** Remove every subscription owned by one agent session or script. */
  unsubscribeOwner(ownerId) {
    let removed = 0
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.ownerId === ownerId) {
        this.unsubscribe(id)
        removed += 1
      }
    }
    return removed
  }

  /** Metadata for the panel/status tools. Undefined filters are omitted for lossless JSON. */
  describe(subscription) {
    const out = {
      id: subscription.id, kind: subscription.kind, ownerId: subscription.ownerId,
      types: subscription.types,
      mode: subscription.mode, prompt: subscription.prompt,
      throttleMs: subscription.throttleMs, maxEvents: subscription.maxEvents,
      delivered: subscription.delivered, createdAt: subscription.createdAt,
    }
    if (subscription.deviceId !== undefined) out.deviceId = subscription.deviceId
    if (subscription.where !== undefined) out.where = subscription.where
    return out
  }

  list() {
    return [...this.subscriptions.values()].map((item) => this.describe(item))
  }

  /** Recent events (ring buffer; falls back to the backend when empty). */
  async recent({ limit = 100, types } = {}) {
    let events = this.ring.filter((event) => matchesTypes(event.type, types)).slice(-limit)
    if (events.length === 0) {
      try {
        const payload = await this.client.eventsRecent({ limit, types })
        const list = Array.isArray(payload) ? payload : payload?.events || []
        events = list
      } catch {
        events = []
      }
    }
    return events.slice(-limit)
  }

  /** Feed one event into the fan-out. Exported for tests via `dispatch`. */
  dispatch(event) {
    if (!event || typeof event.type !== 'string') return
    this.ring.push(event)
    if (this.ring.length > MAX_RING) this.ring.shift()
    this.state.lastEventAt = new Date().toISOString()
    for (const subscription of [...this.subscriptions.values()]) {
      if (!matchesSubscription(event, subscription)) continue
      if (subscription.kind === 'script' && subscription.onEvent) {
        this.deliverScript(subscription, event)
        continue
      }
      this.queueAgent(subscription, event)
    }
  }

  deliverScript(subscription, event) {
    subscription.pendingCount += 1
    subscription.firstTs ??= event.ts
    subscription.pending = event
    if (subscription.timer) return
    subscription.timer = this.clock.setTimeout(() => {
      subscription.timer = null
      const latest = subscription.pending
      if (!latest) return
      const merged = { ...latest, _count: subscription.pendingCount, _firstTs: subscription.firstTs }
      subscription.pending = null
      subscription.pendingCount = 0
      subscription.firstTs = null
      subscription.delivered += 1
      try {
        subscription.onEvent(merged)
      } catch (error) {
        this.log('script event handler failed', { id: subscription.id, error: errorMessage(error) })
      }
      if (subscription.delivered >= subscription.maxEvents) this.finish(subscription, 'max-events')
    }, subscription.throttleMs)
    subscription.timer?.unref?.()
  }

  queueAgent(subscription, event) {
    subscription.pendingCount += 1
    subscription.firstTs ??= event.ts
    subscription.pending = event
    if (subscription.timer) return
    subscription.timer = this.clock.setTimeout(() => {
      subscription.timer = null
      const latest = subscription.pending
      if (!latest) return
      const merged = {
        ...latest, _count: subscription.pendingCount, _firstTs: subscription.firstTs,
      }
      subscription.pending = null
      subscription.pendingCount = 0
      subscription.firstTs = null
      subscription.delivered += 1
      this.deliverAgent(subscription, merged)
      if (subscription.delivered >= subscription.maxEvents) this.finish(subscription, 'max-events')
    }, subscription.throttleMs)
    subscription.timer?.unref?.()
  }

  deliverAgent(subscription, event) {
    const agent = subscription.agent
    if (!agent) {
      this.unsubscribe(subscription.id)
      return
    }
    const text = formatEventText(event, subscription)
    const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'undersilicon' } }
    try {
      if (subscription.mode === 'inject') agent.inject(message)
      else agent.followup(message)
    } catch (error) {
      this.log('agent event delivery failed', { id: subscription.id, error: errorMessage(error) })
      this.unsubscribe(subscription.id)
    }
  }

  finish(subscription, reason) {
    if (!this.subscriptions.has(subscription.id)) return
    const agent = subscription.agent
    this.unsubscribe(subscription.id)
    this.audit.record({
      sessionId: subscription.ownerId, source: { kind: 'events', id: subscription.id },
      action: 'events.auto-unsubscribe',
      result: { ok: true, reason, delivered: subscription.delivered },
    })
    if (agent) {
      try {
        agent.inject({
          id: randomUUID(),
          role: 'user',
          content: [{
            type: 'text',
            text: `[undersilicon ${subscription.id}] subscription ended (${reason}) after ${subscription.delivered} events. Use events_subscribe again if you still need it.`,
          }],
          source: { kind: 'undersilicon' },
        })
      } catch { /* agent may be gone */ }
    }
  }

  ensureStream() {
    if (this.loopPromise || !this.shouldStream()) return this.loopPromise
    this.loopPromise = this.streamLoop().finally(() => { this.loopPromise = null })
    return this.loopPromise
  }

  async streamLoop() {
    const controller = new AbortController()
    this.abort = controller
    let backoff = 1000
    this.state.status = 'connecting'
    this.state.nextRetryAt = null
    while (this.shouldStream() && !controller.signal.aborted) {
      // Subscribe without a server-side type filter: the stream is shared and
      // subscriptions may be added after it connects, so a union captured here
      // would silently miss events for later subscriptions. Filtering stays
      // local in dispatch(), which already matches each subscription.
      try {
        this.state.status = this.state.connected ? 'connected' : 'connecting'
        const outcome = await streamEvents({
          baseUrl: this.client.baseUrl,
          lastEventId: this.lastSeq,
          signal: controller.signal,
          onHello: (hello) => {
            this.state.connected = true
            this.state.status = 'connected'
            this.state.fallback = false
            this.state.error = null
            this.state.nextRetryAt = null
            this.state.mode = hello.mode || this.state.mode
            if (Number.isFinite(hello.seq)) this.lastSeq = hello.seq
            backoff = 1000
            this.stopPolling()
          },
          onEvent: (event) => {
            this.state.connected = true
            this.state.status = 'connected'
            this.state.error = null
            if (Number.isFinite(event._id)) this.lastSeq = event._id
            this.dispatch(event)
          },
        })
        if (outcome === 'aborted') break
        this.state.connected = false
        if (this.shouldStream()) {
          this.state.status = 'reconnecting'
          this.state.error = 'event stream ended; reconnecting'
        }
      } catch (error) {
        this.state.connected = false
        this.state.error = errorMessage(error)
        if (controller.signal.aborted) break
        if (error?.status === 404 || error?.code === 'EVENT_STREAM_UNAVAILABLE') {
          this.startPolling()
        } else {
          this.state.status = 'reconnecting'
        }
        this.log('event stream reconnect', { error: this.state.error, backoff })
      }
      if (!this.shouldStream()) break
      this.state.nextRetryAt = new Date(Date.now() + backoff).toISOString()
      await new Promise((resolve) => {
        const timer = this.clock.setTimeout(resolve, backoff)
        timer.unref?.()
        controller.signal.addEventListener('abort', () => { this.clock.clearTimeout(timer); resolve() }, { once: true })
      })
      if (this.state.status === 'reconnecting') this.state.status = 'connecting'
      backoff = Math.min(15000, Math.floor(backoff * 1.7))
    }
    this.state.connected = false
    this.state.nextRetryAt = null
    if (!this.shouldStream()) this.state.status = 'idle'
  }

  stopStream() {
    this.stopPolling()
    this.abort?.abort()
    this.abort = null
    this.state.connected = false
    this.state.nextRetryAt = null
    if (!this.shouldStream()) this.state.status = 'idle'
  }

  /** Poll devices when the A-side event stream is not deployed. */
  startPolling() {
    if (this.pollTimer) return
    this.state.fallback = true
    this.state.status = 'fallback'
    this.state.error = 'event stream endpoint unavailable; polling devices'
    const poll = async () => {
      try {
        const devices = await this.client.devices()
        const next = new Map((devices || []).map((device) => [device.id, device]))
        for (const [id, device] of next) {
          const previous = this.deviceCache.get(id)
          if (!previous) this.dispatch({ type: 'device.added', ts: new Date().toISOString(), deviceId: id, device })
          else if (previous.connected !== device.connected) {
            this.dispatch({
              type: device.connected ? 'device.connected' : 'device.disconnected',
              ts: new Date().toISOString(), deviceId: id, device,
            })
          } else if (JSON.stringify(previous.data || {}) !== JSON.stringify(device.data || {})) {
            this.dispatch({
              type: 'device.updated', ts: new Date().toISOString(), deviceId: id,
              changes: diffData(previous.data || {}, device.data || {}), data: device.data || {},
            })
          }
        }
        for (const [id, device] of this.deviceCache) {
          if (!next.has(id)) this.dispatch({ type: 'device.removed', ts: new Date().toISOString(), deviceId: id, device })
        }
        this.deviceCache = next
      } catch (error) {
        this.state.error = errorMessage(error)
      }
    }
    void poll()
    this.pollTimer = this.clock.setInterval(poll, 2000)
    this.pollTimer?.unref?.()
  }

  stopPolling() {
    if (this.pollTimer) this.clock.clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** Stop every subscription and the shared stream (plugin dispose / emergency). */
  dispose() {
    this.panelActive = false
    if (this.panelTimer) this.clock.clearTimeout(this.panelTimer)
    this.panelTimer = null
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id)
    this.stopStream()
    this.state.status = 'idle'
  }
}

/** Shallow key diff used by the polling fallback. */
export function diffData(previous, next) {
  const changes = {}
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) changes[key] = value
  }
  return changes
}
