const CONTENT = `# 硅基之下控制中心 (undersilicon-control)

Use this skill when the user asks about their devices, the control-center client,
games, or wants an automation that reacts to device events.

## First move

Call \`panel_status\` once. It reports the session mode, visible devices, client
window/page, current game, running scripts, event subscriptions, thresholds and
recent audit entries.

- \`mode: local\` — this PC is not in a remote session. All local devices are visible.
- \`mode: remote-operator\` — this PC controls an authorized remote session. Only
  devices projected from that session are visible; local hardware is hidden.
  Watchdog and local-only routes answer 423; emergency stop uses the remote path.
- \`mode: remote-controlled\` — this PC is being controlled by someone else. Local
  devices are still visible; avoid surprise control.

## Devices and safety thresholds

Use \`device_list\` then \`device_get\` for capabilities, preset operations,
parameter ranges and the effective percentage limit of each capability.

Every numeric control input is clamped to \`min + (max - min) * percent / 100\`.
The default is 60% (\`shock\` defaults to 30% in the shipped config). A clamped
result returns \`clamped: [{field, requested, applied, min, max, limit, percent}]\`.
**Never retry with a higher value to bypass a clamp.** Tell the user what was
applied and that the threshold is configurable in the plugin settings.

Common capability actions:

| capability.action | input | range |
|---|---|---|
| strength.set | { value } | 0-255 |
| strength.stop | {} | — |
| shock.start | { voltage } | 0-100 V |
| shock.stop | {} | — |
| vibration.set / suction.set | { value } | 0-100 |
| lock.setOpen | { open: boolean } | — |
| reporting.setReportDelay | { ms } | 0-99999 |
| distance.configure | { lowBand, highBand, reportDelayMs } | 0-999999 / 0-99999 |
| motors.set | { channels: { stroke: { value, direction } } } | 0-255 |
| motors.stop / estim.stop / pump.stop | {} | — |
| estim.set | { channel, intensity } | 0-255 |
| pump.start | { scene, ss } | 0-255 |
| attitude.startMagCalibration / endMagCalibration | {} | — |

Preset operations are type-specific. Prefer \`device_control.operation\` when the
user names a device preset ("启动/停止/加锁"), otherwise use capability+action.

## Client UI

- \`client_control action=routes\` lists valid pages.
- \`client_control action=navigate path=/devices\` opens a page (shows the window).
- \`client_control action=window windowAction=minimize|show|focus|...\`.
- \`client_screenshot\` captures the window; it attaches the image when the model
  supports images and always saves a file under \`~/.dsh/undersilicon/screenshots\`.

## Games

\`game_list\` → \`game_status\` → \`game_start { gameId, deviceMapping, parameters }\`.
Launch goes through the client UI, so iframe games load correctly. Only one game
runs at a time. \`game_control action=params\` changes HostRuntime parameters;
\`action=action actionName=pause|resume\` sends a game action; stop uses both game
controllers. \`game_start\` fails with 503 when the desktop client bridge is absent.

## Scripts (automation)

\`script_run\` executes JavaScript in a worker+vm sandbox. Only \`us\`, \`console\`,
standard JS built-ins and bridge-backed timers exist — there is no require,
process, filesystem or network. Every \`us.*\` call goes through the same safety
layer and audit log as tools.

\`\`\`js
const devs = await us.devices({ connected: true });
const hr = devs.find(d => d.type === 'HR01');
await us.control(devs[0].id, 'strength', 'set', { value: 200 }); // clamped
us.on('device.updated', (e) => {
  if (e.data?.heart_rate > 150) us.control(devs[0].id, 'strength', 'set', { value: 0 });
}, { deviceId: devs[0].id, throttleMs: 1000 });
us.notify('心率超过 150，已降强度', { wake: true });
\`\`\`

API: \`us.devices(filter?)\`, \`us.device(id)\`, \`us.control(id,cap,action,input)\`,
\`us.operate(id,op,params)\`, \`us.game.list/status/start/launch/params/action/stop\`,
\`us.client.state/routes/window/navigate/screenshot\`, \`us.api(method,path,body,query)\`,
\`us.recent(limit,types)\`, \`us.on(type,fn,{deviceId,where,throttleMs,maxEvents})\`,
\`us.notify(text,{wake})\`, \`us.log(...)\`, \`us.every(ms,fn)\`, \`us.after(ms,fn)\`,
\`us.sleep(ms)\`, \`us.clearTimer(id)\`, \`us.state\` (persistent object),
\`us.stopAll()\`, \`us.stop()\`.

A script with no timers/listeners ends after its top-level code. Otherwise it
stays alive until \`us.stop()\`, \`script_stop\`, session end or emergency stop.
Limits: 8 concurrent scripts, 64MB per worker, 5s synchronous block detection,
50 timers, 500 log lines. Poll \`script_list\` / \`script_logs\`; do not assume the
script finished immediately after \`script_run\` returns.

## Event subscriptions without code

\`events_subscribe { types, deviceId?, where?, mode, prompt?, throttleMs, maxEvents }\`
delivers matching events to this agent. \`mode=wake\` starts a turn; \`mode=inject\`
adds context without waking. Events merge per throttle window and the
subscription auto-ends after \`maxEvents\`. Use \`events_unsubscribe\` when the
condition no longer matters.

Types: \`device.added/removed/connected/disconnected/updated\`,
\`game.started/stopped/state\`, \`session.mode/revoked\`, \`client.route/client.window\`.
Example: \`where: { field: "data.heart_rate", op: "gte", value: 150 }\`.

## Safety and emergency

- \`emergency_stop\` always works and never asks for confirmation. It stops every
  device, the game, the game runtime and every script, and cancels all event
  subscriptions. Use it immediately if a device behaves unexpectedly.
- Raw \`panel_api\` is blocked for: raw device messages, batch device writes,
  MQTT direct publishing, serial/flashing/firmware, local-app launch, plugin/auth/
  model writes, device deletion, and remote-session lifecycle.
- Session end stops that session's scripts and subscriptions. With
  \`stopOnSessionEnd\` (default true) it also stops all devices; with false the
  watchdog lease is kept alive while dsh runs.

## Failure handling

- HTTP 423 → remote-operator lock; use the remote emergency stop or ask the host.
- HTTP 503 on \`/client/*\` → desktop client control bridge unavailable; tell the
  user to start the control-panel desktop app.
- Connection refused → the control-center backend is not running; tell the user.
- A clamp in the result is a safety limit, not a failed call.
`

/** Embedded skill offered to agents while the plugin is active. */
export const SKILL = Object.freeze({
  name: 'undersilicon-control',
  description: 'Control the 硅基之下控制中心 PC client: devices, safety thresholds, client UI, games, sandboxed scripts and device event subscriptions.',
  whenToUse: 'The user asks to inspect or control local/remote-projected devices, the control-center client window or games, or to automate reactions to device events.',
  content: CONTENT,
  invocation: { modelInvocable: true, userInvocable: true },
})
