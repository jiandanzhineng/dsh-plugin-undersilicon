/** Path canonicalization shared by the raw gate and the HTTP client. */
import { SafetyError } from './errors.js'

const MAX_PATH = 4000
const MAX_QUERY_KEYS = 50
const MAX_QUERY_VALUE = 2000

function bad(message, details = {}) {
  throw new SafetyError(message, 'INVALID_PATH', details)
}

/**
 * Normalize a raw API path into three forms:
 * - sendPath: structure normalized but segment case preserved (device ids keep case)
 * - matchPath: lower-cased, used only for allow/deny matching
 * - query: parsed query object
 *
 * Rejects encoded slashes/backslashes, literal backslashes and malformed escapes.
 * `.`/`..`/`%2e` are resolved exactly like the WHATWG URL parser (which Express
 * ultimately consumes), and repeated `/api` prefixes/trailing slashes are removed.
 */
export function normalizeRequestPath(input, { baseUrl = 'http://127.0.0.1' } = {}) {
  let raw = String(input ?? '/')
  if (raw.length > MAX_PATH) bad(`API path is too long (max ${MAX_PATH})`)
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !raw.startsWith('/')) raw = `/${raw}`
  let url
  try {
    url = new URL(raw, baseUrl)
  } catch {
    bad('API path is not a valid URL path', { path: raw })
  }
  const pathname = url.pathname
  if (pathname.includes('\\') || /%(?:2f|5c)/i.test(pathname)) {
    bad('encoded or literal slashes are not allowed in API paths', { path: pathname })
  }
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    bad('API path contains a malformed percent escape', { path: pathname })
  }
  if (decoded.includes('\\') || decoded.includes('\0')) bad('API path contains illegal characters')
  const segments = []
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  while (segments.length > 0 && segments[0].toLowerCase() === 'api') segments.shift()
  for (const segment of segments) {
    if (segment === '.' || segment === '..') bad('API path contains an unresolved dot segment')
  }
  const sendPath = segments.length === 0 ? '/' : `/${segments.map((item) => encodeURIComponent(item)).join('/')}`
  const matchPath = segments.length === 0 ? '/' : `/${segments.map((item) => item.toLowerCase()).join('/')}`
  return { sendPath, matchPath, query: queryObject(url.searchParams) }
}

/** Cap query size; the control-panel API only needs flat scalar parameters. */
export function queryObject(searchParams, extra = {}) {
  const out = {}
  let keys = 0
  for (const [key, value] of searchParams.entries()) {
    if (++keys > MAX_QUERY_KEYS) bad(`too many query parameters (max ${MAX_QUERY_KEYS})`)
    if (String(value).length > MAX_QUERY_VALUE) bad(`query value for "${key}" is too long`)
    out[key] = value
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length > MAX_QUERY_KEYS) bad(`too many values for query "${key}"`)
      out[key] = value.map((item) => String(item).slice(0, MAX_QUERY_VALUE))
    } else if (typeof value === 'object') {
      bad(`query parameter "${key}" must be a scalar or string array`)
    } else {
      out[key] = String(value).slice(0, MAX_QUERY_VALUE)
    }
  }
  return out
}
