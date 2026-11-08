import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Redact obvious secret-bearing keys before anything reaches disk. */
export function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]'
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) out[key] = '[redacted]'
      else out[key] = redact(item, depth + 1)
    }
    return out
  }
  if (typeof value === 'string' && value.length > 4000) return `${value.slice(0, 4000)}…[truncated]`
  return value
}

/** Daily JSONL audit log plus a small in-memory tail for the sidebar panel. */
export class AuditLog {
  constructor({ dir = join(homedir(), '.dsh', 'undersilicon'), enabled = true, keep = 100 } = {}) {
    this.dir = dir
    this.enabled = enabled
    this.keep = keep
    this.recentEntries = []
    this.queue = Promise.resolve()
    this.writeFailures = 0
  }

  /** Record one entry. Never throws and never blocks the caller. */
  record(entry) {
    const stamped = { ts: new Date().toISOString(), ...entry }
    const safe = redact(stamped)
    this.recentEntries.push(safe)
    if (this.recentEntries.length > this.keep) this.recentEntries.shift()
    if (!this.enabled) return
    const line = `${JSON.stringify(safe)}\n`
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true })
        const day = stamped.ts.slice(0, 10)
        await appendFile(join(this.dir, `audit-${day}.jsonl`), line, 'utf8')
      } catch {
        this.writeFailures += 1
      }
    })
  }

  /** Wait for queued writes (tests and graceful shutdown). */
  async flush() {
    await this.queue
  }

  /** Most recent entries, newest first. */
  recent(limit = 20) {
    return this.recentEntries.slice(-Math.max(1, Math.min(200, limit))).reverse()
  }
}
