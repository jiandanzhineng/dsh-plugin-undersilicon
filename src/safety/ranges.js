/**
 * Built-in numeric ranges for control-panel capability inputs.
 * Mirrors backend/devices/capabilities.js and the shipped UI sliders. The
 * backend's `/api/device-capabilities` ranges always win when present.
 */
export const FALLBACK_RANGES = Object.freeze({
  shock: { start: { voltage: { min: 0, max: 100, unit: 'V' } } },
  strength: { set: { value: { min: 0, max: 255 } } },
  vibration: { set: { value: { min: 0, max: 100 } } },
  suction: { set: { value: { min: 0, max: 100 } } },
  estim: { set: { intensity: { min: 0, max: 255 } } },
  motors: { set: { 'channels.*.value': { min: 0, max: 255 }, 'channels.*': { min: 0, max: 255 } } },
  pump: { start: { rate: { min: 0, max: 255 }, ss: { min: 0, max: 255 } } },
})

/** Only intensity-like fields may be threshold-scaled. Config values stay intact. */
const SCALABLE = {
  strength: [/^value$/],
  shock: [/^voltage$/],
  vibration: [/^value$/],
  suction: [/^value$/],
  estim: [/^intensity$/],
  motors: [/^channels\.[^.]+(\.value)?$/],
  pump: [/^rate$/, /^ss$/],
}

/** Capabilities whose parameters can command physical output. */
export function isIntensityCapability(capability) {
  return Object.prototype.hasOwnProperty.call(SCALABLE, String(capability))
}

/** Whether a capability field participates in threshold scaling. */
export function isScalableField(capability, field) {
  const patterns = SCALABLE[capability]
  if (!patterns) return false
  return patterns.some((pattern) => pattern.test(String(field)))
}

/** Keep only scalable entries from one capability's action field map. */
function filterFields(capability, fields) {
  const out = {}
  for (const [field, range] of Object.entries(fields || {})) {
    if (isScalableField(capability, field)) out[field] = range
  }
  return out
}

/** Normalize one range-like object into `{min,max,unit?}` or undefined. */
export function normalizeRange(value) {
  if (!value || typeof value !== 'object') return undefined
  let min = value.min ?? value.minimum
  let max = value.max ?? value.maximum
  if (Array.isArray(value.range)) [min, max] = value.range
  if (Array.isArray(value.values) && value.values.length >= 2) [min, max] = value.values
  if (!Number.isFinite(Number(min)) || !Number.isFinite(Number(max))) return undefined
  const lo = Number(min)
  const hi = Number(max)
  if (hi < lo) return undefined
  return { min: lo, max: hi, ...(typeof value.unit === 'string' ? { unit: value.unit } : {}) }
}

/** Collect field ranges from one object whose keys are field paths. */
function collectFieldMap(target, prefix, source) {
  if (!source || typeof source !== 'object') return
  for (const [key, value] of Object.entries(source)) {
    const range = normalizeRange(value)
    if (range) {
      target[prefix ? `${prefix}.${key}` : key] = range
      continue
    }
    if (value && typeof value === 'object') {
      collectFieldMap(target, prefix ? `${prefix}.${key}` : key, value.fields || value.properties || value)
    }
  }
}

/**
 * Extract machine-readable ranges from `/api/device-capabilities`.
 * Accepts several shapes so the main-repo contract can evolve without a plugin
 * release: `capabilityRanges[cap][action]`, `capabilityConfig[cap].ranges`,
 * `capabilityConfig[cap].actions[action].{inputs,parameters,ranges}`.
 * @returns {Record<string, Record<string, Record<string, {min:number,max:number,unit?:string}>>>}
 */
export function extractApiRanges(payload) {
  const out = {}
  if (!payload || typeof payload !== 'object') return out
  const merge = (cap, action, fields) => {
    if (!cap || !action || !fields) return
    const kept = filterFields(cap, fields)
    if (Object.keys(kept).length === 0) return
    out[cap] ??= {}
    out[cap][action] ??= {}
    collectFieldMap(out[cap][action], '', kept)
  }
  for (const [cap, actions] of Object.entries(payload.capabilityRanges || payload.ranges || {})) {
    if (!actions || typeof actions !== 'object') continue
    for (const [action, fields] of Object.entries(actions)) merge(cap, action, filterFields(cap, fields))
  }
  for (const [cap, def] of Object.entries(payload.capabilityConfig || {})) {
    if (!def || typeof def !== 'object') continue
    if (def.ranges && typeof def.ranges === 'object') {
      for (const [action, fields] of Object.entries(def.ranges)) merge(cap, action, fields)
    }
    const actions = def.actions || def.actionRanges
    if (actions && typeof actions === 'object') {
      for (const [action, actionDef] of Object.entries(actions)) {
        if (!actionDef || typeof actionDef !== 'object') continue
        merge(cap, action, filterFields(cap, actionDef.ranges || actionDef.inputs || actionDef.parameters || actionDef.input))
      }
    }
    const actionParams = def.actionParams
    if (actionParams && typeof actionParams === 'object') {
      for (const [action, fields] of Object.entries(actionParams)) merge(cap, action, filterFields(cap, fields))
    }
  }
  return out
}

/** Deep-merge fallback ranges with API ranges; API values win field by field. */
export function mergeRanges(apiRanges) {
  const out = {}
  for (const [cap, actions] of Object.entries(FALLBACK_RANGES)) {
    out[cap] = {}
    for (const [action, fields] of Object.entries(actions)) out[cap][action] = { ...fields }
  }
  for (const [cap, actions] of Object.entries(apiRanges || {})) {
    out[cap] ??= {}
    for (const [action, fields] of Object.entries(actions)) {
      out[cap][action] = { ...(out[cap][action] || {}), ...filterFields(cap, fields) }
    }
  }
  return out
}

/** Index ranges by bare field name, keeping the most conservative (lowest) max. */
export function indexByFieldName(ranges) {
  const out = {}
  const visit = (fields) => {
    for (const [path, range] of Object.entries(fields)) {
      const name = path.split('.').pop()
      if (!out[name] || range.max < out[name].max) out[name] = range
    }
  }
  for (const actions of Object.values(ranges)) for (const fields of Object.values(actions)) visit(fields)
  return out
}
