import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SANDBOX_CHILD = fileURLToPath(new URL('./sandbox-child.cjs', import.meta.url))

/** Args shared by the real child and the permission-model test probe. */
export function sandboxSpawnArgs({ memoryMb = 64, childPath = SANDBOX_CHILD } = {}) {
  const memory = Math.max(16, Math.min(512, Number(memoryMb) || 64))
  return [
    '--permission',
    `--allow-fs-read=${childPath}`,
    `--max-old-space-size=${memory}`,
    childPath,
  ]
}

/**
 * One long-lived child process hosts every script's vm context. The child runs
 * under Node's permission model: no filesystem writes, no child_process, no
 * worker_threads, no native addons, and only read access to this one file.
 */
export class SandboxHost {
  constructor({ log = () => {}, onMessage = () => {}, onExit = () => {}, memoryMb = 64 } = {}) {
    this.log = log
    this.onMessage = onMessage
    this.onExit = onExit
    this.memoryMb = memoryMb
    this.child = null
    this.exiting = false
  }

  get alive() {
    return Boolean(this.child && this.child.connected && !this.child.killed)
  }

  ensure({ memoryMb = this.memoryMb } = {}) {
    if (this.alive && memoryMb === this.memoryMb) return this.child
    if (this.child) this.kill('memory-limit-changed')
    this.memoryMb = memoryMb
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, sandboxSpawnArgs({ memoryMb }), {
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    })
    this.child = child
    this.exiting = false
    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return
      try { this.onMessage(message) } catch (error) { this.log('sandbox message handler failed', { error: error?.message }) }
    })
    child.on('error', (error) => {
      this.log('sandbox child error', { error: error?.message })
    })
    child.on('exit', (code, signal) => {
      const intentional = this.exiting
      this.child = null
      this.onExit({ code, signal, intentional })
    })
    return child
  }

  post(message) {
    if (!this.alive) return false
    try {
      this.child.send(message)
      return true
    } catch (error) {
      this.log('sandbox post failed', { error: error?.message })
      return false
    }
  }

  kill(reason = 'sandbox-kill') {
    const child = this.child
    if (!child) return
    this.exiting = true
    this.child = null
    this.log('sandbox child killed', { reason, pid: child.pid })
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }

  dispose() {
    this.exiting = true
    this.kill('dispose')
    this.child = null
  }
}
