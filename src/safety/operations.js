/**
 * Explicit preset-operation policy, derived from backend/devices/registry.js.
 * Mapped operations (capability+action) are scaled like direct capability calls.
 * Invoke-style operations are only allowed when they are pure stops/status
 * reads or have an explicit translation to capability actions. Everything else
 * is refused with a hint to use the capability form.
 */

const FIXED_INPUT_OPS = new Set([
  'stop', 'close', 'stopall', 'stopvibration', 'pumpstop', 'lock', 'unlock',
  'magcalstart', 'magcalend', 'querystatus',
])

const SAFE_INVOKE = {
  YCY_ENEMA: new Set(['pumpstop', 'stop']),
  SOSEXY_PID0004: new Set(['stop', 'querystatus']),
  GXP_XA9935: new Set(['stop', 'stopvibration']),
}

const TRANSLATIONS = {
  CUNZHI01: {
    start: () => [
      { capability: 'shock', action: 'start', input: { voltage: 24 } },
      { capability: 'strength', action: 'set', input: { value: 255 } },
    ],
    stop: () => [
      { capability: 'shock', action: 'stop', input: {} },
      { capability: 'strength', action: 'stop', input: {} },
    ],
  },
  YCY_ENEMA: {
    pumpstart: (params) => [{
      capability: 'pump', action: 'start',
      input: {
        protocol: params.protocol, scene: params.scene, rate: params.rate,
        ss: params.ss ?? 60,
      },
    }],
  },
}

const REFUSED_INVOKE = {
  YCY_CUP: new Set(['trigger']),
  YCY_ENEMA: new Set(['trigger']),
  GXP_XA9935: new Set(['setmode']),
}

const HINTS = {
  CUNZHI01: 'use device_control with capability+action (shock.start / strength.set)',
  YCY_CUP: 'triggerInstruction can run arbitrary device commands; use device_control capability actions',
  YCY_ENEMA: 'triggerInstruction can run arbitrary device commands; use device_control pump.start with scaled rate/ss',
  GXP_XA9935: 'setMode mixes motor value/percent/mode; use device_control with capability strength.set',
}

/** Resolve one operation into either a pass-through or explicit action list. */
export function resolveOperation({ deviceType, operationKey, definition, params = {} }) {
  const key = String(operationKey || '')
  const lowered = key.toLowerCase()
  const type = String(deviceType || '')
  if (!definition) {
    throw Object.assign(new Error(`operation "${key}" is not defined for device type ${type}`), {
      code: 'OPERATION_UNKNOWN',
    })
  }
  const translations = TRANSLATIONS[type]
  if (translations?.[lowered]) {
    return { mode: 'translate', actions: translations[lowered](params || {}) }
  }
  if (definition.capability && definition.action) {
    const fixed = FIXED_INPUT_OPS.has(lowered)
    return { mode: 'mapped', fixedInput: fixed }
  }
  if (SAFE_INVOKE[type]?.has(lowered)) {
    return { mode: 'invoke-safe', dropParams: true }
  }
  if (REFUSED_INVOKE[type]?.has(lowered)) {
    throw Object.assign(new Error(
      `operation "${key}" on ${type} is not safe for agents: ${HINTS[type] || 'use a capability action'}`,
    ), { code: 'OPERATION_NOT_SAFE' })
  }
  throw Object.assign(new Error(
    `operation "${key}" on ${type} is an invoke operation with unknown intensity effects; ${HINTS[type] || 'use device_control with capability+action'}`,
  ), { code: 'OPERATION_NOT_SAFE' })
}
