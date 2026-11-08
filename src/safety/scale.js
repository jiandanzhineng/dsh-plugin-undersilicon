/** Deep-clone a JSON-like value. */
import { SafetyError } from '../util/errors.js'
import { isIntensityCapability, isScalableField } from './ranges.js'

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const NUMERIC_STRING = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** Strict number parsing: numbers must be finite; strings must be plain decimals. */
export function parseStrictNumber(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SafetyError(`intensity field "${field}" is not a finite number`, 'INVALID_INTENSITY_VALUE', { field })
    }
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!NUMERIC_STRING.test(text)) {
      throw new SafetyError(`intensity field "${field}" must be a number or decimal string`, 'INVALID_INTENSITY_VALUE', { field, value })
    }
    const number = Number(text)
    if (!Number.isFinite(number)) {
      throw new SafetyError(`intensity field "${field}" is not finite`, 'INVALID_INTENSITY_VALUE', { field, value })
    }
    return number
  }
  throw new SafetyError(`intensity field "${field}" must be a number or decimal string`, 'INVALID_INTENSITY_VALUE', { field })
}

/** Whether a numeric field is a known non-intensity configuration leaf. */
function allowedNonIntensityField(capability, path) {
  if (capability === 'motors') return /^channels\.[^.]+\.direction$/.test(path)
  return false
}

/** Enumerate every scalar leaf that could carry a number. */
export function flattenLeaves(value, prefix = '', out = []) {
  if (typeof value === 'number' || typeof value === 'string') {
    out.push({ path: prefix, value })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenLeaves(item, prefix ? `${prefix}.${index}` : String(index), out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flattenLeaves(item, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

/** Backwards-compatible numeric-only enumeration. */
export function flattenNumbers(value, prefix = '', out = []) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push({ path: prefix, value })
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenNumbers(item, prefix ? `${prefix}.${index}` : String(index), out))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flattenNumbers(item, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

/** Write one dot-path back into a cloned input. */
export function setByPath(target, path, value) {
  const parts = String(path).split('.')
  let cursor = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') return target
    cursor = cursor[key]
  }
  cursor[parts.at(-1)] = value
  return target
}

/** Find the range for a exact path, then the most specific `*` pattern. */
export function findRange(fieldRanges, path) {
  if (!fieldRanges) return undefined
  if (fieldRanges[path]) return fieldRanges[path]
  const parts = String(path).split('.')
  let best
  let bestLiteral = -1
  for (const [pattern, range] of Object.entries(fieldRanges)) {
    if (!pattern.includes('*')) continue
    const patternParts = pattern.split('.')
    if (patternParts.length !== parts.length) continue
    let literal = 0
    let ok = true
    for (let i = 0; i < parts.length; i += 1) {
      if (patternParts[i] === '*') continue
      if (patternParts[i] !== parts[i]) { ok = false; break }
      literal += 1
    }
    if (ok && literal > bestLiteral) { best = range; bestLiteral = literal }
  }
  return best
}

/** Resolve the configured percentage for a capability/action/field. */
export function resolvePercent(limits, capability, action, field) {
  const fallback = Number(limits?.default ?? 60)
  const capConfig = limits?.capabilities?.[capability]
  let percent = fallback
  if (typeof capConfig === 'number') percent = capConfig
  else if (capConfig && typeof capConfig === 'object') {
    percent = Number(capConfig.percent ?? fallback)
    if (action !== undefined && capConfig.actions && capConfig.actions[action] !== undefined) {
      percent = Number(capConfig.actions[action])
    }
    if (field !== undefined && capConfig.fields && capConfig.fields[field] !== undefined) {
      percent = Number(capConfig.fields[field])
    }
  }
  if (!Number.isFinite(percent)) percent = 60
  return Math.max(0, Math.min(100, percent))
}

/** Compute the applied upper bound for one range and percentage. */
export function limitFor(range, percent) {
  return range.min + (range.max - range.min) * (Math.max(0, Math.min(100, percent)) / 100)
}

/** Backend actions that silently substitute a default when a field is omitted. */
const IMPLICIT_DEFAULTS = {
  shock: { start: { voltage: 24 } },
}

/** Fields the plugin understands for each intensity capability action. */
const INTENSITY_FIELDS = {
  strength: { set: ['value'], stop: [] },
  shock: { start: ['voltage'], stop: [] },
  vibration: { set: ['value'], stop: [] },
  suction: { set: ['value'], stop: [] },
  estim: { set: ['intensity', 'channel', 'wave'], stop: [] },
  motors: { set: ['channels'], stop: [] },
  pump: { start: ['protocol', 'scene', 'rate', 'ss'], stop: [] },
}
const OUTPUT_FIELDS = new Set(['value', 'voltage', 'intensity', 'rate', 'ss'])
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const CHANNEL_NAME = /^[A-Za-z0-9_-]{1,32}$/
const CHANNELS_BY_TYPE = {
  YCY_TOY: ['a', 'b', 'c'],
  YCY_CUP: ['stroke', 'vibe', 'axis'],
}

function invalidValue(field, value, capability, action) {
  throw new SafetyError(
    `强度字段 "${field}" 必须是有限数字（不接受布尔/对象/数组/非数字字符串）。` +
    `Intensity field "${field}" must be a finite number; booleans, objects, arrays and non-numeric strings are refused.`,
    'INVALID_INTENSITY_VALUE', { capability, action, field, value },
  )
}

/** Reject dot paths, prototype keys, bad channel shapes and non-numeric output values. */
export function assertIntensityInput({ capability, action, input, deviceType }) {
  const allowed = INTENSITY_FIELDS[capability]?.[String(action).toLowerCase()]
  if (!allowed) return
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new SafetyError(`capability "${capability}.${action}" input must be an object`, 'INVALID_INPUT', { capability, action })
  }
  for (const key of Object.keys(source)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new SafetyError(`refused dangerous field "${key}"`, 'UNKNOWN_INTENSITY_FIELD', { capability, action, field: key })
    }
    if (!allowed.includes(key)) {
      throw new SafetyError(
        `capability "${capability}.${action}" refuses unknown numeric field "${key}"; allowed: ${allowed.join(', ') || '(none)'}`,
        'UNKNOWN_INTENSITY_FIELD', { capability, action, field: key },
      )
    }
  }
  for (const field of allowed) {
    if (!OUTPUT_FIELDS.has(field) || source[field] === undefined) continue
    try {
      parseStrictNumber(source[field], field)
    } catch {
      invalidValue(field, source[field], capability, action)
    }
  }
  if (capability === 'motors' && source.channels !== undefined) assertChannels(source.channels, action, deviceType)
}

function assertChannels(channels, action, deviceType) {
  const known = CHANNELS_BY_TYPE[deviceType]
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new SafetyError(
      'motors.set channels 必须是对象 {name: 数字|{value,direction}}。motors.set channels must be an object.',
      'INVALID_INTENSITY_VALUE', { capability: 'motors', action, field: 'channels' },
    )
  }
  for (const [name, raw] of Object.entries(channels)) {
    if (DANGEROUS_KEYS.has(name) || name.includes('.') || !CHANNEL_NAME.test(name)) {
      throw new SafetyError(
        `motors 通道名 "${name}" 非法（不允许点号/原型键/特殊字符）。Invalid motors channel name "${name}".`,
        'UNKNOWN_INTENSITY_FIELD', { capability: 'motors', action, field: `channels.${name}` },
      )
    }
    if (known && !known.includes(name)) {
      throw new SafetyError(
        `设备 ${deviceType} 不支持 motors 通道 "${name}"；允许：${known.join(', ')}。` +
        ` Device ${deviceType} does not have motors channel "${name}"; allowed: ${known.join(', ')}.`,
        'UNKNOWN_CHANNEL', { capability: 'motors', action, field: `channels.${name}`, deviceType, allowed: known },
      )
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const key of Object.keys(raw)) {
        if (key !== 'value' && key !== 'direction') {
          throw new SafetyError(
            `motors 通道 "${name}" 不允许字段 "${key}"。Invalid motors channel field "${key}".`,
            'UNKNOWN_INTENSITY_FIELD', { capability: 'motors', action, field: `channels.${name}.${key}` },
          )
        }
      }
      try {
        parseStrictNumber(raw.value, `channels.${name}.value`)
      } catch {
        invalidValue(`channels.${name}.value`, raw.value, 'motors', action)
      }
      if (raw.direction !== undefined && ![ -1, 0, 1 ].includes(Number(raw.direction))) {
        throw new SafetyError(
          `motors 通道 "${name}" 的 direction 只能是 -1、0 或 1。direction must be -1, 0 or 1.`,
          'INVALID_INTENSITY_VALUE', { capability: 'motors', action, field: `channels.${name}.direction`, value: raw.direction },
        )
      }
      continue
    }
    try {
      parseStrictNumber(raw, `channels.${name}`)
    } catch {
      invalidValue(`channels.${name}`, raw, 'motors', action)
    }
  }
}

/**
 * Scale one capability action input to the configured thresholds.
 * Numeric strings are parsed and sent back as numbers; unknown numeric fields
 * in intensity capabilities are refused instead of being passed through.
 * @param {{capability:string,action:string,input:unknown,limits:object,ranges:object}} options
 * @returns {{input:unknown, clamped:Array<object>, unscaled:string[], percent:number}}
 */
export function scaleCapabilityInput({ capability, action, input, limits, ranges, deviceType }) {
  const intensity = isIntensityCapability(capability)
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new SafetyError(`capability "${capability}.${action}" input must be an object`, 'INVALID_INPUT', { capability, action })
  }
  assertIntensityInput({ capability, action, input: source, deviceType })
  // JSON.stringify would turn NaN/Infinity into null before any range check.
  for (const leaf of flattenLeaves(source)) {
    if (typeof leaf.value === 'number' && !Number.isFinite(leaf.value)) {
      throw new SafetyError(`intensity field "${leaf.path}" is not a finite number`, 'INVALID_INTENSITY_VALUE', {
        capability, action, field: leaf.path,
      })
    }
  }
  const output = cloneJson(source)
  const clamped = []
  const unscaled = []
  const fieldRanges = ranges?.[capability]?.[action]
  const percent = resolvePercent(limits, capability, action)
  const implicit = IMPLICIT_DEFAULTS[capability]?.[action]
  for (const [field, value] of Object.entries(implicit || {})) {
    if (output[field] === undefined) output[field] = value
  }
  for (const leaf of flattenLeaves(output)) {
    const field = leaf.path
    const range = findRange(fieldRanges, field)
    if (!range) {
      let numeric
      try {
        numeric = parseStrictNumber(leaf.value, field)
      } catch (error) {
        if (typeof leaf.value === 'number') throw error
        numeric = undefined
      }
      if (numeric !== undefined) {
        if (intensity && !allowedNonIntensityField(capability, field)) {
          throw new SafetyError(
            `capability "${capability}.${action}" refuses unknown numeric field "${field}"; use a documented input field`,
            'UNKNOWN_INTENSITY_FIELD', { capability, action, field },
          )
        }
        unscaled.push(field)
      }
      continue
    }
    const requested = parseStrictNumber(leaf.value, field)
    const effectivePercent = resolvePercent(limits, capability, action, field)
    const upper = limitFor(range, effectivePercent)
    let applied = requested
    let reason
    if (applied < range.min) { applied = range.min; reason = 'below-range' }
    else if (applied > upper) {
      applied = upper
      reason = upper >= range.max ? 'above-range' : 'above-threshold'
    }
    if (typeof leaf.value === 'string') {
      // The backend only accepts real JSON numbers; always send the parsed value.
      setByPath(output, field, applied)
    }
    if (applied !== requested) {
      if (Number.isInteger(requested) && Number.isInteger(range.min) && Number.isInteger(range.max)) {
        // A 30% cap on 0..255 is 76.5: the reachable integer must be 76, not 77.
        applied = Math.floor(applied)
      }
      setByPath(output, field, applied)
      clamped.push({
        field, requested, applied, min: range.min, max: range.max,
        limit: upper, percent: effectivePercent,
        ...(range.unit ? { unit: range.unit } : {}), reason,
      })
    }
  }
  for (const item of clamped) {
    if (item.requested > 0 && item.applied < 1) {
      throw new SafetyError(
        `"${capability}.${action}" 按当前阈值只能应用 ${item.field}=${item.applied}（请求 ${item.requested}），阈值过低没有实际意义，已拒绝。` +
        ` Refused: the configured threshold is too low to be meaningful (would apply ${item.field}=${item.applied} for requested ${item.requested}).`,
        'INTENSITY_BELOW_MINIMUM', { capability, action, ...item },
      )
    }
  }
  if (capability === 'shock' && action === 'start' && Number(output.voltage) < 1) {
    throw new SafetyError(
      '电击启动必须显式发送电压，但缩放后的电压低于 1V，已拒绝（否则后端会用 24V 默认值）。' +
      ' shock.start always sends an explicit voltage; the scaled value is below 1V, so the action was refused ' +
      '(the backend would otherwise substitute its 24V default).',
      'INTENSITY_BELOW_MINIMUM', { capability, action, voltage: output.voltage, percent },
    )
  }
  return { input: output, clamped, unscaled, percent }
}

/**
 * Scale a preset operation whose capability/action may be unknown. Field-name
 * ranges are used as a conservative last resort; unknown numerics stay untouched.
 */
export function scaleOperationInput({ operation, input, limits, ranges, deviceType }) {
  if (operation?.capability && operation?.action) {
    return scaleCapabilityInput({
      capability: operation.capability, action: operation.action, input, limits, ranges, deviceType,
    })
  }
  const nameIndex = {}
  for (const actions of Object.values(ranges || {})) {
    for (const fields of Object.values(actions)) {
      for (const [path, range] of Object.entries(fields)) {
        const name = path.split('.').pop()
        if (!nameIndex[name] || range.max < nameIndex[name].max) nameIndex[name] = range
      }
    }
  }
  const output = cloneJson(input)
  const clamped = []
  const unscaled = []
  for (const leaf of flattenLeaves(output)) {
    const name = leaf.path.split('.').pop()
    const range = nameIndex[name]
    if (!range) {
      try {
        if (parseStrictNumber(leaf.value, leaf.path) !== undefined) unscaled.push(leaf.path)
      } catch (error) {
        if (typeof leaf.value === 'number') throw error
      }
      continue
    }
    const requested = parseStrictNumber(leaf.value, leaf.path)
    const percent = resolvePercent(limits, operation?.capability || 'operation', operation?.key)
    const upper = limitFor(range, percent)
    let applied = requested
    if (applied > upper) applied = upper
    if (applied < range.min) applied = range.min
    if (applied !== requested) {
      if (Number.isInteger(requested) && Number.isInteger(range.min) && Number.isInteger(range.max)) {
        applied = Math.floor(applied)
      }
      setByPath(output, leaf.path, applied)
      clamped.push({
        field: leaf.path, requested, applied,
        min: range.min, max: range.max, limit: upper, percent, reason: 'above-threshold',
      })
    }
  }
  return { input: output, clamped, unscaled, percent: resolvePercent(limits, 'operation', operation?.key) }
}
