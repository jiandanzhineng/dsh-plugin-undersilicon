import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SafetyError } from './util/errors.js'

const DEFAULT_FILE = join(homedir(), '.dsh', 'undersilicon', 'settings.json')
const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function percent(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new SafetyError(`${name} must be a number between 0 and 100`, 'INVALID_SETTING', { name, value })
  }
  return Math.round(number)
}

/** Validate a partial settings patch; unknown keys are refused. */
export function validateSettingsPatch(input, current = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SafetyError('settings patch must be an object', 'INVALID_SETTING')
  }
  const next = clone(current) || {}
  for (const key of Object.keys(input)) {
    if (!['limits', 'stopOnSessionEnd', 'scripts', 'watchdogTtlSec', 'updatedAt'].includes(key)) {
      throw new SafetyError(`unknown setting "${key}"`, 'INVALID_SETTING', { key })
    }
  }
  if (input.limits !== undefined) {
    if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) {
      throw new SafetyError('limits must be an object', 'INVALID_SETTING')
    }
    next.limits ??= {}
    if (input.limits.default !== undefined) next.limits.default = percent(input.limits.default, 'limits.default')
    if (input.limits.capabilities !== undefined) {
      if (!input.limits.capabilities || typeof input.limits.capabilities !== 'object' || Array.isArray(input.limits.capabilities)) {
        throw new SafetyError('limits.capabilities must be an object', 'INVALID_SETTING')
      }
      const capabilities = { ...(next.limits.capabilities || {}) }
      for (const [capability, value] of Object.entries(input.limits.capabilities)) {
        if (!CAPABILITY_KEY.test(capability)) {
          throw new SafetyError(`invalid capability key "${capability}"`, 'INVALID_SETTING')
        }
        capabilities[capability] = percent(value, `limits.capabilities.${capability}`)
      }
      next.limits.capabilities = capabilities
    }
  }
  if (input.stopOnSessionEnd !== undefined) {
    if (typeof input.stopOnSessionEnd !== 'boolean') {
      throw new SafetyError('stopOnSessionEnd must be a boolean', 'INVALID_SETTING')
    }
    next.stopOnSessionEnd = input.stopOnSessionEnd
  }
  if (input.watchdogTtlSec !== undefined) {
    const ttl = Number(input.watchdogTtlSec)
    if (!Number.isFinite(ttl) || ttl < 5 || ttl > 600) {
      throw new SafetyError('watchdogTtlSec must be between 5 and 600 seconds', 'INVALID_SETTING')
    }
    next.watchdogTtlSec = Math.round(ttl)
  }
  if (input.scripts !== undefined) {
    if (!input.scripts || typeof input.scripts !== 'object' || Array.isArray(input.scripts)) {
      throw new SafetyError('scripts must be an object', 'INVALID_SETTING')
    }
    next.scripts ??= {}
    if (input.scripts.allowPersist !== undefined) {
      if (typeof input.scripts.allowPersist !== 'boolean') {
        throw new SafetyError('scripts.allowPersist must be a boolean', 'INVALID_SETTING')
      }
      next.scripts.allowPersist = input.scripts.allowPersist
    }
  }
  return next
}

/**
 * Settings override the profile config (ADR: panel is the only editor).
 * The file stores only overrides; effective values are recomputed from the
 * profile config plus the file on every change.
 */
export class SettingsStore {
  constructor({ file = DEFAULT_FILE, config = {}, log = () => {} } = {}) {
    this.file = file
    this.base = clone(config) || {}
    this.log = log
    this.data = this.load()
    this.config = this.base
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return validateSettingsPatch(parsed, {})
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('cannot read settings file', { error: error.message, file: this.file })
      return {}
    }
  }

  /** Recompute effective config from base profile config + file overrides. */
  applyTo() {
    const base = clone(this.base) || {}
    const data = this.data || {}
    const baseLimits = base.limits || {}
    const config = {
      ...base,
      limits: {
        ...baseLimits,
        default: data.limits?.default ?? baseLimits.default ?? 60,
        capabilities: {
          ...(baseLimits.capabilities || {}),
          ...(data.limits?.capabilities || {}),
        },
      },
      stopOnSessionEnd: data.stopOnSessionEnd ?? base.stopOnSessionEnd ?? true,
      watchdogTtlSec: data.watchdogTtlSec ?? base.watchdogTtlSec ?? 30,
      scripts: {
        ...(base.scripts || {}),
        ...(data.scripts || {}),
      },
    }
    this.config = config
    return config
  }

  /** Effective settings plus whether the file overrides the profile. */
  snapshot() {
    return {
      file: this.file,
      overrides: clone(this.data) || {},
      limits: clone(this.config.limits) || {},
      stopOnSessionEnd: this.config.stopOnSessionEnd,
      watchdogTtlSec: this.config.watchdogTtlSec,
      scripts: { allowPersist: this.config.scripts?.allowPersist !== false },
      hasOverrides: Object.keys(this.data || {}).length > 0,
    }
  }

  /** Validate, persist and apply a patch. Returns the effective snapshot. */
  async update(patch) {
    const next = validateSettingsPatch(patch, this.data)
    next.updatedAt = new Date().toISOString()
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
    await rename(temp, this.file)
    this.data = next
    this.applyTo()
    return this.snapshot()
  }
}
