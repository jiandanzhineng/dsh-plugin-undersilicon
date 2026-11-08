import { jsonTool } from './helpers.js'
import { compact, renderJson, sessionIdOf, toolSource } from './helpers.js'

/** Register game discovery and control tools. */
export function registerGameTools(ctx, deps) {
  const { client, safety } = deps

  ctx.tools.register(jsonTool({
    name: 'game_list',
    description: 'List installed games and HostRuntime-capable games. Each entry has id, title/name, howTo, supported device slots and parameter definitions. Use game_status to see what is currently running and game_start to launch one (including iframe games) in the client UI.',
    parameters: {
      includeManifest: { type: 'boolean', description: 'Include full manifest/params. Default true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const scoped = client.forSession(sessionIdOf(exec))
      const [games, hostGames] = await Promise.all([
        scoped.games({ signal: exec.signal }),
        scoped.request('GET', '/game-runtime/games', { signal: exec.signal }).catch(() => []),
      ])
      const list = (games || []).map((game) => ({
        id: game.id, name: game.name || game.title, description: game.description,
        howTo: game.howTo, version: game.version, external: game.external,
        devices: args.includeManifest === false ? undefined : game.devices,
        params: args.includeManifest === false ? undefined : game.params,
        models: game.models,
      }))
      return { mode: await safety.getMode(), count: list.length, games: list, hostRuntimeGames: hostGames }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'game_status',
    description: 'Show the current game state from both the iframe/bridge game controller and the HostRuntime, plus whether the client window is visible and which page is open. Use this before game_control or game_start.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(_args, exec) {
      const scoped = client.forSession(sessionIdOf(exec))
      const [game, runtime, clientState] = await Promise.all([
        scoped.gameStatus({ signal: exec.signal }).catch((error) => ({ error: error.message })),
        scoped.gameRuntimeStatus({ signal: exec.signal }).catch((error) => ({ error: error.message })),
        scoped.clientState({ signal: exec.signal }).catch(() => null),
      ])
      return { mode: await safety.getMode(), game: compact(game, 30), runtime: compact(runtime, 30), client: compact(clientState, 20) }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'game_start',
    description: [
      'Launch a game through the control-center UI (the same flow as clicking Start), including iframe games that must be loaded by the frontend. This stops the current game first because only one game can run at a time.',
      'deviceMapping maps a game device slot to one or more device ids, e.g. {"main":"PJ01-abc"}. parameters must match the game params from game_list. Requires the client control bridge (/api/client/games/:id/launch); if it returns 503 the desktop client is not running or the main-repo agent-control API is not deployed.',
    ].join('\n'),
    parameters: {
      gameId: { type: 'string', required: true, description: 'Game id from game_list.' },
      deviceMapping: { type: 'object', additionalProperties: true, description: 'Slot name → device id or array of ids.' },
      parameters: { type: 'object', additionalProperties: true, description: 'Game parameters.' },
      show: { type: 'boolean', description: 'Bring the client window forward. Default true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      try {
        const result = await safety.gameStart({
          sessionId: sessionIdOf(exec), source: toolSource('game_start', exec),
          gameId: args.gameId, deviceMapping: args.deviceMapping, parameters: args.parameters,
          launch: true, show: args.show !== false, signal: exec.signal,
        })
        const { _scaled, ...rest } = result
        return { ...rest, scaledParameters: _scaled.parameters, clamped: _scaled.clamped, scaledFields: _scaled.scaledFields }
      } catch (error) {
        if (error?.status === 503 || error?.code === 'CLIENT_UNAVAILABLE' || error?.status === 404) {
          throw new Error(`cannot launch "${args.gameId}" in the client UI: ${error.message}. The desktop client control bridge is unavailable; make sure the control-panel desktop app is running and the /api/client/games/:id/launch endpoint is deployed.`)
        }
        throw error
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'game_control',
    description: 'Control the running game: stop it, change HostRuntime parameters, or send a game action (pause/resume/other actions defined by the game). Use game_status first to see runtime mode and available snapshot fields.',
    parameters: {
      action: { type: 'string', required: true, enum: ['stop', 'params', 'action'], description: 'stop, params, or action.' },
      params: { type: 'object', additionalProperties: true, description: 'New parameters for action=params.' },
      actionName: { type: 'string', description: 'Game action name for action=action, e.g. pause, resume.' },
      payload: { type: 'object', additionalProperties: true, description: 'Action payload for action=action.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const source = toolSource('game_control', exec)
      if (args.action === 'stop') {
        return safety.gameStop({ sessionId, source, reason: 'agent-stop', signal: exec.signal })
      }
      if (args.action === 'params') {
        if (!args.params) throw new Error('params is required for action=params')
        const result = await safety.gameParams({ sessionId, source, params: args.params, signal: exec.signal })
        const { _scaled, _backendFieldCaps, ...rest } = result
        return {
          ...rest, scaledParameters: _scaled.parameters, clamped: _scaled.clamped,
          scaledFields: _scaled.scaledFields,
          ...(_backendFieldCaps ? { backendFieldCaps: _backendFieldCaps } : {}),
        }
      }
      if (!args.actionName) throw new Error('actionName is required for action=action')
      const result = await safety.gameAction({
        sessionId, source, action: args.actionName, payload: args.payload || {}, signal: exec.signal,
      })
      const { _scaled, _backendFieldCaps, ...rest } = result
      return {
        ...rest, scaledParameters: _scaled.parameters, clamped: _scaled.clamped,
        scaledFields: _scaled.scaledFields,
        ...(_backendFieldCaps ? { backendFieldCaps: _backendFieldCaps } : {}),
      }
    },
  }))
}
