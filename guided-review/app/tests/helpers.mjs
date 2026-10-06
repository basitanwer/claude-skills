import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const GR = path.resolve(import.meta.dirname, '../../scripts/gr.mjs')

export function git(dir, ...args) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fix@test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fix@test' }
  }).trim()
}
export function write(dir, rel, content) {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
export function commit(dir, msg) {
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg)
  return git(dir, 'rev-parse', 'HEAD')
}

/** A throwaway repo in a directory whose path contains spaces.
 *  main:    src/a.ts, src/old.ts, src/moveme.ts, specs/rate-limit/{spec,plan}.md, img.bin,
 *           run.sh, noeol.txt                                   (root commit, tagged v0)
 *  feature: edits a.ts, adds src/b.ts, deletes old.ts, renames moveme.ts → moved.ts,
 *           changes img.bin (binary), chmod +x run.sh (mode only), edits noeol.txt
 *           (no trailing newline); then "tweak b"; then "add c". */
export function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr fixture ')))
  const dir = path.join(root, 'my repo')
  fs.mkdirSync(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fix@test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  write(dir, 'src/a.ts', ['export function a() {', '  return 1', '}', 'export const K = 10', 'export const L = 11', 'export const M = 12', ''].join('\n'))
  write(dir, 'src/old.ts', 'export const gone = true\n')
  write(dir, 'src/moveme.ts', ['export const stay1 = 1', 'export const stay2 = 2', 'export const stay3 = 3', ''].join('\n'))
  write(dir, 'specs/rate-limit/spec.md', '# Rate limiting spec\n\nGoal: protect the API on branch feature.\n\n- criterion one\n- criterion two\n')
  write(dir, 'specs/rate-limit/plan.md', '# Plan\n\n1. change a()\n2. add b()\n')
  write(dir, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 255]))
  write(dir, 'run.sh', '#!/bin/sh\necho hi\n')
  write(dir, 'noeol.txt', 'no newline at end')
  const base = commit(dir, 'base')
  git(dir, 'tag', 'v0')

  git(dir, 'checkout', '-q', '-b', 'feature')
  write(dir, 'src/a.ts', ['export function a() {', '  return 2', '}', 'export const K = 10', 'export const L = 11', 'export const M = 12', 'export const J = 20', ''].join('\n'))
  write(dir, 'src/b.ts', ['export function b() {', '  return 42', '}', ''].join('\n'))
  fs.rmSync(path.join(dir, 'src/old.ts'))
  git(dir, 'mv', 'src/moveme.ts', 'src/moved.ts')
  write(dir, 'img.bin', Buffer.from([9, 9, 9, 0, 255]))
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755)
  write(dir, 'noeol.txt', 'still no newline at end')
  const firstFeature = commit(dir, 'feature work')
  write(dir, 'src/b.ts', ['export function b() {', '  return 43', '}', ''].join('\n'))
  commit(dir, 'tweak b')
  write(dir, 'src/c.ts', 'export const c = 3\n')
  const head = commit(dir, 'add c')
  return { dir, root, base, firstFeature, head }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Poll until `fn()` returns something truthy. */
export async function until(fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for a condition')
    await sleep(100)
  }
}

/** An isolated bridge: its own state directory and port, and no browser.
 *  `gr(cwd, ...args)` throws on a non-zero exit; `try` returns { code, out, err };
 *  `json` appends --json and parses; `rpc` calls the server the way the web UI does. */
export async function makeBridge(extraEnv = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr home ')))
  const port = await freePort()
  const env = { ...process.env, GUIDED_REVIEW_HOME: home, GUIDED_REVIEW_PORT: String(port), GUIDED_REVIEW_NO_OPEN: '1', GUIDED_REVIEW_OS_NOTIFY: '0', ...extraEnv }
  const run = (cwd, args, input) => {
    const r = spawnSync(process.execPath, [GR, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000, ...(input != null ? { input } : {}) })
    return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
  }
  const gr = (cwd, ...args) => {
    const r = run(cwd, args)
    if (r.code !== 0) throw new Error(`gr ${args.join(' ')} exited ${r.code}\n${r.err}${r.out}`)
    return r.out
  }
  return {
    home, port, env, gr,
    try: (cwd, ...args) => run(cwd, args),
    /** `gr batch -` with the operations on stdin; returns { code, out, err }. */
    batch: (cwd, ops, ...args) => run(cwd, ['batch', '-', ...args], JSON.stringify(ops)),
    /** Start `gr listen` the way a Monitor does: every stdout line must be one JSON
     *  object. `next(pred)` resolves with the first line (from `from` on) that matches. */
    listener(cwd, ...args) {
      const child = spawn(process.execPath, [GR, 'listen', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const lines = []; const bad = []; let buf = ''; let err = ''
      child.stdout.on('data', (d) => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          try { lines.push(JSON.parse(line)) } catch { bad.push(line) }
        }
      })
      child.stderr.on('data', (d) => { err += d })
      const closed = new Promise((resolve) => child.on('close', resolve))
      return {
        lines, bad, child,
        stderr: () => err,
        next: (pred, ms = 10_000, from = 0) => until(() => lines.slice(from).find(pred), ms),
        async kill() { child.kill('SIGTERM'); await closed }
      }
    },
    /** Start `gr` without waiting (for `gr wait`). `done` resolves { code, out, err }. */
    start(cwd, ...args) {
      const child = spawn(process.execPath, [GR, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; let err = ''
      child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out, err })))
      return { child, done }
    },
    /** Subscribe to the event stream the way a browser tab on `sessionId` does. */
    async listen(sessionId) {
      const ac = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/events?ui=1&session=${sessionId}`, { signal: ac.signal })
      const events = []
      ;(async () => {
        const dec = new TextDecoder(); let buf = ''
        try {
          for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true })
            let i
            while ((i = buf.indexOf('\n\n')) >= 0) {
              for (const line of buf.slice(0, i).split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
              buf = buf.slice(i + 2)
            }
          }
        } catch { /* closed */ }
      })()
      return { events, close: () => ac.abort() }
    },
    json: (cwd, ...args) => JSON.parse(gr(cwd, ...args, '--json')),
    /** what a browser tab would do */
    async rpc(channel, ...args) {
      const call = () => fetch(`http://127.0.0.1:${port}/rpc/${channel}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
      // after a server restart this process may still hold a pooled connection to the
      // old one; the first use of it fails at the socket, so try once more
      const res = await call().catch(() => call())
      const body = await res.json()
      if (body.error) throw new Error(body.error)
      return body.value
    },
    stop() { run(home, ['stop']) }
  }
}
