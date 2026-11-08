import { jsonTool } from './helpers.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderJson, sessionIdOf, toolSource } from './helpers.js'
import { sleep } from '../util/errors.js'

/** Register client-window, navigation and screenshot tools. */
export function registerClientTools(ctx, deps) {
  const { client, safety } = deps
  const screenshotDir = join(homedir(), '.dsh', 'undersilicon', 'screenshots')

  ctx.tools.register(jsonTool({
    name: 'client_control',
    description: [
      'Inspect or control the control-panel PC client UI. Actions: state (window + current route), routes (navigable page list), window (show/hide/focus/minimize/maximize/restore), navigate (path from routes, with optional show).',
      'Use routes before navigate so the path is valid. Navigation is rejected for paths outside the client router list. In desktop mode this drives the Electron window through the client control bridge; 503 means the bridge is unavailable.',
    ].join('\n'),
    parameters: {
      action: { type: 'string', required: true, enum: ['state', 'routes', 'window', 'navigate'], description: 'Client control action.' },
      windowAction: { type: 'string', enum: ['show', 'hide', 'focus', 'minimize', 'maximize', 'restore'], description: 'Window action for action=window.' },
      path: { type: 'string', description: 'Route path for action=navigate, e.g. /devices or /games. Query strings are allowed.' },
      show: { type: 'boolean', description: 'Show the window after navigating. Default true.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
    async execute(args, exec) {
      const scoped = client.forSession(sessionIdOf(exec))
      switch (args.action) {
        case 'state':
          return scoped.clientState({ signal: exec.signal })
        case 'routes':
          return scoped.clientRoutes({ signal: exec.signal })
        case 'window':
          if (!args.windowAction) throw new Error('windowAction is required for action=window')
          return safety.raw({
            sessionId: sessionIdOf(exec), source: toolSource('client_control', exec), method: 'POST',
            path: '/client/window', body: { action: args.windowAction }, signal: exec.signal,
          })
        case 'navigate': {
          if (!args.path) throw new Error('path is required for action=navigate')
          const routes = await scoped.clientRoutes({ signal: exec.signal }).catch(() => null)
          if (Array.isArray(routes)) {
            const pathname = String(args.path).split('?')[0]
            const known = routes.some((route) => route.path === pathname || route.path === args.path)
            if (!known) {
              throw new Error(`unknown client route "${args.path}"; available: ${routes.map((route) => route.path).join(', ')}`)
            }
          }
          return safety.raw({
            sessionId: sessionIdOf(exec), source: toolSource('client_control', exec), method: 'POST',
            path: '/client/navigate', body: { path: args.path, show: args.show !== false }, signal: exec.signal,
          })
        }
        default:
          throw new Error(`unknown action: ${args.action}`)
      }
    },
  }))

  ctx.tools.register(jsonTool({
    name: 'client_screenshot',
    description: 'Capture a screenshot of the control-panel client window. The image is saved under ~/.dsh/undersilicon/screenshots and attached to the result when the current model declares image input; otherwise the tool returns the saved path and metadata. Use it to verify UI state after navigate/game_start.',
    parameters: {
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Default png.' },
      maxWidth: { type: 'integer', description: 'Downscale width cap in pixels. Default 1280.' },
      delayMs: { type: 'integer', description: 'Wait before capture, 0-5000ms. Use ~1000 right after game_start because the iframe first paint can lag.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify({ mime: value.mime, width: value.width, height: value.height, bytes: value.bytes, savedPath: value.savedPath, attached: Boolean(value.image), imageCapable: value.imageCapable, attachmentsAvailable: value.attachmentsAvailable, attachError: value.attachError }, null, 2),
      }, ...(value.image ? [{
        type: 'image',
        attachment: value.image,
      }] : [])],
    },
    async execute(args, exec) {
      const delay = Math.max(0, Math.min(5000, Number(args.delayMs) || 0))
      if (delay > 0) await sleep(delay, exec.signal)
      const scoped = client.forSession(sessionIdOf(exec))
      const capture = () => scoped.clientScreenshot({
        format: args.format || 'png', maxWidth: args.maxWidth ?? 1280,
      }, { signal: exec.signal })
      let shot = await capture()
      if (!shot?.data) {
        await sleep(1000, exec.signal)
        shot = await capture()
      }
      if (!shot?.data) throw new Error('screenshot response did not contain image data')
      const mime = shot.mime || (args.format === 'jpeg' ? 'image/jpeg' : 'image/png')
      const bytes = Buffer.from(shot.data, 'base64')
      await mkdir(screenshotDir, { recursive: true })
      const extension = mime.includes('jpeg') ? 'jpg' : 'png'
      const savedPath = join(screenshotDir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`)
      await writeFile(savedPath, bytes)
      const metadata = {
        mime, width: shot.width, height: shot.height, bytes: bytes.byteLength, savedPath,
      }
      let imageCapable = true
      try {
        imageCapable = !deps.canUseImage || (await deps.canUseImage(exec))
      } catch {
        imageCapable = false
      }
      const attachments = deps.getAttachments?.()
      const diagnostics = { imageCapable, attachmentsAvailable: Boolean(attachments) }
      if (!imageCapable) return { ...metadata, ...diagnostics }
      if (!attachments) return { ...metadata, ...diagnostics }
      try {
        const ref = await attachments.saveImage({ data: bytes, mediaType: mime, name: savedPath.split(/[\\/]/).pop() })
        return {
          ...metadata,
          ...diagnostics,
          image: {
            attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes,
            width: ref.width, height: ref.height, ...(ref.name ? { name: ref.name } : {}),
          },
        }
      } catch (error) {
        return { ...metadata, ...diagnostics, attachError: error.message }
      }
    },
  }))
}
