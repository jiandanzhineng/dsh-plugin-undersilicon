import { UsApiError, errorMessage } from './errors.js'

const DEFAULT_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Whether a host string names this machine only. */
export function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/** Validate and normalize the control-panel API base URL. Local-only by design. */
export function normalizeBaseUrl(value) {
  let url
  try {
    url = new URL(String(value || 'http://127.0.0.1:5278/api'))
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http: or https:')
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`baseUrl must point at this machine (loopback); got host "${url.hostname}"`)
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/api')) path = `${path}/api`
  if (path !== '/api' && !path.endsWith('/api')) path = `${path}/api`
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url
}

/** Join an API path onto the base URL, preserving base query parameters. */
export function joinUrl(base, path, query) {
  const url = new URL(base)
  const clean = String(path || '/').split('?')[0]
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${clean.replace(/^\/+/, '')}`.replace(/\/+/g, '/')
  const urlQuery = new URLSearchParams(String(path || '').split('?')[1] || '')
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) for (const item of value) urlQuery.append(key, String(item))
    else urlQuery.set(key, String(value))
  }
  url.search = urlQuery.toString()
  return url
}

/** Read a response body as text with a hard byte cap. */
async function readTextCapped(response, cap = MAX_RESPONSE_BYTES) {
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > cap) {
    throw new UsApiError(`response too large (${buffer.byteLength} bytes, cap ${cap})`, {
      status: response.status,
      code: 'RESPONSE_TOO_LARGE',
    })
  }
  return new TextDecoder().decode(buffer)
}

/**
 * Minimal JSON HTTP client for one control-panel backend.
 * Every method accepts an AbortSignal so tools stay cooperatively cancellable.
 */
export class PanelHttp {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')
    this.base = normalizeBaseUrl(baseUrl)
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.headers = { accept: 'application/json', ...headers }
  }

  /** The normalized API base string (always ends in /api). */
  get baseUrl() {
    return this.base.toString().replace(/\/$/, '')
  }

  /**
   * Send one request and decode JSON.
   * @param {string} method
   * @param {string} path
   * @param {{body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number, raw?: boolean, headers?: Record<string,string>}} [options]
   */
  async request(method, path, options = {}) {
    const { body, query, signal, timeoutMs = this.timeoutMs, raw = false, headers = {} } = options
    const url = joinUrl(this.base, path, query)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new UsApiError(`request timed out after ${timeoutMs}ms`, {
        code: 'TIMEOUT', method, path: url.pathname,
      }))
    }, timeoutMs)
    timer.unref?.()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) forwardAbort()
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const init = {
      method,
      headers: { ...this.headers, ...headers },
      signal: controller.signal,
      redirect: 'error',
    }
    const verb = String(method || 'GET').toUpperCase()
    if (body !== undefined && body !== null && verb !== 'GET' && verb !== 'HEAD') {
      init.headers = { ...init.headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    try {
      const response = await this.fetch(url, init)
      const text = await readTextCapped(response)
      let parsed
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      if (!response.ok) {
        const info = parsed && typeof parsed === 'object' ? parsed : {}
        throw new UsApiError(
          info.message || info.error?.message || `${method} ${url.pathname} failed with HTTP ${response.status}`,
          {
            status: response.status,
            code: info.code || info.error?.code || `HTTP_${response.status}`,
            body: parsed,
            method,
            path: url.pathname,
          },
        )
      }
      return raw ? { response, body: parsed } : parsed
    } catch (error) {
      if (error instanceof UsApiError) throw error
      const message = signal?.aborted
        ? `request aborted: ${errorMessage(signal.reason ?? error)}`
        : `${method} ${url.pathname} failed: ${errorMessage(error)}`
      throw new UsApiError(message, {
        code: signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR',
        method,
        path: url.pathname,
      })
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', forwardAbort)
    }
  }
}
