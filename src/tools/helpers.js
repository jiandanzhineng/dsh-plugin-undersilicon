import { defineTool } from '@deepseek-ai/dsh-tools'

/** Standard text rendering for JSON-like tool values. */
export function renderJson(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Detach tool output through JSON so undefined/NaN never reach the lossless-JSON check. */
export function jsonSafe(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

/** Build one defineTool() definition whose execute result is losslessly JSON-safe. */
export function jsonTool(options) {
  const execute = options.execute
  return defineTool({
    ...options,
    output: options.output || {
      schema: { type: 'json' },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      return jsonSafe(await execute(args, exec))
    },
  })
}

/** Current agent session id for attribution and per-session cleanup. */
export function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? 'no-session'
}

/** Tool source descriptor used by audit entries. */
export function toolSource(name, exec) {
  return { kind: 'tool', name, callId: String(exec?.callId ?? '') }
}

/** Trim long arrays/strings in status payloads without hiding structure. */
export function compact(value, maxArray = 50, maxText = 2000) {
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => compact(item, maxArray, maxText))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = compact(item, maxArray, maxText)
    return out
  }
  if (typeof value === 'string' && value.length > maxText) return `${value.slice(0, maxText)}…[truncated]`
  return value
}
