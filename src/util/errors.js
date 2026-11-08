/** Error type shared by the SDK and safety layer. */
export class UsApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, body?: unknown, method?: string, path?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'UsApiError'
    this.status = info.status ?? 0
    this.code = info.code ?? 'US_API_ERROR'
    this.body = info.body
    this.method = info.method
    this.path = info.path
  }
}

/** True when an error is a deliberate safety-layer refusal. */
export class SafetyError extends Error {
  constructor(message, code = 'SAFETY_BLOCKED', details = {}) {
    super(message)
    this.name = 'SafetyError'
    this.code = code
    this.details = details
  }
}

/** Convert an unknown rejection into a readable message without leaking stacks. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Sleep for a number of milliseconds, abortable. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}
