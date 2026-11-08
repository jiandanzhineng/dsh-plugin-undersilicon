/** Shape one successful panel RPC result. */
function ok(value) {
  return { ok: true, value: value ?? null }
}

/** Shape one failed panel RPC result. */
function fail(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'PANEL_RPC_FAILED',
      message: error?.message || String(error),
      details: error?.details && typeof error.details === 'object' ? error.details : {},
    },
  }
}

/**
 * Build the host-side handler for the browser panel's logical RPC channel.
 * The client calls `ctx.connection.rpc.call('/undersilicon', endpoint, payload)`.
 */
export function createPanelHandler({ status, audit, scripts, events, emergencyStop, emergencyResume, updateSettings, getSettings }) {
  return async (endpoint, payload = {}) => {
    try {
      switch (endpoint) {
        case 'state':
          return ok(await status())
        case 'settings.get':
          return ok(await getSettings())
        case 'settings.set':
          return ok(await updateSettings(payload || {}))
        case 'audit':
          return ok(audit.recent(Math.max(1, Math.min(100, Number(payload.limit) || 20))))
        case 'scripts':
          return ok(scripts.list({ includeCode: false }))
        case 'script.logs': {
          const result = scripts.logs(String(payload.id || ''), Number(payload.limit) || 100)
          if (!result) throw new Error(`unknown script id: ${payload.id}`)
          return ok(result)
        }
        case 'script.stop':
          return ok({ stopped: scripts.stop(String(payload.id || ''), 'panel-stop') })
        case 'subscriptions':
          return ok(events.list())
        case 'subscription.stop':
          return ok({ stopped: events.unsubscribe(String(payload.id || '')) })
        case 'emergency.stop':
          return ok(await emergencyStop(payload))
        case 'emergency.resume':
          return ok(await emergencyResume(payload))
        default:
          return fail(Object.assign(new Error(`unknown panel endpoint: ${endpoint}`), { code: 'UNKNOWN_ENDPOINT' }))
      }
    } catch (error) {
      return fail(error)
    }
  }
}
