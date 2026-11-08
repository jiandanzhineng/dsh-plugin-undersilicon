import { PanelHttp } from '../util/http.js'
import { UsApiError, errorMessage } from '../util/errors.js'

/** Parse one SSE block into its fields. Exported for tests. */
export function parseSseBlock(block) {
  const result = { data: '', id: undefined, event: undefined, retry: undefined }
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') result.data = result.data ? `${result.data}\n${value}` : value
    else if (field === 'id') result.id = value
    else if (field === 'event') result.event = value
    else if (field === 'retry') result.retry = value
  }
  return result
}

/**
 * Consume one SSE connection until it ends. Calls onHello once with the first
 * hello payload and onEvent for every parsed event with JSON data.
 */
export async function consumeSse(response, { onHello, onEvent, onComment, signal } = {}) {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new UsApiError(`event stream failed with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`, {
      status: response.status, code: 'EVENT_STREAM_FAILED', path: '/events/stream',
    })
  }
  if (!response.body) throw new UsApiError('event stream has no body', { code: 'EVENT_STREAM_NO_BODY' })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => reader.cancel().catch(() => {})
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (!block.trim() || block.startsWith(':')) {
          if (block.trim()) onComment?.(block)
          continue
        }
        const parsed = parseSseBlock(block)
        if (!parsed.data) continue
        let payload
        try {
          payload = JSON.parse(parsed.data)
        } catch {
          continue
        }
        if (parsed.event === 'hello' || payload?.type === 'hello' || payload?.hello === true
          || (payload && 'seq' in payload && !('type' in payload))) {
          onHello?.(payload, parsed)
          continue
        }
        const event = { ...payload, _id: parsed.id !== undefined ? Number(parsed.id) : payload.seq }
        if (parsed.event && !event.event) event.event = parsed.event
        onEvent?.(event)
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock?.()
  }
}

/**
 * Open the control-panel global event stream.
 * @returns {Promise<'ended'|'aborted'>} resolves when the stream closes normally or the caller aborts.
 */
export async function streamEvents({ baseUrl, fetchImpl, types, lastEventId, signal, onHello, onEvent, onComment, timeoutMs = 15000 }) {
  const http = new PanelHttp({ baseUrl, fetchImpl, timeoutMs })
  const url = new URL(`${http.baseUrl}/events/stream`)
  if (types?.length) url.searchParams.set('types', types.join(','))
  const headers = { accept: 'text/event-stream', 'cache-control': 'no-cache' }
  if (lastEventId !== undefined && lastEventId !== null) headers['last-event-id'] = String(lastEventId)
  let response
  try {
    response = await http.fetch(url, { method: 'GET', headers, signal, redirect: 'error' })
  } catch (error) {
    if (signal?.aborted) return 'aborted'
    throw new UsApiError(`cannot open event stream: ${errorMessage(error)}`, { code: 'EVENT_STREAM_UNAVAILABLE' })
  }
  try {
    await consumeSse(response, { onHello, onEvent, onComment, signal })
  } catch (error) {
    if (signal?.aborted) return 'aborted'
    throw error
  }
  return signal?.aborted ? 'aborted' : 'ended'
}
