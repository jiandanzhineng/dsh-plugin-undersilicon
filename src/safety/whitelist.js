/**
 * Raw-request write whitelist. Reads (GET/HEAD) are allowed after path
 * normalization; every mutating request must match exactly one rule here.
 * Matching is done on the lower-cased canonical path, the same shape Express
 * routes with `case sensitive routing` disabled and `strict routing` disabled.
 */
import { SafetyError } from '../util/errors.js'

const ROUTES = [
  { kind: 'capability', re: /^\/devices\/[^/]+\/capabilities\/[^/]+\/actions\/[^/]+$/ },
  { kind: 'operation', re: /^\/devices\/[^/]+\/operations\/[^/]+$/ },
  { kind: 'nickname', re: /^\/devices\/[^/]+\/nickname$/ },
  { kind: 'connection', re: /^\/devices\/[^/]+\/control-connection$/ },
  { kind: 'device-patch', re: /^\/devices\/[^/]+$/ },
  { kind: 'client', re: /^\/client(?:\/|$)/ },
  { kind: 'game-start', re: /^\/games\/[^/]+\/start$/ },
  { kind: 'game-stop', re: /^\/games\/stop-current$/ },
  { kind: 'game-runtime-start', re: /^\/game-runtime\/start$/ },
  { kind: 'game-runtime-params', re: /^\/game-runtime\/params$/ },
  { kind: 'game-runtime-action', re: /^\/game-runtime\/action$/ },
  { kind: 'game-stop', re: /^\/game-runtime\/stop$/ },
  { kind: 'brand-connect', re: /^\/brands\/connect$/ },
  { kind: 'brand-disconnect', re: /^\/brands\/[^/]+\/disconnect$/ },
  { kind: 'remote-emergency', re: /^\/remote-session\/emergency-stop$/ },
  { kind: 'stop-all', re: /^\/device-watchdog\/stop-all$/ },
]

const METHODS = {
  capability: ['POST'],
  operation: ['POST'],
  nickname: ['POST'],
  connection: ['PUT'],
  'device-patch': ['PATCH'],
  client: ['POST'],
  'game-start': ['POST'],
  'game-stop': ['POST'],
  'game-runtime-start': ['POST'],
  'game-runtime-params': ['POST'],
  'game-runtime-action': ['POST'],
  'brand-connect': ['POST'],
  'brand-disconnect': ['POST'],
  'remote-emergency': ['POST'],
  'stop-all': ['POST'],
}

const HINTS = [
  { re: /^\/devices\/[^/]+\/message/, hint: 'raw device messages are not available; use device_control (capability/action) or a preset operation' },
  { re: /^\/devices\/batch/, hint: 'batch device writes are not available; control one device at a time with device_control' },
  { re: /^\/test(?:\/|$)/, hint: 'the hardware test loop bypasses thresholds; use device_control for deliberate actions' },
  { re: /^\/remote-projection/, hint: 'remote projection lifecycle is user-owned; ask the user to start/authorize it' },
  { re: /^\/remote-game/, hint: 'remote game channel is user-owned; use game_start/game_control in local mode' },
  { re: /^\/remote-session/, hint: 'remote session lifecycle is user-owned; only emergency-stop is available to agents' },
  { re: /^\/virtual-devices/, hint: 'virtual device injection is a local testing feature, not an agent control path' },
  { re: /^\/mqtt-client/, hint: 'direct MQTT publishing bypasses device checks' },
  { re: /^\/serial|^\/wired-flash|^\/devices\/(?:firmware|[^/]+\/firmware)/, hint: 'serial/flashing/firmware access is local-only hardware control' },
  { re: /^\/local-apps/, hint: 'launching arbitrary local apps is outside the plugin contract' },
  { re: /^\/plugins/, hint: 'plugin installation is outside the plugin contract' },
  { re: /^\/auth|^\/models/, hint: 'account/model writes are outside the plugin contract' },
  { re: /^\/games\/[^/]+$/, hint: 'game deletion is destructive; ask the user' },
]

const READ_ROUTES = [
  /^\/devices$/,
  /^\/devices\/[^/]+$/,
  /^\/devices\/[^/]+\/monitor-data$/,
  /^\/device-capabilities$/,
  /^\/device-types$/,
  /^\/device-types\/configs$/,
  /^\/device-types\/[^/]+\/config$/,
  /^\/games$/,
  /^\/games\/status$/,
  /^\/games\/[^/]+$/,
  /^\/games\/[^/]+\/meta$/,
  /^\/game-runtime\/status$/,
  /^\/game-runtime\/games$/,
  /^\/client\/state$/,
  /^\/client\/routes$/,
  /^\/events\/recent$/,
  /^\/remote-session\/status$/,
  /^\/brands$/,
  /^\/brands\/status$/,
  /^\/brands\/v2-layout$/,
  /^\/brands\/saved-ble$/,
  /^\/voice\/status$/,
  /^\/hello$/,
]

const READ_HINTS = [
  { re: /^\/games\/external\//, hint: 'fetching external game metadata makes the backend request a URL (SSRF); use the registered game list instead' },
  { re: /^\/brands\/discover/, hint: 'brand discovery probes the network; ask the user to scan in the client' },
  { re: /^\/brands\/settings/, hint: 'brand settings are configuration, not agent data' },
  { re: /^\/auth|^\/models/, hint: 'account/model state is outside the plugin contract' },
  { re: /^\/logs/, hint: 'client log files may contain unrelated personal data' },
  { re: /^\/test/, hint: 'the hardware test loop is outside the agent contract' },
  { re: /^\/virtual-devices/, hint: 'virtual device injection is a local testing feature' },
  { re: /^\/mqtt-client|^\/serial|^\/network/, hint: 'transport diagnostics are local-only' },
  { re: /^\/events\/stream|^\/game-runtime\/stream/, hint: 'use events_subscribe or script_run for streaming reads' },
  { re: /^\/agent-control/, hint: 'the plugin manages agent leases internally' },
  { re: /^\/games\/[^/]+\/firmware|firmware/, hint: 'firmware access is local-only hardware control' },
]

/** Only these reads are exposed to an agent. Everything else is denied. */
export function classifyRawRead(canonicalPath) {
  const path = String(canonicalPath || '/')
  if (/^\/games\/external(\/|$)/.test(path)) {
    const hint = READ_HINTS[0].hint
    throw new SafetyError(`blocked GET ${path}: ${hint}`, 'ENDPOINT_BLOCKED', {
      method: 'GET', path, reason: 'read-not-whitelisted', hint,
    })
  }
  if (READ_ROUTES.some((re) => re.test(path))) return { kind: 'read' }
  const hint = READ_HINTS.find((item) => item.re.test(path))?.hint
    || 'this read endpoint is not on the agent whitelist; use a documented tool instead'
  throw new SafetyError(`blocked GET ${path}: ${hint}`, 'ENDPOINT_BLOCKED', {
    method: 'GET', path, reason: 'read-not-whitelisted', hint,
  })
}

/** Throw unless this write verb+path is on the explicit whitelist. */
export function classifyRawWrite(method, canonicalPath) {
  const verb = String(method || 'GET').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD') return classifyRawRead(canonicalPath)
  const path = String(canonicalPath || '/')
  for (const route of ROUTES) {
    if (!route.re.test(path)) continue
    if (!METHODS[route.kind].includes(verb)) {
      throw new SafetyError(`blocked ${verb} ${path}: method not allowed for this endpoint`, 'ENDPOINT_BLOCKED', {
        method: verb, path, reason: 'method-not-whitelisted',
      })
    }
    return { kind: route.kind }
  }
  const hint = HINTS.find((item) => item.re.test(path))?.hint
    || 'this write endpoint is not on the agent whitelist; use a documented tool instead'
  throw new SafetyError(`blocked ${verb} ${path}: ${hint}`, 'ENDPOINT_BLOCKED', {
    method: verb, path, reason: 'not-whitelisted', hint,
  })
}

/** Body shape checks for metadata writes. */
export function assertPatchBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SafetyError('device rename body must be a JSON object', 'INVALID_BODY')
  }
  const keys = Object.keys(body)
  const allowed = new Set(['name', 'nickname'])
  const extra = keys.filter((key) => !allowed.has(key))
  if (extra.length > 0) {
    throw new SafetyError(
      `device PATCH may only change name/nickname; refused fields: ${extra.join(', ')}. Use device_control for output fields.`,
      'UNSAFE_DEVICE_PATCH', { refused: extra },
    )
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200)) {
    throw new SafetyError('device name must be a string of at most 200 characters', 'INVALID_BODY')
  }
  if (body.nickname !== undefined && (typeof body.nickname !== 'string' || body.nickname.length > 200)) {
    throw new SafetyError('nickname must be a string of at most 200 characters', 'INVALID_BODY')
  }
  return Object.fromEntries(keys.map((key) => [key, body[key]]))
}

export function assertNicknameBody(body) {
  if (!body || typeof body !== 'object' || typeof body.nickname !== 'string' || body.nickname.length > 200) {
    throw new SafetyError('nickname body must be {nickname: string(<=200)}', 'INVALID_BODY')
  }
  return { nickname: body.nickname }
}

export function assertConnectionBody(body) {
  const allowed = ['mqtt', 'serial', 'ble', 'remote', 'brand', 'brandBle']
  if (!body || typeof body !== 'object' || !allowed.includes(body.type)) {
    throw new SafetyError(`connection body must be {type: one of ${allowed.join(', ')}}`, 'INVALID_BODY')
  }
  return { type: body.type }
}
