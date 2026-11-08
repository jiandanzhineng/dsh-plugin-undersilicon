import test from 'node:test'
import assert from 'node:assert/strict'
import {
  scaleCapabilityInput, scaleOperationInput, limitFor, resolvePercent, findRange,
} from '../src/safety/scale.js'
import { extractApiRanges, mergeRanges, FALLBACK_RANGES } from '../src/safety/ranges.js'

const limits60 = { default: 60, capabilities: { shock: 30 } }
const ranges = mergeRanges({})

test('default 60% clamps strength 200 to 153', () => {
  const result = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 200 }, limits: limits60, ranges,
  })
  assert.equal(result.input.value, 153)
  assert.equal(result.clamped.length, 1)
  assert.deepEqual(
    { field: result.clamped[0].field, requested: result.clamped[0].requested, applied: result.clamped[0].applied },
    { field: 'value', requested: 200, applied: 153 },
  )
})

test('values under the limit pass through without clamping', () => {
  const result = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 100 }, limits: limits60, ranges,
  })
  assert.equal(result.input.value, 100)
  assert.equal(result.clamped.length, 0)
})

test('per-capability shock defaults to 30%', () => {
  const result = scaleCapabilityInput({
    capability: 'shock', action: 'start', input: { voltage: 80 }, limits: limits60, ranges,
  })
  assert.equal(result.input.voltage, 30)
  assert.equal(result.clamped[0].percent, 30)
})

test('zero percent refuses a positive action instead of silently applying zero', () => {
  assert.throws(() => scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 200 },
    limits: { default: 0 }, ranges,
  }), /threshold is too low|below 1/i)
  const full = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 999 },
    limits: { default: 100 }, ranges,
  })
  assert.equal(full.input.value, 255)
  assert.equal(full.clamped[0].reason, 'above-range')
})

test('nested channels are scaled by wildcard paths', () => {
  const result = scaleCapabilityInput({
    capability: 'motors', action: 'set',
    input: { channels: { stroke: { value: 200, direction: 1 }, vibe: { value: 300 } } },
    limits: limits60, ranges,
  })
  assert.equal(result.input.channels.stroke.value, 153)
  assert.equal(result.input.channels.stroke.direction, 1)
  assert.equal(result.input.channels.vibe.value, 153)
  assert.deepEqual(result.clamped.map((item) => item.field), ['channels.stroke.value', 'channels.vibe.value'])
})

test('unknown numeric fields in an intensity capability are refused', () => {
  assert.throws(() => scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 100, mystery: 999 },
    limits: limits60, ranges,
  }), /unknown numeric field/)
  const config = scaleCapabilityInput({
    capability: 'reporting', action: 'setReportDelay', input: { ms: 100, extra: 999 },
    limits: limits60, ranges,
  })
  assert.equal(config.input.extra, 999)
  assert.ok(config.unscaled.includes('extra'))
})

test('below-range intensity values are raised to the minimum', () => {
  const result = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: -5 }, limits: limits60, ranges,
  })
  assert.equal(result.input.value, 0)
  assert.equal(result.clamped[0].reason, 'below-range')
})

test('configuration values such as reporting and distance are never scaled', () => {
  const result = scaleCapabilityInput({
    capability: 'reporting', action: 'setReportDelay', input: { ms: 99999 }, limits: limits60, ranges,
  })
  assert.equal(result.input.ms, 99999)
  assert.deepEqual(result.unscaled, ['ms'])
  const distance = scaleCapabilityInput({
    capability: 'distance', action: 'configure', input: { lowBand: 999999, highBand: 999999 }, limits: limits60, ranges,
  })
  assert.equal(distance.input.lowBand, 999999)
  assert.equal(distance.clamped.length, 0)
})

test('per-action and per-field percentages override the capability value', () => {
  const limits = { default: 60, capabilities: { shock: { percent: 50, actions: { start: 20 }, fields: { voltage: 10 } } } }
  assert.equal(resolvePercent(limits, 'shock', 'start', 'voltage'), 10)
  assert.equal(resolvePercent(limits, 'shock', 'start', 'other'), 20)
  assert.equal(resolvePercent(limits, 'shock', 'stop', 'other'), 50)
  assert.equal(resolvePercent({ default: 60 }, 'x', 'y', 'z'), 60)
})

test('API ranges override fallback field by field', () => {
  const api = extractApiRanges({
    capabilityRanges: { strength: { set: { value: { min: 0, max: 200 } } } },
  })
  const merged = mergeRanges(api)
  assert.equal(merged.strength.set.value.max, 200)
  assert.equal(merged.shock.start.voltage.max, 100)
  const result = scaleCapabilityInput({
    capability: 'strength', action: 'set', input: { value: 180 }, limits: { default: 60 }, ranges: merged,
  })
  assert.equal(result.input.value, 120)
})

test('extractApiRanges accepts actions.inputs and def.ranges shapes', () => {
  const extracted = extractApiRanges({
    capabilityConfig: {
      motors: { ranges: { set: { 'channels.*.value': { min: 0, max: 255 } } } },
      estim: { actions: { set: { inputs: { intensity: { minimum: 0, maximum: 255 } } } } },
    },
  })
  assert.equal(extracted.motors.set['channels.*.value'].max, 255)
  assert.equal(extracted.estim.set.intensity.min, 0)
})

test('extractApiRanges reads actionParams and drops config-only fields', () => {
  const extracted = extractApiRanges({
    capabilityConfig: {
      strength: { actionParams: { set: { value: { type: 'number', min: 0, max: 255, default: 0 } } } },
      reporting: { actionParams: { setReportDelay: { ms: { type: 'number', min: 0, max: 99999 } } } },
      pump: { actionParams: { start: { rate: { type: 'number', min: 0, max: 255 }, ss: { type: 'number', min: 0, max: 255 } } } },
    },
  })
  assert.equal(extracted.strength.set.value.max, 255)
  assert.equal(extracted.reporting, undefined)
  assert.equal(extracted.pump.start.rate.max, 255)
  assert.equal(extracted.pump.start.ss.max, 255)
})

test('preset operations use the named capability or conservative field names', () => {
  const named = scaleOperationInput({
    operation: { key: 'start', capability: 'shock', action: 'start' },
    input: { voltage: 90 }, limits: limits60, ranges,
  })
  assert.equal(named.input.voltage, 30)
  const namedField = scaleOperationInput({
    operation: { key: 'custom' }, input: { value: 255 }, limits: limits60, ranges,
  })
  // Ambiguous field names use the most conservative range (vibration 0-100 -> 60).
  assert.equal(namedField.input.value, 60)
  assert.equal(namedField.clamped[0].percent, 60)
})

test('limitFor and findRange are exact', () => {
  assert.equal(limitFor({ min: 0, max: 255 }, 60), 153)
  assert.equal(limitFor({ min: 10, max: 20 }, 50), 15)
  assert.equal(findRange(FALLBACK_RANGES.motors.set, 'channels.a.value').max, 255)
  assert.equal(findRange(FALLBACK_RANGES.motors.set, 'channels.a.other'), undefined)
})
