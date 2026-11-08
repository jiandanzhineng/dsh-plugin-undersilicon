/**
 * Game parameter scaling. Backend manifests (game-runtime/games and /games)
 * expose `devices[].capabilities` and params with an optional `device` logical
 * id. We map those to capability ranges, with an explicit table for the known
 * intensity keys that manifests do not tag.
 */
import { SafetyError } from '../util/errors.js'
import { scaleCapabilityInput } from './scale.js'

const CAPABILITY_PRIORITY = ['strength', 'shock', 'vibration', 'suction', 'estim', 'pump', 'motors']

const FIELD_BY_CAPABILITY = {
  strength: { action: 'set', field: 'value' },
  shock: { action: 'start', field: 'voltage' },
  vibration: { action: 'set', field: 'value' },
  suction: { action: 'set', field: 'value' },
  estim: { action: 'set', field: 'intensity' },
  pump: { action: 'start', field: 'rate' },
}

const KEY_MAP = {
  maxmotorintensity: ['strength', 'set', 'value'],
  motorintensity: ['strength', 'set', 'value'],
  midintensitymin: ['strength', 'set', 'value'],
  midintensitymax: ['strength', 'set', 'value'],
  shockvoltage: ['shock', 'start', 'voltage'],
  shockintensity: ['shock', 'start', 'voltage'],
  voltage: ['shock', 'start', 'voltage'],
  strength: ['strength', 'set', 'value'],
  power: ['strength', 'set', 'value'],
  pumpss: ['pump', 'start', 'ss'],
}

/** Numeric game params that are timing/config values, never output intensity. */
const NON_INTENSITY_KEYS = new Set([
  'duration', 'shockduration', 'endcalmlock', 'surgewindowsec', 'surgerisekpa',
  'midoffsetkpa', 'lowpressuredelay', 'maxedgesec', 'gradualincrease',
  'randompercent', 'minsurgems', 'sendintervalms', 'middelay', 'ramprate',
  'shockduration', 'durationminutes',
])

const LOOKS_INTENSE = /(motorintensity|shockvoltage|shockintensity|strength|shock|vibrat|suction|estim|intensity|percent)/i

/** Build a gameId → schema map from the two list endpoints. */
export function gameSchemaMap(games, hostGames) {
  const map = new Map()
  for (const game of [...(games || []), ...(hostGames || [])]) {
    if (!game || !game.id) continue
    map.set(String(game.id), {
      devices: Array.isArray(game.devices) ? game.devices : [],
      params: Array.isArray(game.params) ? game.params : [],
    })
  }
  return map
}

function capabilityForParam(key, schema) {
  const lowered = String(key).toLowerCase()
  if (KEY_MAP[lowered]) {
    const [capability, action, field] = KEY_MAP[lowered]
    return { capability, action, field }
  }
  if (NON_INTENSITY_KEYS.has(lowered)) return null
  const definition = (schema?.params || []).find((param) => String(param.key).toLowerCase() === lowered)
  if (definition?.device) {
    const device = (schema.devices || []).find((item) => item.id === definition.device)
    const intensityDevice = (device?.capabilities || []).some((item) => CAPABILITY_PRIORITY.includes(item))
    if (!intensityDevice) return null
    // A device-tagged numeric parameter always drives that device; its units
    // must be recognizable, otherwise we refuse rather than scale the wrong thing.
    let capability
    if (/voltage/.test(lowered)) capability = 'shock'
    else if (/vibrat/.test(lowered)) capability = 'vibration'
    else if (/suction/.test(lowered)) capability = 'suction'
    else if (/estim/.test(lowered)) capability = 'estim'
    else if (/pump|rate/.test(lowered)) capability = 'pump'
    else if (/intensity|strength|motor|power/.test(lowered)) capability = 'strength'
    if (capability && FIELD_BY_CAPABILITY[capability]) {
      const { action, field } = FIELD_BY_CAPABILITY[capability]
      return { capability, action, field }
    }
    throw new SafetyError(
      `game parameter "${key}" is tagged as driving device "${definition.device}" but its unit is not recognizable; ` +
      'refusing to pass it unscaled. Edit it in the client UI.',
      'UNKNOWN_GAME_INTENSITY_PARAM', { key },
    )
  }
  if (LOOKS_INTENSE.test(lowered)) {
    throw new SafetyError(
      `game parameter "${key}" looks intensity-related but its capability is not declared; ` +
      'refusing to pass it unscaled. Edit it in the client UI or use a declared parameter.',
      'UNKNOWN_GAME_INTENSITY_PARAM', { key },
    )
  }
  return null
}

/**
 * Scale the intensity-related subset of a game's parameters.
 * @returns {{parameters:object, clamped:Array, unscaled:string[], scaledFields:string[]}}
 */
export function scaleGameParameters({ gameId, parameters, schema, limits, ranges }) {
  if (parameters === undefined || parameters === null) {
    return { parameters, clamped: [], unscaled: [], scaledFields: [] }
  }
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new SafetyError('game parameters must be an object', 'INVALID_GAME_PARAMS', { gameId })
  }
  const output = { ...parameters }
  const clamped = []
  const unscaled = []
  const scaledFields = []
  for (const [key, value] of Object.entries(parameters)) {
    if (typeof value !== 'number' && typeof value !== 'string') continue
    const mapping = capabilityForParam(key, schema)
    if (!mapping) {
      unscaled.push(key)
      continue
    }
    const scaled = scaleCapabilityInput({
      capability: mapping.capability, action: mapping.action,
      input: { [mapping.field]: value }, limits, ranges,
    })
    output[key] = scaled.input[mapping.field]
    scaledFields.push(key)
    for (const item of scaled.clamped) clamped.push({ param: key, capability: mapping.capability, ...item })
  }
  return { parameters: output, clamped, unscaled, scaledFields }
}
