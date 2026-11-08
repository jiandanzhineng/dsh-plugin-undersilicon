import http from 'node:http'

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Create a small in-process mock of the control-panel API plus the A-side agent API. */
export function createMockServer({ mode = 'local', clientAvailable = true } = {}) {
  const state = {
    mode,
    clientAvailable,
    seq: 0,
    events: [],
    requests: [],
    sse: new Set(),
    watchdog: new Map(),
    leases: new Map(),
    route: '/devices',
    window: { visible: true, focused: true, minimized: false, maximized: false },
    game: null,
    clientGames: [],
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname
    let body = {}
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text) { try { body = JSON.parse(text) } catch { body = { raw: text } } }
    }
    state.requests.push({ method: req.method, path, body, query: Object.fromEntries(url.searchParams), headers: req.headers })
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(value))
    }
    const error = (status, code, message) => json(status, { code, message })
    const remote = state.mode === 'remote-operator'

    if (path === '/api/events/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const client = { res }
      state.sse.add(client)
      res.write(`data: ${JSON.stringify({ type: 'hello', seq: state.seq, mode: state.mode })}\n\n`)
      const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n') } catch { /* ignore */ } }, 15000)
      heartbeat.unref?.()
      const cleanup = () => { clearInterval(heartbeat); state.sse.delete(client) }
      req.on('close', cleanup)
      req.on('error', cleanup)
      return
    }
    if (path === '/api/events/recent') {
      const limit = Number(url.searchParams.get('limit') || 100)
      return json(200, state.events.slice(-limit))
    }
    if (path === '/api/agent-control/lease' && req.method === 'POST') {
      if (!body.clientId) return error(400, 'INVALID_CLIENT_ID', 'clientId required')
      const limits = body.limits || {}
      const fallback = Number(limits.default ?? 0)
      const caps = limits.capabilities || {}
      const percent = (name) => Math.max(0, Math.min(100, Number(caps[name] ?? fallback) || 0))
      const fieldCaps = {
        voltage: Math.floor(percent('shock')),
        power: Math.floor((percent('strength') / 100) * 255),
        intensity: Math.floor((Math.min(percent('shock'), percent('vibration'), percent('suction'), percent('estim')) / 100) * 100),
        motorLevel: Math.floor((percent('motors') / 100) * 20),
        stroke: Math.floor((percent('motors') / 100) * 40),
        rate: Math.floor((percent('pump') / 100) * 255),
        seconds: Math.floor((percent('pump') / 100) * 60),
        ticks: Math.floor(percent('shock')),
        pump: Math.floor((percent('pump') / 100) * 255),
      }
      state.leases.set(body.clientId, { limits, ttlSec: body.ttlSec, at: Date.now(), fieldCaps })
      return json(200, {
        ok: true, clientId: body.clientId, ttlSec: body.ttlSec,
        expiresAt: new Date(Date.now() + (body.ttlSec || 30) * 1000).toISOString(),
        limits, fieldCaps,
      })
    }
    if (path.startsWith('/api/agent-control/lease/') && req.method === 'DELETE') {
      const clientId = decodeURIComponent(path.slice('/api/agent-control/lease/'.length))
      const released = state.leases.delete(clientId)
      return json(200, { ok: true, clientId, released, stopped: [] })
    }
    if (path === '/api/agent-control/status') {
      const leases = [...state.leases].map(([clientId, lease]) => ({
        clientId, expiresAt: new Date(lease.at + (lease.ttlSec || 30) * 1000).toISOString(),
        ttlRemainingSec: Math.max(0, Math.ceil(((lease.ttlSec || 30) * 1000 - (Date.now() - lease.at)) / 1000)),
        limits: lease.limits, fieldCaps: lease.fieldCaps,
      }))
      return json(200, { active: leases.length > 0, leases })
    }
    if (path === '/api/remote-session/status') {
      if (state.mode === 'remote-operator') {
        return json(200, { active: true, role: 'operator', phase: 'active', sessionId: 'remote-session', authorized: true, links: { game: { connected: true }, projection: { connected: true, roomId: 'room-1' } } })
      }
      if (state.mode === 'remote-controlled') {
        return json(200, { active: true, role: 'owner', phase: 'active', sessionId: 'remote-session', authorized: true, links: { game: { connected: true }, projection: { connected: true, roomId: 'room-1' } } })
      }
      return json(200, { active: false, role: null, phase: 'idle', authorized: false, links: { game: { connected: false }, projection: { connected: false, roomId: null } } })
    }
    if (path === '/api/remote-session/emergency-stop' && req.method === 'POST') {
      state.game = null
      return json(200, { ok: true, stopped: true, mode: state.mode })
    }
    if (path === '/api/devices' && req.method === 'GET') {
      return json(200, remote ? [remoteDevice()] : devices())
    }
    if (path === '/api/device-capabilities' && req.method === 'GET') {
      return json(200, {
        capabilities: ['strength', 'shock', 'vibration', 'suction', 'motors', 'reporting', 'distance', 'pump'],
        capabilityConfig: {
          strength: { actionParams: { set: { value: { type: 'number', min: 0, max: 200, default: 0 } } } },
          shock: { actionParams: { start: { voltage: { type: 'number', min: 0, max: 100, default: 24 } } } },
          motors: { actionParams: { set: { channels: { type: 'object' } } } },
          pump: { actionParams: { start: { rate: { type: 'number', min: 0, max: 255 }, ss: { type: 'number', min: 0, max: 255, default: 60 } } } },
          reporting: { actionParams: { setReportDelay: { ms: { type: 'number', min: 0, max: 99999 } } } },
        },
        typeCapabilityMap: { PJ01: ['strength'], DIANJI: ['shock'], CUNZHI01: ['strength', 'shock'], YCY_ENEMA: ['pump'], HR01: [], REMOTE01: ['strength'] },
      })
    }
    if (path === '/api/test/start' && req.method === 'POST') return json(200, { success: true })
    if (path.startsWith('/api/test/device/') && path.endsWith('/start') && req.method === 'POST') return json(200, { success: true })
    if (path === '/api/remote-projection/create' && req.method === 'POST') return json(200, { ok: true })
    if (path === '/api/remote-game/command' && req.method === 'POST') return json(200, { ok: true })
    if (path === '/api/virtual-devices/batch' && req.method === 'POST') return json(200, { ok: true })
    if (path === '/api/virtual-devices/emit' && req.method === 'POST') return json(200, { ok: true })
    if (path === '/api/device-watchdog/heartbeat' && req.method === 'POST') {
      if (remote) return error(423, 'REMOTE_LOCKED', '远程控制中不可用')
      if (!body.clientId) return error(400, 'INVALID_CLIENT_ID', 'clientId required')
      state.watchdog.set(body.clientId, { ttlSeconds: body.ttlSeconds, at: Date.now() })
      return json(200, { ok: true, clientId: body.clientId, ttlSeconds: body.ttlSeconds, expiresAt: new Date(Date.now() + (body.ttlSeconds || 30) * 1000).toISOString() })
    }
    if (path === '/api/device-watchdog/stop-all' && req.method === 'POST') {
      if (remote) return error(423, 'REMOTE_LOCKED', '远程控制中不可用')
      return json(200, { ok: true, trigger: 'client-request', clientId: body.clientId, reason: body.reason, stopped: [], skipped: [] })
    }
    if (path.startsWith('/api/devices/')) {
      const rest = path.slice('/api/devices/'.length).split('/')
      const id = decodeURIComponent(rest[0])
      const device = [...devices(), remoteDevice()].find((item) => item.id === id)
      if (!device) return error(404, 'DEVICE_NOT_FOUND', '设备不存在')
      if (rest.length === 1 && req.method === 'GET') return json(200, device)
      if (rest.length === 1 && req.method === 'PATCH') {
        device.name = body.name ?? device.name
        return json(200, device)
      }
      if (rest[1] === 'monitor-data') return json(200, { deviceId: id, type: device.type, data: device.data, timestamp: new Date().toISOString() })
      if (rest[1] === 'nickname') { device.nickname = body.nickname; return json(200, device) }
      if (rest[1] === 'capabilities' && rest[3] === 'actions') {
        if (remote && device.id !== 'remote-1') return error(423, 'REMOTE_LOCKED', '远程控制中不可用')
        return json(200, { success: true, applied: body.input || {} })
      }
      if (rest[1] === 'operations') return json(200, { ok: true, operation: rest[2], params: body.params || {} })
      if (rest[1] === 'message') return error(400, 'SHOULD_BE_BLOCKED', 'raw message should be blocked by the plugin')
      if (rest[1] === 'control-connection') return json(200, { ...device, controlConnection: body.type })
    }
    if (path.startsWith('/api/device-types/') && path.endsWith('/config')) {
      const type = decodeURIComponent(path.split('/')[3])
      return json(200, typeConfig(type))
    }
    if (path === '/api/games' && req.method === 'GET') {
      return json(200, [{
        id: 'demo', name: '演示玩法', title: '演示玩法', description: 'mock', howTo: 'start',
        devices: [{ id: 'motor', name: '主设备', capabilities: ['strength'] }],
        params: [
          { key: 'speed', name: '速度', min: 0, max: 10 },
          { key: 'maxMotorIntensity', name: '最大强度', min: 1, max: 255, device: 'motor' },
          { key: 'shockVoltage', name: '电击强度', min: 1, max: 50, device: 'punish' },
        ],
      }])
    }
    if (path === '/api/games/status') return json(200, { running: !!state.game, gameId: state.game?.id || null, source: state.game?.source || null, snapshot: state.game?.snapshot || null })
    if (path === '/api/games/stop-current' && req.method === 'POST') { state.game = null; return json(200, { ok: true }) }
    if (path === '/api/games/demo/start' && req.method === 'POST') { state.game = { id: 'demo', source: 'local' }; return json(200, { ok: true, gamePath: '/games/demo' }) }
    if (path === '/api/game-runtime/games') return json(200, [{
      id: 'host-demo', title: '宿主演示', runtimeMode: 'host',
      devices: [
        { id: 'motor', capabilities: ['strength'] },
        { id: 'punish', capabilities: ['shock'] },
      ],
      params: [
        { key: 'maxMotorIntensity', type: 'number', min: 1, max: 255, device: 'motor' },
        { key: 'shockVoltage', type: 'number', min: 1, max: 50, device: 'punish' },
        { key: 'duration', type: 'number', min: 1, max: 180 },
      ],
    }])
    if (path === '/api/game-runtime/status') return json(200, { running: !!state.game?.runtime, gameId: state.game?.id || null, mode: 'host' })
    if (path === '/api/game-runtime/params') return json(200, { ok: true, params: body.params })
    if (path === '/api/game-runtime/action') return json(200, { ok: true, action: body.action, payload: body.payload })
    if (path === '/api/game-runtime/stop') { state.game = null; return json(200, { ok: true, stopped: true }) }
    if (path === '/api/client/state') {
      if (!state.clientAvailable) return json(200, { available: false, version: 'mock', window: null, route: null })
      return json(200, { available: true, version: 'mock', window: state.window, route: state.route })
    }
    if (!state.clientAvailable && path.startsWith('/api/client/') && path !== '/api/client/state') {
      return error(503, 'CLIENT_UNAVAILABLE', 'client control host is not registered')
    }
    if (path === '/api/client/routes') return json(200, [{ path: '/devices', name: 'devices', title: '设备', titleKey: 'nav.devices' }, { path: '/games', name: 'games', title: '游戏', titleKey: 'nav.games' }, { path: '/settings', name: 'settings', title: '设置', titleKey: 'nav.settings' }])
    if (path === '/api/client/window' && req.method === 'POST') {
      const action = body.action
      if (action === 'hide') state.window.visible = false
      if (action === 'show') state.window.visible = true
      if (action === 'focus') { state.window.visible = true; state.window.focused = true }
      if (action === 'minimize') state.window.minimized = true
      if (action === 'maximize') state.window.maximized = true
      if (action === 'restore') { state.window.minimized = false; state.window.maximized = false }
      return json(200, { available: true, window: state.window, route: state.route })
    }
    if (path === '/api/client/navigate' && req.method === 'POST') {
      const known = ['/devices', '/games', '/settings']
      if (!known.includes(String(body.path).split('?')[0])) return error(400, 'INVALID_ROUTE', 'unknown route')
      state.route = body.path
      if (body.show !== false) state.window.visible = true
      return json(200, { available: true, window: state.window, route: state.route })
    }
    if (path === '/api/client/screenshot' && req.method === 'POST') {
      return json(200, { mime: body.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: PNG_1X1, width: 1, height: 1 })
    }
    if (path.startsWith('/api/client/games/') && path.endsWith('/launch') && req.method === 'POST') {
      state.clientGames.push({ id: path.split('/')[4], body })
      state.game = { id: path.split('/')[4], source: 'client-launch' }
      return json(200, { ok: true, gameId: state.game.id, mode: 'iframe', started: true, path: '/plays/game/current', state: { route: '/plays/game/current' } })
    }
    if (path === '/api/brands/status') return json(200, { connected: [], supported: ['dglab', 'ycy'] })
    if (path === '/api/brands/discover') return json(200, { brand: url.searchParams.get('brand'), count: 0, devices: [] })
    if (path === '/api/brands/connect' && req.method === 'POST') return json(200, { ok: true, brand: body.brand })
    if (path.startsWith('/api/brands/') && path.endsWith('/disconnect') && req.method === 'POST') return json(200, { ok: true })
    return error(404, 'NOT_FOUND', `no mock route for ${req.method} ${path}`)
  })

  function start(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        resolve({
          url: `http://127.0.0.1:${address.port}/api`,
          port: address.port,
          state,
          setMode(next) { state.mode = next },
          emit(event) {
            state.seq += 1
            const stamped = { seq: state.seq, ts: new Date().toISOString(), ...event }
            state.events.push(stamped)
            if (state.events.length > 500) state.events.shift()
            for (const client of state.sse) {
              try {
                client.res.write(`id: ${state.seq}\ndata: ${JSON.stringify(stamped)}\n\n`)
              } catch { /* closed */ }
            }
            return stamped
          },
          async close() {
            for (const client of state.sse) { try { client.res.end() } catch { /* ignore */ } }
            state.sse.clear()
            await new Promise((resolve) => server.close(resolve))
          },
        })
      })
    })
  }

  return { server, state, start }
}

function devices() {
  return [
    {
      id: 'pj-1', name: '往复电机', nickname: null, type: 'PJ01', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt' }], lastReport: new Date().toISOString(),
      data: { power: 0, report_delay_ms: 5000 },
    },
    {
      id: 'di-1', name: '电脉冲', nickname: null, type: 'DIANJI', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt' }], lastReport: new Date().toISOString(),
      data: { shock: 0, voltage: 0 },
    },
    {
      id: 'cz-1', name: '寸止设备', nickname: null, type: 'CUNZHI01', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt' }], lastReport: new Date().toISOString(),
      data: { power: 0, voltage: 0, shock: 0 },
    },
    {
      id: 'enema-1', name: '灌肠设备', nickname: null, type: 'YCY_ENEMA', connected: true,
      connectionType: 'mqtt', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt' }], lastReport: new Date().toISOString(),
      data: { rate: 0 },
    },
    {
      id: 'hr-1', name: '心率带', nickname: null, type: 'HR01', connected: true,
      connectionType: 'mock', controlConnection: 'mqtt',
      connections: [{ type: 'mqtt' }], lastReport: new Date().toISOString(),
      data: { heart_rate: 80, hr_status: 'ok' },
    },
  ]
}

function remoteDevice() {
  return {
    id: 'remote-1', name: '远端设备', nickname: null, type: 'REMOTE01', connected: true,
    connectionType: 'remote', controlConnection: 'remote',
    connections: [{ type: 'remote', roomId: 'room-1' }], lastReport: new Date().toISOString(),
    data: { power: 0 },
  }
}

function typeConfig(type) {
  const base = { name: type, capabilities: ['strength'], capabilityConfig: {}, monitorData: [] }
  if (type === 'DIANJI') return {
    ...base, capabilities: ['shock'], operations: [
      { key: 'start', name: '启动', capability: 'shock', action: 'start', input: { voltage: 24 } },
      { key: 'stop', name: '停止', capability: 'shock', action: 'stop', input: {} },
    ],
  }
  if (type === 'HR01') return { ...base, capabilities: [], operations: [] }
  if (type === 'CUNZHI01') return {
    ...base, capabilities: ['strength', 'shock', 'reporting'],
    operations: [
      { key: 'start', name: '启动' },
      { key: 'stop', name: '停止' },
    ],
  }
  if (type === 'YCY_ENEMA') return {
    ...base, capabilities: ['pump'],
    operations: [
      { key: 'pumpStart', name: '启动泵' },
      { key: 'pumpStop', name: '停止泵' },
      { key: 'trigger', name: '触发指令' },
    ],
  }
  return {
    ...base, capabilities: ['strength'], operations: [
      { key: 'start', name: '启动', capability: 'strength', action: 'set', input: { value: 255 } },
      { key: 'stop', name: '关闭', capability: 'strength', action: 'set', input: { value: 0 } },
    ],
  }
}
