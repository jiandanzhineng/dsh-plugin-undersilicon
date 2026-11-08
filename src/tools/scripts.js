import { jsonTool } from './helpers.js'
import { renderJson, sessionIdOf } from './helpers.js'

const SCRIPT_API = [
  'Sandboxed JS. Globals: `us`, `console`, standard JS built-ins, setTimeout/setInterval (min 200ms). No require/process/files/network.',
  'us.devices(filter?) / us.device(id) / us.control(deviceId, capability, action, input) / us.operate(deviceId, operation, params)',
  'us.game.list()/status()/start(id,opts)/launch(id,opts)/params(p)/action(name,payload)/stop()',
  'us.client.state()/routes()/window(a)/navigate(path,show)/screenshot(opts)',
  'us.on(type, fn, {deviceId, where, throttleMs, maxEvents}) -> unsubscribe; us.recent(limit,types); us.api(method,path,body,query)',
  'us.notify(text, {wake}) / us.log(...) / us.every(ms,fn) / us.after(ms,fn) / us.sleep(ms) / us.state (persistent object)',
  'us.stopAll() emergency-stops devices and scripts; us.stop() ends this script. The script stays alive while it has timers or event listeners.',
].join('\n')

/** Register script sandbox tools. */
export function registerScriptTools(ctx, deps) {
  const { scripts, safety } = deps

  ctx.tools.register(jsonTool({
    name: 'script_run',
    description: `Run agent-authored JavaScript in an isolated child process with one vm context per script, with every us.* call routed back through the safety layer and audit log. The child runs under Node's permission model (no fs writes, child processes, workers or native addons).\n\n${SCRIPT_API}\n\nTop-level code may use await. A script that finishes without timers/listeners completes immediately; otherwise it keeps running until us.stop(), script_stop, emergency_stop or session end. Numeric control inputs are threshold-scaled exactly like device_control. Keep control loops bounded and always include an exit condition. A blocked script restarts the shared sandbox and stops every script in it, so avoid infinite synchronous loops.` ,
    parameters: {
      code: { type: 'string', required: true, description: 'JavaScript source, top-level await allowed.' },
      name: { type: 'string', description: 'Short human-readable script name.' },
      persist: { type: 'boolean', description: 'Save source and restart it after a dsh restart (if scripts.allowPersist). Default false.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      safety.assertActive()
      const result = await scripts.run({
        code: args.code, name: args.name, persist: args.persist === true,
        sessionId: sessionIdOf(exec), agent: exec.agent, source: 'tool',
      })
      return {
        ...result,
        note: 'Script accepted. Poll script_list/script_logs for status; the first run is asynchronous.',
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'script_list',
    description: 'List scripts for this agent session (or every session with all=true): id, name, status, result/error, recent logs and event-subscription count. Use script_logs for the full ring buffer and script_stop to end one.',
    parameters: {
      all: { type: 'boolean', description: 'List scripts from every session. Default false.' },
      includeCode: { type: 'boolean', description: 'Include the source. Default false.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = args.all ? undefined : sessionIdOf(exec)
      return { scripts: scripts.list({ sessionId, includeCode: args.includeCode === true }) }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'script_stop',
    description: 'Stop one script by id, or every script in this agent session when scriptId is omitted. Stopping a script also removes its event subscriptions.',
    parameters: {
      scriptId: { type: 'string', description: 'Script id from script_list. Omit to stop all scripts in this session.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (args.scriptId) {
        return { ok: scripts.stop(args.scriptId, 'script_stop'), scriptId: args.scriptId }
      }
      return { ok: true, stopped: scripts.stopAll('script_stop_all', sessionId) }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'script_logs',
    description: 'Read the recent console/us.log output of one script (ring buffer, newest last). Includes lifecycle status and the final result/error when the script ended.',
    parameters: {
      scriptId: { type: 'string', required: true, description: 'Script id from script_list.' },
      limit: { type: 'integer', description: 'Number of recent lines, 1-500. Default 100.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args) {
      const result = scripts.logs(args.scriptId, args.limit ?? 100)
      if (!result) throw new Error(`unknown script id: ${args.scriptId}`)
      return result
    },
  }))
}
