import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxSpawnArgs } from '../src/scripts/sandbox-host.js'

function run(args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe timed out')) }, timeout)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('the sandbox spawns with the permission model and no write/child-process grants', () => {
  const args = sandboxSpawnArgs({ memoryMb: 48 })
  assert.ok(args.includes('--permission'))
  assert.ok(args.some((arg) => arg.startsWith('--allow-fs-read=')))
  assert.equal(args.some((arg) => arg.startsWith('--allow-fs-write')), false)
  assert.equal(args.some((arg) => arg.startsWith('--allow-child-process')), false)
  assert.equal(args.some((arg) => arg.startsWith('--allow-worker')), false)
  assert.ok(args.includes('--max-old-space-size=48'))
})

test('even outside the vm, the child permission model denies fs writes, reads, processes and workers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-us-perm-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const probe = join(dir, 'probe.cjs')
  const other = join(dir, 'other.txt')
  await writeFile(other, 'secret', 'utf8')
  await writeFile(probe, `
    const fs = require('node:fs')
    const out = {}
    try { out.read = fs.readFileSync(${JSON.stringify(other)}, 'utf8') } catch (error) { out.read = error.code || error.message }
    try { fs.writeFileSync(${JSON.stringify(join(dir, 'written.txt'))}, 'x'); out.write = 'allowed' } catch (error) { out.write = error.code || error.message }
    try { require('node:child_process').execSync('echo hi'); out.child = 'allowed' } catch (error) { out.child = error.code || error.message }
    try { new (require('node:worker_threads').Worker)('1', { eval: true }); out.worker = 'allowed' } catch (error) { out.worker = error.code || error.message }
    try { process.binding('fs'); out.binding = 'allowed' } catch (error) { out.binding = error.code || error.message }
    try { out.ownScript = fs.readFileSync(__filename, 'utf8').length > 0 ? 'allowed' : 'empty' } catch (error) { out.ownScript = error.code || error.message }
    console.log(JSON.stringify(out))
  `, 'utf8')
  const args = sandboxSpawnArgs({ childPath: probe, memoryMb: 32 })
  const result = await run(args)
  assert.equal(result.code, 0, result.stderr)
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(out.read, 'ERR_ACCESS_DENIED')
  assert.equal(out.write, 'ERR_ACCESS_DENIED')
  assert.equal(out.child, 'ERR_ACCESS_DENIED')
  assert.equal(out.worker, 'ERR_ACCESS_DENIED')
  assert.equal(out.binding, 'ERR_ACCESS_DENIED')
  assert.equal(out.ownScript, 'allowed')
})
