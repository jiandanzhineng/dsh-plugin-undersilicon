/** Build a watchdog client id that satisfies the backend's 1-96 char grammar. */
export function watchdogClientId(sessionId) {
  const raw = String(sessionId || 'session').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80)
  return `dsh-${raw || 'session'}`
}

/**
 * Keeps one device-watchdog lease alive per active agent session.
 * A lease is created only after the agent actually controls a device.
 */
export class Watchdog {
  constructor({ client, ttlSeconds = 30, clock = globalThis, log = () => {} } = {}) {
    this.client = client
    this.ttlSeconds = Math.max(5, Math.min(600, Number(ttlSeconds) || 30))
    this.clock = clock
    this.log = log
    this.leases = new Map()
  }

  intervalMs() {
    return Math.max(2000, Math.floor(this.ttlSeconds * 1000 / 2))
  }

  /** Create or refresh the lease for one session. Safe to call on every control. */
  async touch(sessionId, { reason = 'agent-control' } = {}) {
    const id = watchdogClientId(sessionId)
    let lease = this.leases.get(id)
    if (!lease) {
      lease = { clientId: id, sessionId, timer: null, lastBeat: null, errors: 0, disabled: false }
      this.leases.set(id, lease)
      lease.timer = this.clock.setInterval(() => { void this.refresh(lease) }, this.intervalMs())
      lease.timer?.unref?.()
    }
    if (lease.disabled) return { ok: false, disabled: true, clientId: id }
    return this.refresh(lease, reason)
  }

  /** Send one heartbeat. A 423 means remote mode owns safety; stop renewing. */
  async refresh(lease, reason = 'refresh') {
    if (lease.disabled) return { ok: false, disabled: true, clientId: lease.clientId }
    try {
      const result = await this.client.watchdogHeartbeat(lease.clientId, this.ttlSeconds)
      lease.lastBeat = new Date().toISOString()
      lease.errors = 0
      this.log('watchdog heartbeat', { clientId: lease.clientId, reason })
      return result
    } catch (error) {
      if (error?.status === 423) {
        this.stop(lease.clientId)
        this.log('watchdog disabled in remote mode', { clientId: lease.clientId })
        return { ok: false, disabled: true, clientId: lease.clientId, code: error.code }
      }
      lease.errors += 1
      this.log('watchdog heartbeat failed', { clientId: lease.clientId, error: error?.message })
      return { ok: false, error: error?.message, code: error?.code, clientId: lease.clientId }
    }
  }

  /** Stop renewing one lease by client id or session id. */
  stop(idOrSession) {
    const id = String(idOrSession).startsWith('dsh-') ? idOrSession : watchdogClientId(idOrSession)
    const lease = this.leases.get(id)
    if (!lease) return false
    if (lease.timer) this.clock.clearInterval(lease.timer)
    lease.disabled = true
    this.leases.delete(id)
    return true
  }

  /** Current lease metadata for status/panel. */
  status() {
    return [...this.leases.values()].map((lease) => ({
      clientId: lease.clientId, sessionId: lease.sessionId,
      ttlSeconds: this.ttlSeconds, lastBeat: lease.lastBeat, errors: lease.errors,
    }))
  }

  /** Stop every timer without sending stop commands (plugin dispose / process exit). */
  dispose() {
    for (const lease of this.leases.values()) {
      if (lease.timer) this.clock.clearInterval(lease.timer)
      lease.disabled = true
    }
    this.leases.clear()
  }
}
