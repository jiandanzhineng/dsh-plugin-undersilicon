/** Deep-clone a JSON-like value. */
export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Enumerate numeric leaves with dot paths (`channels.stroke.value`). */
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

/**
 * Scale one capability action input to the configured thresholds.
 * @param {{capability:string,action:string,input:unknown,limits:object,ranges:object}} options
 * @returns {{input:unknown, clamped:Array<object>, unscaled:string[], percent:number}}
 */
export function scaleCapabilityInput({ capability, action, input, limits, ranges }) {
  if (input === undefined || input === null || typeof input !== 'object') {
    return { input, clamped: [], unscaled: [], percent: resolvePercent(limits, capability, action) }
  }
  const output = cloneJson(input)
  const clamped = []
  const unscaled = []
  const fieldRanges = ranges?.[capability]?.[action]
  const percent = resolvePercent(limits, capability, action)
  for (const leaf of flattenNumbers(input)) {
    const field = leaf.path
    const range = findRange(fieldRanges, field)
    if (!range) { unscaled.push(field); continue }
    const effectivePercent = resolvePercent(limits, capability, action, field)
    const upper = limitFor(range, effectivePercent)
    let applied = leaf.value
    let reason
    if (applied < range.min) { applied = range.min; reason = 'below-range' }
    else if (applied > upper) {
      applied = upper
      reason = upper >= range.max ? 'above-range' : 'above-threshold'
    }
    if (applied !== leaf.value) {
      if (Number.isInteger(leaf.value) && Number.isInteger(range.min) && Number.isInteger(range.max)) {
        applied = Math.round(applied)
      }
      setByPath(output, field, applied)
      clamped.push({
        field, requested: leaf.value, applied, min: range.min, max: range.max,
        limit: upper, percent: effectivePercent,
        ...(range.unit ? { unit: range.unit } : {}), reason,
      })
    }
  }
  return { input: output, clamped, unscaled, percent }
}

/**
 * Scale a preset operation whose capability/action may be unknown. Field-name
 * ranges are used as a conservative last resort; unknown numerics stay untouched.
 */
export function scaleOperationInput({ operation, input, limits, ranges }) {
  if (operation?.capability && operation?.action) {
    return scaleCapabilityInput({
      capability: operation.capability, action: operation.action, input, limits, ranges,
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
  for (const leaf of flattenNumbers(input)) {
    const name = leaf.path.split('.').pop()
    const range = nameIndex[name]
    if (!range) { unscaled.push(leaf.path); continue }
    const percent = resolvePercent(limits, operation?.capability || 'operation', operation?.key)
    const upper = limitFor(range, percent)
    let applied = leaf.value
    if (applied > upper) applied = upper
    if (applied < range.min) applied = range.min
    if (applied !== leaf.value) {
      setByPath(output, leaf.path, Math.round(applied))
      clamped.push({
        field: leaf.path, requested: leaf.value, applied: Math.round(applied),
        min: range.min, max: range.max, limit: upper, percent, reason: 'above-threshold',
      })
    }
  }
  return { input: output, clamped, unscaled, percent: resolvePercent(limits, 'operation', operation?.key) }
}
