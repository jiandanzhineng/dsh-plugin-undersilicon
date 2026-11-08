import { SafetyError } from '../util/errors.js'
import { watchdogClientId } from './watchdog.js'

const MIN_TTL = 5
const MAX_TTL = 600
const CAPABILITY_KEYS = ['strength', 'shock', 'vibration', 'suction', 'estim', 'motors', 'pump']

function percent(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(100, Math.round(number)))
}

/** Normalize the plugin limits into the backend lease shape (fail-closed). */
export function leaseLimits(limits = {}) {
  const defaultPercent = percent(limits?.default, 0)
  const capabilities = {}
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = limits?.capabilities?.[key] === undefined
      ? defaultPercent
      : percent(limits.capabilities[key], defaultPercent)
  }
  return { default: defaultPercent, capabilities }
}

function unsupportedError(cause) {
  return new SafetyError(
    '当前客户端版本不支持 agent 控制租约（/api/agent-control/lease 不存在），插件已拒绝控制。' +
    '请升级「硅基之下控制中心」客户端到包含 agent-control 的版本。' +
    ' The installed control-panel client does not support agent-control leases; upgrade the client before controlling devices.',
    'AGENT_LEASE_UNSUPPORTED',
    { cause: cause?.message, status: cause?.status, code: cause?.code },
  )
}

/**
 * One backend agent lease per agent session. The client id matches the device
 * watchdog id so both leases identify the same dsh session. The backend clamps
 * device writes against this lease as a second safety layer.
 */
export class AgentLease {
  constructor({ client, ttlSeconds = 30, limits = {}, clock = globalThis, log = () => {} } = {}) {
    this.client = client
    this.ttlSeconds = Math.max(MIN_TTL, Math.min(MAX_TTL, Number(ttlSeconds) || 30))
    this.limits = leaseLimits(limits)
    this.clock = clock
    this.log = log
    this.leases = new Map()
    this.supported = null
    this.fieldCaps = null
  }

  intervalMs() {
    return Math.max(2000, Math.floor(this.ttlSeconds * 1000 / 2))
  }

  /** Probe once at startup; 404/405 means this client build is too old. */
  async probe({ signal } = {}) {
    try {
      await this.client.agentLeaseStatus({ signal })
      this.supported = true
      return true
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        this.supported = false
        this.log('agent-control leases are not supported by this client build', { status: error?.status })
        return false
      }
      this.supported = null
      this.log('agent-control lease probe failed', { error: error?.message })
      return false
    }
  }

  /** Create or refresh the lease for one session before a control command. */
  async touch(sessionId, { reason = 'agent-control', signal, force = false } = {}) {
    const id = watchdogClientId(sessionId)
    let lease = this.leases.get(id)
    if (!lease) {
      lease = { clientId: id, sessionId, timer: null, lastBeat: null, errors: 0, disabled: false, fieldCaps: null, expiresAt: null }
      this.leases.set(id, lease)
      lease.timer = this.clock.setInterval(() => {
        void this.refresh(lease, 'refresh').catch((error) => {
          this.log('agent lease refresh rejected', { clientId: lease.clientId, error: error?.message })
        })
      }, this.intervalMs())
      lease.timer?.unref?.()
    }
    if (lease.disabled) return { ok: false, disabled: true, clientId: id }
    return this.refresh(lease, reason, { signal, force })
  }

  async refresh(lease, reason = 'refresh', { signal, force = false } = {}) {
    if (lease.disabled) return { ok: false, disabled: true, clientId: lease.clientId }
    if (this.supported === false && !force) throw unsupportedError()
    try {
      const result = await this.client.agentLeaseCreate(lease.clientId, this.ttlSeconds, this.limits, { signal })
      lease.lastBeat = new Date().toISOString()
      lease.fieldCaps = result?.fieldCaps || null
      lease.expiresAt = result?.expiresAt || null
      lease.errors = 0
      this.supported = true
      this.fieldCaps = lease.fieldCaps
      this.log('agent lease renewed', { clientId: lease.clientId, reason })
      return { ok: true, clientId: lease.clientId, result }
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        this.supported = false
        lease.disabled = true
        if (lease.timer) this.clock.clearInterval(lease.timer)
        this.leases.delete(lease.clientId)
        throw unsupportedError(error)
      }
      lease.errors += 1
      this.log('agent lease renewal failed', { clientId: lease.clientId, error: error?.message })
      return {
        ok: false, clientId: lease.clientId, status: error?.status || 0,
        error: error?.message, code: error?.code,
      }
    }
  }

  /** Ensure the lease exists; refuse control when the backend is too old or unreachable. */
  async ensure(sessionId, { reason = 'agent-control', signal } = {}) {
    if (!sessionId) return { ok: true, disabled: true }
    if (this.supported === false) throw unsupportedError()
    const result = await this.touch(sessionId, { reason, signal })
    if (result?.ok) return result
    throw new SafetyError(
      `agent 控制租约不可用，已拒绝下发：${result?.error || result?.code || 'unknown error'}。` +
      ` The backend agent-control lease is unavailable, so the command was not sent.`,
      'AGENT_LEASE_UNAVAILABLE', result || {},
    )
  }

  /** Apply a settings change immediately: push the new limits to every lease. */
  setLimits(limits) {
    this.limits = leaseLimits(limits)
    for (const lease of this.leases.values()) {
      void this.refresh(lease, 'limits-changed').catch((error) => {
        this.log('cannot push new lease limits', { clientId: lease.clientId, error: error?.message })
      })
    }
  }

  /** Follow a watchdog TTL change without dropping leases. */
  setTtl(seconds) {
    const next = Math.max(MIN_TTL, Math.min(MAX_TTL, Number(seconds) || 30))
    if (next === this.ttlSeconds) return
    this.ttlSeconds = next
    for (const lease of this.leases.values()) {
      if (lease.timer) this.clock.clearInterval(lease.timer)
      lease.timer = this.clock.setInterval(() => {
        void this.refresh(lease, 'refresh').catch((error) => {
          this.log('agent lease refresh rejected', { clientId: lease.clientId, error: error?.message })
        })
      }, this.intervalMs())
      lease.timer?.unref?.()
    }
  }

  /** Field caps reported by the backend for the latest lease (for honest results). */
  fieldCapsFor(sessionId) {
    if (!sessionId) return this.fieldCaps
    return this.leases.get(watchdogClientId(sessionId))?.fieldCaps || this.fieldCaps
  }

  /** Lease metadata for status/panel. */
  status() {
    return {
      supported: this.supported,
      ttlSeconds: this.ttlSeconds,
      limits: this.limits,
      leases: [...this.leases.values()].map((lease) => ({
        clientId: lease.clientId, sessionId: lease.sessionId,
        ttlSeconds: this.ttlSeconds, lastBeat: lease.lastBeat,
        errors: lease.errors, expiresAt: lease.expiresAt,
      })),
    }
  }

  /** Release one session's lease (session end). Stops that agent's plays in the backend. */
  async release(sessionId, { signal } = {}) {
    const id = watchdogClientId(sessionId)
    const lease = this.leases.get(id)
    if (!lease) return false
    if (lease.timer) this.clock.clearInterval(lease.timer)
    lease.disabled = true
    this.leases.delete(id)
    try {
      await this.client.agentLeaseRelease(id, { signal })
    } catch (error) {
      this.log('agent lease release failed', { clientId: id, error: error?.message })
    }
    return true
  }

  /** Release every lease (plugin dispose). */
  async releaseAll({ signal } = {}) {
    let released = 0
    for (const sessionId of [...this.leases.values()].map((lease) => lease.sessionId)) {
      if (await this.release(sessionId, { signal })) released += 1
    }
    return released
  }

  /** Stop renewal timers and release leases best-effort. */
  async dispose({ timeoutMs = 3000 } = {}) {
    const releasing = this.releaseAll()
    const timer = new Promise((resolve) => {
      const handle = setTimeout(resolve, timeoutMs)
      handle.unref?.()
    })
    await Promise.race([releasing.catch(() => {}), timer])
    for (const lease of this.leases.values()) if (lease.timer) this.clock.clearInterval(lease.timer)
    this.leases.clear()
  }
}
