#!/usr/bin/env node
// guided-review CLI bridge. Zero dependencies (Node >= 20).
// The Claude Code session drives the local review server with this: it opens
// comparisons, reads the diff, stores walkthroughs and comments, moves the UI, and
// receives the requests the reviewer makes in the browser (`gr wait`).
// Reference: ../references/cli.md   Contract: ../app/shared/types.ts
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP = path.join(SKILL, 'app')

// ── paths / state ────────────────────────────────────────────
function defaultHome() {
  const h = os.homedir()
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'guided-review')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'guided-review')
}
const HOME = process.env.GUIDED_REVIEW_HOME || defaultHome()
const STATE_FILE = path.join(HOME, 'bridge.json')
const LOG_FILE = path.join(HOME, 'server.log')
const HOST = '127.0.0.1'

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { current: {} } }
}
function writeState(patch) {
  const next = { ...readState(), ...patch }
  fs.mkdirSync(HOME, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2))
  return next
}

class Fail extends Error {
  constructor(msg, code = 1) { super(msg); this.code = code }
}
const fail = (msg, code) => { throw new Fail(msg, code) }

// ── args ─────────────────────────────────────────────────────
const BOOL = new Set(['working-tree', 'resume', 'new', 'no-open', 'json', 'stat', 'queued', 'summary', 'title', 'all', 'unset',
  'confirmed-by-user', 'freeze', 'direct', 'force', 'full', 'list', 'include-archived', 'loop', 'on-change', 'help'])
const VALUE = new Set(['repo', 'session', 'port', 'base', 'file', 'line', 'side', 'expect', 'text', 'as', 'section', 'question',
  'artifact', 'step', 'status', 'verdict', 'note', 'sha', 'timeout', 'stop', 'request', 'role'])
function parseArgs(argv) {
  const pos = []; const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (!BOOL.has(key) && !VALUE.has(key)) fail(`unknown option --${key}. Run: gr help`)
      let val
      if (eq > 0) val = a.slice(eq + 1)
      else if (BOOL.has(key)) val = true
      else { val = argv[++i]; if (val === undefined) fail(`--${key} needs a value`) }
      if (key === 'stop') (opt.stop ??= []).push(val)
      else opt[key] = val
    } else pos.push(a)
  }
  return { pos, opt }
}

// ── git (only to turn the user's argument into a comparison) ──
function git(dir, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch (e) {
    if (allowFail) return null
    fail(`git ${args.join(' ')} failed: ${(e.stderr || e.message || '').toString().trim()}`)
  }
}
/** The working tree `gr` was run in (or --repo), and the repository it belongs to.
 *  Reviews are keyed on the PRIMARY worktree's path; linked worktrees are found from it. */
function locate(opt) {
  const dir = path.resolve(opt.repo || process.cwd())
  if (!fs.existsSync(dir)) fail(`no such directory: ${dir}`)
  const top = git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (!top) fail(`${dir} is not inside a git repository`)
  const first = git(top, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '))
  return { top, repo: first ? first.slice('worktree '.length) : top }
}
const repoRoot = (opt) => locate(opt).repo
const localBranches = (repo) => git(repo, ['branch', '--format=%(refname:short)']).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('('))
function defaultBase(repo) {
  const b = localBranches(repo)
  return b.includes('main') ? 'main' : b.includes('master') ? 'master' : b[0] ?? 'HEAD'
}
const commitSha = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })
function assertRef(ref) {
  if (!ref || /^-/.test(ref)) fail(`invalid ref: ${JSON.stringify(ref)}`)
}
const short = (sha) => String(sha ?? '').slice(0, 7)

/** Turn a /guided-review argument into the (base, compare) inputs the server takes,
 *  plus plain-language notes on what the comparison means.
 *  See references/cli.md "Comparison semantics". */
function resolveSpec({ repo, top }, spec, opt) {
  const notes = []
  const branches = localBranches(repo)
  const direct = Boolean(opt.direct)
  const freeze = (ref) => (opt.freeze && branches.includes(ref) ? commitSha(repo, ref) : ref)
  const moving = (ref) => branches.includes(ref)
  const side = (ref) => (moving(ref) ? `${ref} is a moving branch (the review follows new commits)` : `${ref} is frozen at its commit`)
  const sides = (base, compare) => `${side(base)}; ${side(compare)}`

  if (opt['working-tree']) {
    const branch = git(top, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })
    const head = commitSha(top, 'HEAD')
    if (!head) fail('this repository has no commits yet, so there is nothing to compare the working tree against')
    const base = opt.base || spec || 'HEAD'
    assertRef(base)
    if (!commitSha(repo, base)) fail(`not a branch or commit: ${base}`)
    notes.push(base === 'HEAD'
      ? `working tree: ${branch ? `${branch}'s` : 'the'} uncommitted changes (staged + unstaged + untracked) against HEAD, frozen at ${short(head)}`
      : `working tree: everything since ${branch ?? 'HEAD'} diverged from ${base} — commits plus uncommitted changes (staged + unstaged + untracked)`)
    if (!branch) notes.push('working tree with a detached HEAD: the review follows this working tree, not a branch')
    notes.push('each line is labelled committed / staged / unstaged; untracked files appear as added files and can be excluded in the UI')
    return { base: freeze(base), compare: branch || '@worktree', kind: 'working-tree', direct, notes }
  }

  if (!spec) fail('what should be reviewed? Give a commit (HEAD, abc123), a range (A..B), a branch, --working-tree, or --resume.')
  const range = spec.match(/^(.*?)(\.\.\.?)(.*)$/)
  if (range) {
    const a = range[1]; const b = range[3] || 'HEAD'
    if (!a) fail(`range ${spec} has no left side`)
    assertRef(a); assertRef(b)
    const sa = commitSha(repo, a); const sb = commitSha(repo, b)
    if (!sa) fail(`not a branch or commit: ${a}`)
    if (!sb) fail(`not a branch or commit: ${b}`)
    const mb = git(repo, ['merge-base', sa, sb], { allowFail: true })
    if (direct) notes.push(`--direct: the two endpoints ${a} and ${b} are compared as they are ("git diff ${a} ${b}")${mb !== sa ? `, so changes that exist only on ${a} show up reversed` : ''}`)
    else if (!mb) notes.push(`${a} and ${b} share no history: everything in ${b} is shown as added`)
    else if (mb !== sa) notes.push(`${a} is not an ancestor of ${b}: the review shows what ${b} adds since they diverged (merge-base ${short(mb)}), like "git diff ${a}...${b}". Add --direct to compare the two endpoints as they are.`)
    const base = freeze(a); const compare = freeze(b)
    return { base, compare, kind: 'range', direct, same: sa === sb && !moving(compare), notes: [...notes, sides(base, compare)] }
  }

  assertRef(spec)
  const dflt = defaultBase(repo)
  if (branches.includes(spec) && spec !== dflt && !opt.freeze) {
    const base = opt.base || dflt
    assertRef(base)
    if (!commitSha(repo, base)) fail(`not a branch or commit: ${base}`)
    notes.push(`branch review: ${spec} against ${base} (what ${spec} adds since it diverged)`)
    return { base, compare: spec, kind: 'branch', direct, notes: [...notes, sides(base, spec)] }
  }
  const sha = commitSha(repo, spec)
  if (!sha) fail(`not a branch or commit: ${spec}`)
  if (opt.base) {
    assertRef(opt.base)
    const sbase = commitSha(repo, opt.base)
    if (!sbase) fail(`not a branch or commit: ${opt.base}`)
    const compare = opt.freeze ? sha : spec
    return { base: opt.base, compare, kind: 'range', direct, same: sbase === sha && !moving(compare), notes: [sides(opt.base, compare)] }
  }
  const parents = git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1)
  const label = spec === sha ? short(sha) : `${spec} (${short(sha)})`
  if (parents.length === 0) {
    notes.push(`single commit ${label} is a ROOT commit: compared against the empty tree, so every file shows as added`)
    return { base: '@empty', compare: sha, kind: 'commit', direct: false, notes }
  }
  if (parents.length > 1) {
    notes.push(`single commit ${label} is a MERGE commit with ${parents.length} parents: shown against its first parent ${short(parents[0])} (what the merge brought in). For the other side use ${short(parents[1])}..${short(sha)}. Combined (--cc) diffs are not supported.`)
  } else {
    notes.push(`single commit ${label} against its parent ${short(parents[0])}; both sides are frozen`)
  }
  if (branches.includes(spec)) notes.push(`${spec} is the default branch, so it is reviewed as its tip commit; use A..${spec} for a wider range`)
  return { base: parents[0], compare: sha, kind: 'commit', direct: false, notes }
}

// ── server ───────────────────────────────────────────────────
const baseUrl = (port) => `http://${HOST}:${port}`
function headers(extra = {}) {
  const h = { 'x-guided-review-bridge': '1', ...extra }
  if (process.env.GUIDED_REVIEW_TOKEN) h.Authorization = `Bearer ${process.env.GUIDED_REVIEW_TOKEN}`
  return h
}
async function rpcAt(port, channel, args = []) {
  let res
  try {
    res = await fetch(`${baseUrl(port)}/rpc/${encodeURIComponent(channel)}`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(args) })
  } catch (e) { throw new Fail(`review server not reachable on ${baseUrl(port)} (${e.cause?.code || e.message}). Run: gr serve`, 3) }
  let payload
  try { payload = await res.json() } catch { fail(`${channel}: HTTP ${res.status}`) }
  if (!res.ok || payload.error) {
    const err = new Fail(String(payload.error || `${channel}: HTTP ${res.status}`))
    err.server = String(payload.error || '')
    throw err
  }
  return payload.value
}
async function probe(port) {
  try {
    const info = await rpcAt(port, 'info')
    return info?.app === 'guided-review' ? info : null
  } catch { return null }
}
function assertInstalled() {
  if (!fs.existsSync(path.join(APP, 'web', 'dist', 'index.html'))) fail(`the web UI is not built. Run: ${path.join(SKILL, 'scripts', 'install.sh')}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function tailLog(n) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).join('\n') } catch { return '(no log)' }
}
// compare real paths: the same directory can be spelled /var/… and /private/var/…
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const sameHome = (info) => real(info.home) === real(HOME)
let PORT = null
async function ensureServer(opt = {}) {
  if (PORT) return PORT
  const st = readState()
  const first = Number(opt.port || process.env.GUIDED_REVIEW_PORT || st.port || 8791)
  const running = await probe(first)
  if (running) {
    if (!sameHome(running)) fail(`a guided-review server on port ${first} uses a different data directory (${running.home}). Stop it or pick another --port.`)
    PORT = first; writeState({ port: PORT, pid: running.pid })
    return PORT
  }
  assertInstalled()
  let port = first
  for (let i = 0; i < 20; i++, port++) {
    const taken = await fetch(baseUrl(port)).then(() => true, () => false)
    if (!taken) break
  }
  fs.mkdirSync(HOME, { recursive: true })
  const log = fs.openSync(LOG_FILE, 'a')
  const env = { ...process.env, GUIDED_REVIEW_PORT: String(port), GUIDED_REVIEW_HOST: HOST, GUIDED_REVIEW_HOME: HOME }
  const child = spawn(process.execPath, ['server/main.mjs'], { cwd: APP, env, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  for (let i = 0; i < 100; i++) {
    await sleep(100)
    const info = await probe(port)
    if (info) { PORT = port; writeState({ port, pid: info.pid }); return PORT }
    if (child.exitCode != null) break
  }
  fail(`the review server did not start. Last log lines:\n${tailLog(15)}`)
}
async function rpc(channel, ...args) { return rpcAt(await ensureServer(), channel, args) }

function openBrowser(url) {
  if (process.env.GUIDED_REVIEW_NO_OPEN === '1') return false
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); return true } catch { return false }
}
const reviewUrl = (port, sessionId, focus) => `${baseUrl(port)}/#/review?session=${sessionId}${focus ? `&focus=${encodeURIComponent(JSON.stringify(focus))}` : ''}`

/** Open the event stream; resolves once connected, then yields { channel, msg }. */
async function openEvents(port, query, signal) {
  const res = await fetch(`${baseUrl(port)}/events?${query}`, { signal, headers: headers() })
  if (!res.ok) fail(`event stream: HTTP ${res.status}`)
  return (async function* frames() {
    const dec = new TextDecoder(); let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try { yield JSON.parse(line.slice(6)) } catch { /* ignore a malformed frame */ }
          }
        }
      }
    } catch (e) { if (!signal.aborted) throw e }
  })()
}

// ── sessions ─────────────────────────────────────────────────
async function currentSession(opt) {
  if (opt.session) {
    const id = Number(opt.session)
    if (!Number.isInteger(id) || id < 1) fail(`--session must be a review number, got ${opt.session}`)
    return id
  }
  const repo = repoRoot(opt)
  const cur = readState().current?.[repo]
  if (cur) {
    const all = await rpc('listSessions', repo, true)
    if (all.some((s) => s.id === cur)) return cur
  }
  const sessions = await rpc('listSessions', repo)
  if (!sessions.length) fail(`no review for ${repo} yet. Start one: gr review <commit|A..B|branch|--working-tree>`)
  return sessions[0].id
}
function setCurrent(repo, sessionId) {
  const st = readState()
  writeState({ current: { ...(st.current || {}), [repo]: sessionId } })
}
const sideLabel = (s) => `${s.symbol} (${s.kind === 'branch' ? 'moving branch' : s.kind === 'worktree' ? 'working tree' : s.kind === 'empty' ? 'root' : 'frozen'})`
const pairLabel = (pair, direct) => `${sideLabel(pair.base)} → ${sideLabel(pair.compare)}${direct ? ' [direct]' : ''}`
function stats(loaded) {
  const files = loaded.files
  const flags = []
  for (const [label, pred] of [['binary', (f) => f.binary], ['renamed', (f) => f.status === 'renamed'], ['deleted', (f) => f.status === 'deleted'],
    ['added', (f) => f.status === 'added' && !f.untracked], ['untracked', (f) => f.untracked], ['conflicted', (f) => f.conflict], ['mode-only', (f) => f.modeChange && !f.hunks.length && !f.binary]]) {
    const c = files.filter(pred).length; if (c) flags.push(`${c} ${label}`)
  }
  return {
    files: files.length, add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0),
    commits: loaded.commits.length, dirty: loaded.dirty, flags
  }
}
/** Did the code change since the reviewed/approved baseline? */
const hasDelta = (loaded) => Boolean(loaded.since && (loaded.since.moved || loaded.files.some((f) => f.sinceHunks != null)))
function findFile(loaded, file) {
  const f = loaded.files.find((x) => x.path === file) ?? loaded.files.find((x) => x.oldPath === file)
  if (!f) fail(`${file} is not part of this diff. Files in the diff: ${loaded.files.map((x) => x.path).join(', ') || '(none)'}`)
  return f
}

// ── anchors: named here, validated and completed by the server ──
function anchorInput(opt) {
  if (opt.artifact) {
    if (!opt.line) fail('--artifact PATH needs --line N')
    return { kind: 'artifact', path: opt.artifact, line: Number(opt.line), ...(opt.expect ? { expect: opt.expect } : {}) }
  }
  if (opt.file && opt.line) {
    if (opt.side && opt.side !== 'new' && opt.side !== 'old') fail('--side must be new or old')
    return { kind: 'diff', file: opt.file, side: opt.side || 'new', line: Number(opt.line), ...(opt.expect ? { expect: opt.expect } : {}) }
  }
  if (opt.file) return { kind: 'file', file: opt.file }
  if (opt.section) return { kind: 'section', sectionId: opt.section }
  if (opt.question) return { kind: 'question', questionId: opt.question }
  if (opt.step) return { kind: 'plan-step', stepN: Number(opt.step) }
  if (opt.summary) return { kind: 'summary' }
  if (opt.title) return { kind: 'title' }
  return null
}
const needAnchor = (opt) => anchorInput(opt) ?? fail('where? Use --file P [--line N [--side new|old]], --section ID, --question ID, --artifact PATH --line N, --step N, --summary, or --title.')
function focusInput(opt) {
  const a = needAnchor(opt)
  if (!['diff', 'file', 'section', 'summary'].includes(a.kind)) fail('a focus target is a diff line, a file, a section, or the summary')
  return a
}
/** "path:line[:old] | note" · "section:ID | note" · "path | note" · "summary | note" */
function parseStop(s) {
  const [where, ...noteParts] = String(s).split('|'); const note = noteParts.join('|').trim(); const w = where.trim()
  const m = w.match(/^(.*):(\d+)(?::(old|new))?$/)
  const target = w === 'summary' ? { kind: 'summary' } : w.startsWith('section:') ? { kind: 'section', sectionId: w.slice(8) }
    : m ? { kind: 'diff', file: m[1], line: Number(m[2]), side: m[3] || 'new' } : { kind: 'file', file: w }
  return { target, ...(note ? { note } : {}) }
}
function stopsFrom(opt, { jsonFile = false } = {}) {
  if (jsonFile && opt.file && !opt.stop) {
    let raw
    try { raw = JSON.parse(fs.readFileSync(path.resolve(opt.file), 'utf8')) } catch (e) { fail(`cannot read tour JSON: ${e.message}`) }
    if (!Array.isArray(raw)) fail('a tour file is a JSON array of stops')
    return raw.map((s) => (s?.target ? s : { target: anchorInput(s ?? {}) ?? fail(`a tour stop needs a target: ${JSON.stringify(s)}`), ...(s?.note ? { note: String(s.note) } : {}) }))
  }
  return (opt.stop ?? []).map(parseStop)
}
const anchorLabel = (a) => a.kind === 'diff' ? `${a.file}:${a.line}${a.side === 'old' ? ' (old)' : ''}` : a.kind === 'file' ? a.file
  : a.kind === 'section' ? `section ${a.sectionId}` : a.kind === 'artifact' ? `${a.path}:${a.line}` : a.kind === 'question' ? `question ${a.questionId}`
    : a.kind === 'plan-step' ? `plan step ${a.stepN}` : a.kind === 'summary' ? 'the summary' : a.kind === 'title' ? 'the title'
      : a.kind === 'acceptance' ? `acceptance criterion ${a.index + 1}` : a.kind === 'deviation' ? `deviation ${a.index + 1}` : a.kind

// ── output helpers ───────────────────────────────────────────
const out = (s = '') => process.stdout.write(s + '\n')
const printJson = (v) => out(JSON.stringify(v, null, 2))
function fmtComment(c) {
  const res = c.resolution ? ` → ${c.resolution.verdict}: ${c.resolution.note}${c.resolution.commit ? ` (${short(c.resolution.commit)})` : ''}` : ''
  const stale = (c.status === 'outdated' || c.lineGone) && c.anchor.lineContent != null ? `\n    stale anchor — the line it was written on is gone: ${JSON.stringify(c.anchor.lineContent)}` : ''
  const replies = c.replies.map((r) => `\n    ↳ ${r.author}: ${r.text}`).join('')
  return `[${c.id}] ${c.status} · ${c.author} · ${anchorLabel(c.anchor)}\n    ${c.text}${res}${stale}${replies}`
}
function printHunks(hunks, { labels = true } = {}) {
  for (const h of hunks) {
    out(`${h.range}${h.header ? ` ${h.header}` : ''}`)
    for (const l of h.lines) {
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
      const marks = labels ? [l.origin && l.origin !== 'committed' ? l.origin : '', l.since ? 'since-review' : ''].filter(Boolean) : []
      out(`${sign} ${String(l.old ?? '').padStart(5)} ${String(l.new ?? '').padStart(5)}  ${l.text}${marks.length ? `    «${marks.join(', ')}»` : ''}`)
    }
  }
}
function printDiff(loaded, opt) {
  const files = opt.file ? [findFile(loaded, opt.file)] : loaded.files
  if (!files.length) { out('(empty diff — no changes between base and compare)'); return }
  for (const f of files) {
    const tags = [f.status === 'renamed' ? `renamed from ${f.oldPath}` : f.status, `+${f.add} −${f.del}`]
    if (f.binary) tags.push('binary'); if (f.untracked) tags.push('untracked'); if (f.excluded) tags.push('excluded from the review'); if (f.conflict) tags.push('CONFLICT')
    if (f.modeChange) tags.push(`mode ${f.modeChange.from} → ${f.modeChange.to}`)
    out(`## ${f.path} (${tags.join(', ')})`)
    if (opt.stat) continue
    if (f.binary) { out('   (binary — no line diff; comment on the file)'); continue }
    if (!f.hunks.length) { out('   (no line changes)'); continue }
    printHunks(f.hunks)
    out()
  }
  if (!opt.stat) out('columns: sign, old line, new line. Anchor with --file P --line <new line> (or --side old --line <old line> for a removed line).')
}
function fmtRequest(r) {
  const last = r.progress.at(-1)
  return `[${r.id}] ${r.kind} · ${r.status} · ${r.finishedAt ? `finished ${r.finishedAt}` : `created ${r.createdAt}`}${r.text ? `\n    ${r.text}` : ''}${r.commentIds?.length ? `\n    comments: ${r.commentIds.join(', ')}` : ''}${last ? `\n    progress: ${last.text}` : ''}${r.error ? `\n    error: ${r.error}` : ''}`
}
/** Everything the session needs to act on a request it just claimed. */
function printRequest(r, loaded) {
  const comments = loaded.state.comments.filter((c) => r.commentIds?.includes(c.id))
  out(`REQUEST ${r.id} ${r.kind}${r.update ? ' (update)' : ''}`)
  if (r.kind === 'walkthrough') {
    out(r.update ? '  the reviewer asked for the walkthrough to be UPDATED for what changed since it was written (see: gr drift)' : '  the reviewer asked for a walkthrough of this comparison')
    if (r.text) out(`  steer: ${r.text}`)
    out(`  write the walkthrough, then: gr annotate --file <json> --request ${r.id}`)
  } else if (r.kind === 'question') {
    out(`  ${r.text}`)
    if (r.anchor) out(`  about: ${anchorLabel(r.anchor)}${r.anchor.lineContent != null ? ` — ${JSON.stringify(r.anchor.lineContent)}` : ''}`)
    out(`  answer with: gr answer ${r.id} --text "…" [--file P --line N]`)
  } else if (r.kind === 'apply') {
    out(`  commit: ${r.commit ? 'yes' : 'no'}`)
    if (r.text) out(`  steer: ${r.text}`)
    if (loaded.apply.workdir) out(`  edit in: ${loaded.apply.workdir}`)
    for (const c of comments) out(fmtComment(c).replace(/^/gm, '  '))
    out(`  make the edits, record each with: gr resolve <commentId> --verdict addressed|reworked|skipped --note "…", then: gr done ${r.id}`)
    out(r.commit ? '  the reviewer asked for the edits to be committed: commit only your own edits and pass --sha <commit> to gr resolve' : '  do NOT commit: leave the edits uncommitted in the working tree')
  } else {
    const qs = loaded.state.walkthrough?.questions ?? []
    for (const c of comments) {
      const q = qs.find((x) => x.id === c.anchor.questionId)
      out(`  [${c.id}] question ${c.anchor.questionId ?? '?'}: ${q?.text ?? '(question no longer in the walkthrough)'}\n      answer: ${c.text}`)
    }
    out(`  these are decisions, not code changes: update the walkthrough (gr annotate), gr resolve each, then: gr done ${r.id}`)
  }
  if (r.kind !== 'question') out(`  during long work, report with: gr progress ${r.id} "…" (it exits 130 if the reviewer cancelled)`)
}
/** A request-scoped call: a server-side "cancelled" becomes exit code 130. */
async function forRequest(id, fn) {
  try { return await fn() } catch (e) {
    if (id && e instanceof Fail && /^cancelled/.test(e.server ?? '')) {
      process.stderr.write(`CANCELLED: the reviewer cancelled request ${id} — stop working on it\n`)
      throw Object.assign(new Fail('', 130), { quiet: true })
    }
    throw e
  }
}
const REMOVED = 'there is no review engine any more: the reviewer\'s requests arrive through `gr wait`'

// ── commands ─────────────────────────────────────────────────
const commands = {
  async serve(pos, opt) {
    const port = await ensureServer(opt)
    const info = await rpcAt(port, 'info')
    out(`guided-review server: ${baseUrl(port)} (pid ${info.pid}, version ${info.version})`)
    out(`data: ${info.home}\nlog: ${LOG_FILE}`)
  },
  async stop() {
    const st = readState()
    const info = st.port ? await probe(st.port) : null
    if (!info || !sameHome(info)) { out('no guided-review server is running'); return }
    try { process.kill(info.pid, 'SIGTERM') } catch { /* already gone */ }
    for (let i = 0; i < 40 && await probe(st.port); i++) await sleep(100)
    out(`stopped server pid ${info.pid}`)
  },
  async status(pos, opt) {
    const st = readState()
    let info = st.port ? await probe(st.port) : null
    if (info && !sameHome(info)) info = null
    if (opt.json) return printJson({ running: Boolean(info), info, home: HOME })
    out(info ? `running: ${baseUrl(info.port)} pid ${info.pid}, ${info.tabs} UI tab(s) open\ndata: ${info.home}` : 'not running (start with: gr serve)')
  },
  async doctor() {
    const row = (ok, label, detail) => out(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    row(Number(process.versions.node.split('.')[0]) >= 20, `node ${process.version}`, 'needs >= 20')
    const g = (() => { try { return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() } catch { return null } })()
    row(Boolean(g), g || 'git', g ? '' : 'git not found on PATH')
    row(fs.existsSync(path.join(APP, 'web', 'dist', 'index.html')), 'web UI built', path.join(APP, 'web', 'dist'))
    const st = readState(); const info = st.port ? await probe(st.port) : null
    out(`${info ? 'ok  ' : 'idle'}  server${info ? ` — ${baseUrl(info.port)}` : ' — not running (starts on demand)'}`)
    out(`      data — ${HOME}`)
  },

  async review(pos, opt) {
    const where = locate(opt); const repo = where.repo
    await ensureServer(opt)
    await rpc('openRepo', repo)
    let sessionId; let resumed = false; let notes = []
    if (opt.resume) {
      if (opt.session) sessionId = Number(opt.session)
      else if (pos[0] || opt['working-tree']) {
        const r = resolveSpec(where, pos[0], opt)
        const hit = r.same ? null : await rpc('findSession', repo, r.base, r.compare, { direct: r.direct })
        if (!hit) fail(`no saved review for ${r.base} → ${r.compare} in ${repo}. Saved: ${(await rpc('listSessions', repo)).map((s) => `#${s.id} ${s.pair.base.symbol} → ${s.pair.compare.symbol}`).join('; ') || '(none)'}`)
        sessionId = hit.sessionId
      } else {
        const sessions = await rpc('listSessions', repo)
        if (opt.list) {
          if (opt.json) return printJson(sessions)
          if (!sessions.length) out(`no saved reviews for ${repo}`)
          for (const s of sessions) out(`#${s.id}  ${pairLabel(s.pair, s.direct)}  ${s.title || '(no walkthrough yet)'} · ${s.unresolved} open comment(s) · ${s.pendingRequests} pending request(s) · ${s.updatedAt}`)
          return
        }
        if (!sessions.length) fail(`no saved reviews for ${repo}. Start one: gr review <commit|A..B|branch|--working-tree>`)
        sessionId = sessions[0].id
        if (sessions.length > 1) notes.push(`resumed the most recently touched of ${sessions.length} saved reviews; list them with: gr review --resume --list (then --session N)`)
      }
      resumed = true
    } else {
      const r = resolveSpec(where, pos[0], opt); notes = r.notes
      const preview = r.same ? null : await rpc('previewReview', repo, r.base, r.compare, { direct: r.direct })
      if (!preview || (preview.files.length === 0 && !opt.force)) {
        const label = preview ? `${preview.session.pair.base.symbol} → ${preview.session.pair.compare.symbol}` : `${r.base} → ${r.compare}`
        out(`EMPTY DIFF: ${label} has no changes${r.kind === 'working-tree' ? ' (the working tree is clean)' : ''}. Nothing to review; no session was created.${preview ? ' (--force opens it anyway.)' : ''}`)
        for (const n of notes) out(`note: ${n}`)
        return
      }
      const started = await rpc('startSession', repo, r.base, r.compare, { fresh: Boolean(opt.new), direct: r.direct })
      sessionId = started.sessionId; resumed = started.resumed
    }
    const loaded = await rpc('loadSession', sessionId)
    setCurrent(repo, sessionId)
    const port = await ensureServer()
    const url = reviewUrl(port, sessionId)
    const opened = opt['no-open'] ? false : openBrowser(url)
    const d = stats(loaded); const pair = loaded.session.pair; const st = loaded.state
    const info = {
      sessionId, resumed, url, repo, direct: loaded.session.direct,
      base: { ref: pair.base.symbol, kind: pair.base.kind, sha: pair.base.kind === 'branch' ? commitSha(repo, pair.base.symbol) : pair.base.anchorSha },
      compare: { ref: pair.compare.symbol, kind: pair.compare.kind, sha: loaded.headSha || pair.compare.anchorSha },
      ...d, hasWalkthrough: Boolean(st.walkthrough), comments: st.comments.length,
      openComments: st.comments.filter((c) => c.status === 'queued' || c.status === 'sent').length,
      staleComments: st.comments.filter((c) => c.status === 'outdated' || c.lineGone).length,
      pendingRequests: st.requests.filter((r) => r.status === 'pending' || r.status === 'running').length,
      approved: loaded.approved, reviewedAtSha: st.reviewedAtSha ?? null, newSinceReview: hasDelta(loaded),
      artifacts: loaded.artifacts.map((a) => ({ role: a.role, path: a.path })), presence: loaded.presence, notes
    }
    if (opt.json) return printJson(info)
    out(`${resumed ? 'Resumed' : 'Opened'} review #${sessionId}: ${pairLabel(pair, loaded.session.direct)}`)
    out(`${d.files} file(s), +${d.add} −${d.del}, ${d.commits} commit(s)${d.dirty ? ', working tree has uncommitted changes' : ''}${d.flags.length ? ` · ${d.flags.join(', ')}` : ''}`)
    if (info.artifacts.length) out(`spec/plan: ${info.artifacts.map((a) => `${a.path} (${a.role})`).join(', ')}`)
    out(`walkthrough: ${st.walkthrough ? `"${st.walkthrough.title}" (${st.walkthrough.sections.length} sections)` : 'none yet'} · comments: ${info.comments} (${info.openComments} open, ${info.staleComments} stale) · ${info.approved ? 'approved' : 'not approved'}`)
    if (info.newSinceReview) out(`NEW SINCE LAST REVIEW: the code changed since the ${loaded.since.kind} state ${short(loaded.since.sha)} — see: gr drift`)
    if (loaded.refMissing) out(`WARNING: the ${loaded.refMissing.side} ref ${loaded.refMissing.symbol} no longer resolves`)
    if (info.pendingRequests) out(`${info.pendingRequests} request(s) from the reviewer are waiting — run: gr wait`)
    for (const n of notes) out(`note: ${n}`)
    out(`${opened ? 'Opened in your browser' : 'UI'}: ${url}`)
    out('next: run "gr wait" in the background to receive requests the reviewer makes in the UI')
  },
  async open(pos, opt) {
    const sessionId = await currentSession(opt); const port = await ensureServer()
    const url = reviewUrl(port, sessionId); openBrowser(url); out(url)
  },
  async sessions(pos, opt) {
    const repo = repoRoot(opt)
    const sessions = await rpc('listSessions', repo, Boolean(opt['include-archived']))
    if (opt.json) return printJson(sessions)
    if (!sessions.length) out(`no saved reviews for ${repo}`)
    for (const s of sessions) out(`#${s.id}${s.archived ? ' [archived]' : ''}  ${pairLabel(s.pair, s.direct)}  ${s.title || '(no walkthrough)'} · ${s.unresolved} open comment(s) · ${s.updatedAt}`)
  },
  async archive(pos, opt) { const id = Number(pos[0] ?? await currentSession(opt)); await rpc('archiveSession', id, true); out(`archived review #${id} (restore: gr unarchive ${id})`) },
  async unarchive(pos) { if (!pos[0]) fail('usage: gr unarchive <sessionId>'); await rpc('archiveSession', Number(pos[0]), false); out(`restored review #${pos[0]}`) },

  async diff(pos, opt) {
    const loaded = await rpc('loadSession', await currentSession(opt))
    if (opt.json) return printJson(opt.file ? findFile(loaded, opt.file) : loaded.files)
    printDiff(loaded, opt)
  },
  async state(pos, opt) {
    const sessionId = await currentSession(opt)
    const loaded = await rpc('loadSession', sessionId)
    const d = stats(loaded)
    if (opt.json) {
      return printJson(opt.full ? loaded : {
        sessionId, session: loaded.session, state: loaded.state, commits: loaded.commits, headSha: loaded.headSha, diffBase: loaded.diffBase,
        artifacts: loaded.artifacts.map((a) => ({ role: a.role, path: a.path, title: a.title })), dirty: loaded.dirty, apply: loaded.apply,
        approved: loaded.approved, since: loaded.since ?? null, signature: loaded.signature, presence: loaded.presence, stats: d
      })
    }
    const st = loaded.state; const w = st.walkthrough
    out(`review #${sessionId}: ${pairLabel(loaded.session.pair, loaded.session.direct)} · ${d.files} file(s) +${d.add} −${d.del}${d.dirty ? ' · uncommitted changes' : ''}`)
    out(`approved: ${loaded.approved ? 'yes (this exact state)' : st.approvals.length ? `no — last approved at ${short(st.approvals.at(-1).sha)}, the code has changed since` : 'no'} · reviewed at: ${short(st.reviewedAtSha) || '—'} · head: ${short(loaded.headSha)}`)
    if (!w) out('walkthrough: none yet (gr annotate)')
    else {
      out(`\n# ${w.title}\n${w.summary}`)
      for (const s of w.sections) out(`\n## [${s.id}] ${s.name}${st.reviewedSections.includes(s.id) ? '  ✓ reviewed' : ''}\n${s.desc}\n${s.what}\nfiles: ${s.files.join(', ')}`)
      if (w.questions.length) { out('\nopen questions:'); for (const q of w.questions) out(`  [${q.id}] ${q.text}${q.options?.length ? ` (${q.options.join(' | ')})` : ''}`) }
      if (w.planMap) {
        out('\nspec/plan check:')
        for (const a of w.planMap.acceptance) out(`  ${a.met === true ? 'MET    ' : a.met === 'partial' ? 'PARTIAL' : 'UNMET  '} ${a.text}`)
        for (const s of w.planMap.steps) out(`  step ${s.n} ${s.status}: ${s.text}`)
        for (const v of w.planMap.deviations) out(`  DEVIATION: ${v.text}`)
      }
    }
    const viewed = loaded.files.filter((f) => f.viewed)
    out(`\nviewed files: ${viewed.length}/${d.files}${viewed.length ? ` (${viewed.map((f) => `${f.path}${f.viewed === 'changed' ? ' — CHANGED since viewed' : ''}`).join(', ')})` : ''}`)
    out(`comments: ${st.comments.length}`); for (const c of st.comments) out(fmtComment(c))
    const open = st.requests.filter((r) => r.status === 'pending' || r.status === 'running')
    out(`requests waiting: ${open.length}`); for (const r of open) out(fmtRequest(r))
    out(`conversation: ${st.messages.length} message(s) · Claude Code presence as the UI shows it: ${loaded.presence}`)
  },
  async drift(pos, opt) {
    const sessionId = await currentSession(opt)
    const loaded = await rpc('loadSession', sessionId)
    const st = loaded.state; const head = loaded.headSha; const since = loaded.since
    const files = loaded.files.filter((f) => f.sinceHunks != null).map((f) => ({
      path: f.path, binary: f.binary, add: f.sinceHunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add').length,
      del: f.sinceHunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del').length, sinceHunks: f.sinceHunks
    }))
    let commits = []
    if (since?.moved) {
      const idx = loaded.commits.findIndex((c) => c.sha === since.sha)
      commits = idx >= 0 ? loaded.commits.slice(0, idx) : loaded.commits.slice(0, (await rpc('driftSince', sessionId, since.sha)).commits)
    }
    const info = {
      sessionId, head, baseline: since?.sha ?? null, baselineKind: since?.kind ?? null, moved: Boolean(since?.moved), commits, files,
      dirty: loaded.dirty, approvedThisState: loaded.approved, changedSinceViewed: loaded.files.filter((f) => f.viewed === 'changed').map((f) => f.path)
    }
    if (opt.json) return printJson(info)
    if (!since) { out('no baseline yet: this review has no walkthrough and no approval, so there is nothing to compare "since".'); return }
    if (!info.moved && !files.length) { out(`no drift: the compare side is still at ${short(head)}, the ${since.kind} state.`); return }
    if (info.moved) {
      out(`${commits.length} new commit(s) since the ${since.kind} state ${short(since.sha)} (now ${short(head)}):`)
      for (const c of commits) out(`  ${short(c.sha)} ${c.subject}`)
      if (loaded.dirty) out('the working tree also has uncommitted changes (labelled staged/unstaged in gr diff)')
    } else out(`no new commits since the ${since.kind} state ${short(since.sha)}, but the working tree has uncommitted changes:`)
    for (const f of files) {
      out(`\n## ${f.path} (${f.binary ? 'binary changed' : `+${f.add} −${f.del}`} since ${since.kind})`)
      printHunks(f.sinceHunks, { labels: false })
    }
    if (info.changedSinceViewed.length) out(`\nchanged since the reviewer marked them viewed: ${info.changedSinceViewed.join(', ')}`)
    out(`\n${loaded.approved ? 'This exact state is approved.' : st.approvals.length ? 'The earlier approval does NOT cover this state.' : 'Not approved.'}`)
  },

  async annotate(pos, opt) {
    const sessionId = await currentSession(opt)
    const src = opt.file || pos[0]
    if (!src) fail('usage: gr annotate --file walkthrough.json [--request ID]   (schema: references/walkthrough-schema.md; "-" reads stdin)')
    let wire
    try { wire = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8')) } catch (e) { fail(`cannot read walkthrough JSON: ${e.message}`) }
    const res = await forRequest(opt.request, () => rpc('annotate', sessionId, wire, opt.request))
    if (opt.json) return printJson(res)
    out(`walkthrough stored: ${res.sections} section(s)${opt.request ? ` (request ${opt.request} done)` : ''}`)
    for (const w of res.warnings) out(`corrected against git: ${w}`)
  },

  async comment(pos, opt) {
    const sessionId = await currentSession(opt)
    const text = opt.text || pos.join(' ')
    if (!text) fail('usage: gr comment --file P --line N [--side new|old] [--expect "text on that line"] --text "…"')
    const author = opt.as === 'user' ? 'user' : 'agent'
    const c = await rpc('commentAdd', sessionId, { anchor: needAnchor(opt), text, author, status: opt.queued || author === 'user' ? 'queued' : 'note' })
    if (opt.json) return printJson(c)
    out(`comment ${c.id} on ${anchorLabel(c.anchor)}${c.anchor.lineContent != null ? ` — anchored to: ${JSON.stringify(c.anchor.lineContent)}` : ''}`)
  },
  async comments(pos, opt) {
    const st = (await rpc('loadSession', await currentSession(opt))).state
    const list = st.comments.filter((c) => !opt.status || c.status === opt.status)
    if (opt.json) return printJson(list)
    if (!list.length) out(opt.status ? `no ${opt.status} comments` : 'no comments')
    for (const c of list) out(fmtComment(c))
  },
  async reply(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]; const text = opt.text || pos.slice(1).join(' ')
    if (!id || !text) fail('usage: gr reply <commentId> --text "…"')
    const c = await rpc('commentUpdate', sessionId, id, { reply: { author: opt.as === 'user' ? 'user' : 'agent', text } })
    out(`replied to ${id} (${anchorLabel(c.anchor)})`)
  },
  async resolve(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]
    if (!id || !['addressed', 'reworked', 'skipped'].includes(opt.verdict) || opt.note == null) fail('usage: gr resolve <commentId> --verdict addressed|reworked|skipped --note "what was done" [--sha COMMIT]')
    let commit
    if (opt.sha) {
      const repo = (await rpc('loadSession', sessionId)).session.repo
      commit = commitSha(repo, opt.sha); if (!commit) fail(`--sha ${opt.sha} is not a commit in ${repo}`)
    }
    const c = await rpc('commentUpdate', sessionId, id, { resolution: { verdict: opt.verdict, note: opt.note, ...(commit ? { commit } : {}) } })
    out(`resolved ${id} (${anchorLabel(c.anchor)}) as ${opt.verdict}: ${opt.note}`)
  },
  async reopen(pos, opt) {
    if (!pos[0]) fail('usage: gr reopen <commentId>')
    const c = await rpc('commentUpdate', await currentSession(opt), pos[0], { status: 'queued' })
    out(`reopened ${c.id}`)
  },
  async 'delete-comment'(pos, opt) {
    if (!pos[0]) fail('usage: gr delete-comment <commentId>')
    await rpc('commentDelete', await currentSession(opt), pos[0]); out(`deleted ${pos[0]}`)
  },

  async focus(pos, opt) {
    const sessionId = await currentSession(opt)
    const target = focusInput(opt)
    const { tabs } = await rpc('uiAction', sessionId, { kind: 'focus', target })
    if (tabs === 0) {
      const port = await ensureServer(); const { expect: _expect, ...t } = target
      const url = reviewUrl(port, sessionId, t); openBrowser(url); out(`no review tab was open — opened ${url}`)
    } else out(`focused ${anchorLabel(target)} in ${tabs} open tab(s)`)
  },
  async tour(pos, opt) {
    const sessionId = await currentSession(opt)
    const stops = stopsFrom(opt, { jsonFile: true })
    if (stops.length < 2 || stops.length > 8) fail('a tour needs 2–8 stops: --stop "src/a.ts:12 | why this matters" (repeat), or --file stops.json')
    const { tabs } = await rpc('uiAction', sessionId, { kind: 'tour', stops, ...(opt.loop ? { loop: true } : {}) })
    out(`${stops.length}-stop tour sent to ${tabs} open tab(s): ${stops.map((s) => anchorLabel(s.target)).join(' → ')}`)
    if (tabs === 0) out('no review tab is open (gr open), so nobody saw it')
  },
  async say(pos, opt) {
    const text = opt.text || pos.join(' ')
    if (!text) fail('usage: gr say "status line shown in the review UI"')
    const { tabs } = await rpc('uiAction', await currentSession(opt), { kind: 'status', text }); out(`shown in ${tabs} tab(s)`)
  },
  /** Record something said in the terminal in the review's conversation. */
  async note(pos, opt) {
    const text = opt.text || pos.join(' ')
    if (!text) fail('usage: gr note "text" [--file P --line N]')
    const a = anchorInput(opt)
    if (a && !['diff', 'file', 'section', 'summary'].includes(a.kind)) fail('a note can point at a diff line, a file, a section, or the summary')
    const m = await rpc('messagePost', await currentSession(opt), { text, ...(a ? { actions: [{ kind: 'focus', target: a }] } : {}) })
    if (opt.json) return printJson(m)
    out(`posted to the review conversation (${m.id})`)
  },
  async artifact(pos, opt) {
    const sessionId = await currentSession(opt)
    const [verb, p] = pos
    const cur = (await rpc('loadSession', sessionId)).state.artifacts
    if (verb === 'list' || !verb) {
      if (opt.json) return printJson(cur)
      if (!cur.length) out('no spec/plan files attached')
      for (const a of cur) out(`${a.role}  ${a.path}`)
      return
    }
    if (!p || !['add', 'remove'].includes(verb)) fail('usage: gr artifact add PATH --role spec|plan · gr artifact remove PATH · gr artifact list')
    if (verb === 'add') {
      if (!['spec', 'plan'].includes(opt.role)) fail('--role must be spec or plan')
      await rpc('setArtifacts', sessionId, [...cur.filter((a) => a.path !== p), { role: opt.role, path: p }])
      out(`attached ${p} as the ${opt.role}`)
    } else {
      if (!cur.some((a) => a.path === p)) fail(`${p} is not attached. Attached: ${cur.map((a) => a.path).join(', ') || '(none)'}`)
      await rpc('setArtifacts', sessionId, cur.filter((a) => a.path !== p)); out(`detached ${p}`)
    }
  },

  async viewed(pos, opt) {
    const sessionId = await currentSession(opt)
    const loaded = await rpc('loadSession', sessionId)
    const f = findFile(loaded, opt.file || pos[0] || fail('usage: gr viewed --file P [--unset]'))
    const viewedAt = { ...loaded.state.viewedAt }
    if (opt.unset) delete viewedAt[f.path]; else viewedAt[f.path] = { sha: loaded.headSha, hash: f.fileHash ?? '' }
    await rpc('saveUiState', sessionId, { viewedAt })
    out(`${f.path}: ${opt.unset ? 'not viewed' : `viewed at ${short(loaded.headSha)}`}`)
  },
  async 'section-reviewed'(pos, opt) {
    const sessionId = await currentSession(opt)
    const loaded = await rpc('loadSession', sessionId)
    const id = pos[0]
    if (!loaded.state.walkthrough?.sections.some((s) => s.id === id)) fail(`no section ${id}. Sections: ${(loaded.state.walkthrough?.sections ?? []).map((s) => s.id).join(', ') || '(no walkthrough yet)'}`)
    const set = new Set(loaded.state.reviewedSections); if (opt.unset) set.delete(id); else set.add(id)
    await rpc('saveUiState', sessionId, { reviewedSections: [...set] })
    out(`section ${id}: ${opt.unset ? 'not reviewed' : 'reviewed'}`)
  },
  async approve(pos, opt) {
    if (!opt['confirmed-by-user']) fail('refused: approval is the human reviewer\'s decision. Only run this when the user explicitly asked to approve this review, and then pass --confirmed-by-user. Finishing a walkthrough is not a reason to approve.')
    const sessionId = await currentSession(opt)
    await rpc('approve', sessionId)
    const loaded = await rpc('loadSession', sessionId)
    out(`review #${sessionId} approved at ${short(loaded.headSha)}${loaded.dirty ? ' including the current uncommitted changes' : ''}. Any later change needs a new approval.`)
  },
  async unapprove(pos, opt) {
    const sessionId = await currentSession(opt)
    await rpc('unapprove', sessionId); out(`approval withdrawn for review #${sessionId}`)
  },

  // ── requests from the reviewer ──
  /** Block until the reviewer asks for something in the UI (or, with --on-change,
   *  until the code under review changes). While this runs, the UI shows Claude Code
   *  as listening. Requests it returns are claimed: they are this session's to finish. */
  async wait(pos, opt) {
    const sessionId = await currentSession(opt)
    const port = await ensureServer()
    await rpcAt(port, 'loadSession', [sessionId]) // fail early on an unknown review
    const ac = new AbortController()
    const events = await openEvents(port, `bridge=1&session=${sessionId}`, ac.signal)
    let result = null
    const timer = opt.timeout ? setTimeout(() => { result ??= { type: 'timeout' }; ac.abort() }, Number(opt.timeout) * 1000) : null
    const take = async () => {
      if (result) return
      const taken = await rpcAt(port, 'requestTake', [sessionId])
      if (taken.length) result ??= { type: 'requests', requests: taken }
    }
    try {
      await take()
      if (!result) {
        for await (const { channel, msg } of events) {
          if (channel === 'session:changed') await take()
          else if (channel === 'repo:changed' && opt['on-change']) result ??= { type: 'change', signature: msg.signature, headSha: msg.headSha, dirty: msg.dirty }
          if (result) break
        }
      }
    } catch (e) {
      if (e instanceof Fail) throw e
      if (!result) fail(`lost the connection to the review server while waiting (${e.cause?.code || e.message}). Run gr wait again; it restarts the server if needed.`, 3)
    } finally { if (timer) clearTimeout(timer) }
    // the stream ending on its own (not our timeout, not a result) means the server went away
    if (!result) fail('the review server closed the connection while waiting. Run gr wait again; it restarts the server if needed.', 3)
    ac.abort()
    const loaded = result.type === 'timeout' ? null : await rpcAt(port, 'loadSession', [sessionId])
    if (result.type === 'change') {
      result.since = loaded.since?.sha ?? loaded.state.reviewedAtSha ?? loaded.diffBase
      result.drift = await rpcAt(port, 'driftSince', [sessionId, result.since])
    }
    if (opt.json) return printJson(result.type === 'requests' ? { ...result, comments: loaded.state.comments.filter((c) => result.requests.some((r) => r.commentIds?.includes(c.id))) } : result)
    if (result.type === 'timeout') { out('no requests'); return }
    if (result.type === 'change') {
      const d = result.drift
      out(`the code under review changed: ${d.commits} new commit(s), ${d.files} file(s) +${d.add} −${d.del} since ${short(result.since)}${d.dirty ? ', with uncommitted edits' : ''} — see: gr drift`)
      return
    }
    out(`review #${sessionId}: the reviewer made ${result.requests.length} request(s) in the UI. They are now yours; the UI shows them as running.`)
    for (const r of result.requests) { out(); printRequest(r, loaded) }
    out('\nwhen finished, run "gr wait" again to keep listening')
  },
  async requests(pos, opt) {
    const st = (await rpc('loadSession', await currentSession(opt))).state
    const list = st.requests.filter((r) => opt.all || r.status === 'pending' || r.status === 'running')
    if (opt.json) return printJson(list)
    if (!list.length) out(opt.all ? 'no requests' : 'no pending or running requests')
    for (const r of list) out(fmtRequest(r))
  },
  async answer(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]; const text = opt.text || pos.slice(1).join(' ')
    if (!id || !text) fail('usage: gr answer <requestId> --text "…" [--file P --line N] [--stop "path:line | note" …]')
    const actions = []
    const a = anchorInput(opt)
    if (a) {
      if (!['diff', 'file', 'section', 'summary'].includes(a.kind)) fail('an answer can point at a diff line, a file, a section, or the summary')
      actions.push({ kind: 'focus', target: a })
    }
    const stops = stopsFrom(opt)
    if (stops.length === 1) fail('a tour needs at least 2 --stop entries (use --file P --line N to point at one place)')
    if (stops.length) actions.push({ kind: 'tour', stops })
    const m = await forRequest(id, () => rpc('messagePost', sessionId, { text, requestId: id, ...(actions.length ? { actions } : {}) }))
    if (opt.json) return printJson(m)
    out(`answered request ${id}${actions.length ? ` (with ${actions.map((x) => x.kind).join(' + ')})` : ''}`)
  },
  async progress(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]; const text = opt.text || pos.slice(1).join(' ')
    if (!id || !text) fail('usage: gr progress <requestId> "what you are doing"')
    await forRequest(id, () => rpc('requestUpdate', sessionId, id, { progress: text }))
    out(`progress shown for request ${id}`)
  },
  async done(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]
    if (!id) fail('usage: gr done <requestId> [--text "final note"]')
    const text = opt.text || pos.slice(1).join(' ')
    const r = await forRequest(id, () => rpc('requestUpdate', sessionId, id, { ...(text ? { progress: text } : {}), status: 'done' }))
    if (opt.json) return printJson(r)
    out(`request ${id} done`)
    if (r.commentIds?.length) {
      const after = (await rpc('loadSession', sessionId)).state.comments.filter((c) => r.commentIds.includes(c.id))
      out('resolutions:')
      for (const c of after) out(c.resolution ? `  [${c.id}] ${c.resolution.verdict} — ${c.resolution.note}` : `  [${c.id}] NOT handled (back to ${c.status})`)
    }
  },
  async fail(pos, opt) {
    const sessionId = await currentSession(opt)
    const id = pos[0]; const text = opt.text || pos.slice(1).join(' ')
    if (!id || !text) fail('usage: gr fail <requestId> --text "why it could not be done"')
    await forRequest(id, () => rpc('requestUpdate', sessionId, id, { status: 'failed', error: text }))
    out(`request ${id} marked failed: ${text}`)
  },

  async rpc(pos) {
    if (!pos[0]) fail("usage: gr rpc <channel> '[json args]'")
    let args = []
    if (pos[1]) { try { args = JSON.parse(pos[1]) } catch (e) { fail(`arguments must be a JSON array: ${e.message}`) } }
    printJson(await rpc(pos[0], ...(Array.isArray(args) ? args : [args])))
  },
  async help() {
    out(`gr — guided-review bridge. Full reference: ${path.join(SKILL, 'references', 'cli.md')}

  review <commit | A..B | branch> [--base REF] [--freeze] [--direct] [--new]   open a comparison
  review --working-tree [--base REF]     uncommitted changes (staged, unstaged, untracked)
  review --resume [SPEC] [--list]        reopen a saved review
  diff [--file P] [--stat]   state   drift   sessions   open   archive [N]   unarchive N
  annotate --file walkthrough.json [--request ID]      store the walkthrough you wrote
  comment <anchor> --text T   comments   reply   resolve   reopen   delete-comment
  focus <anchor>   tour --stop "path:line | note" …   say "text"   note "text" [<anchor>]
  wait [--timeout S] [--on-change]       receive what the reviewer asks for in the UI
  requests [--all]   answer REQ --text T   progress REQ "text"   done REQ   fail REQ --text T
  artifact add PATH --role spec|plan | remove PATH | list
  viewed --file P   section-reviewed ID   approve --confirmed-by-user   unapprove
  serve / stop / status / doctor / rpc <channel> '[json]'

  <anchor>: --file P [--line N [--side new|old] [--expect TEXT]] | --section ID | --summary
            | --title | --question ID | --artifact PATH --line N | --step N
  common:   --repo DIR  --session N  --json`)
  }
}
for (const name of ['generate', 'chat', 'apply', 'permit', 'cancel']) commands[name] = async () => fail(`gr ${name}: ${REMOVED}`)

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h') return commands.help()
  const fn = Object.hasOwn(commands, cmd) ? commands[cmd] : null
  if (!fn) fail(`unknown command: ${cmd}. Run: gr help`)
  const { pos, opt } = parseArgs(rest)
  if (opt.help) return commands.help()
  await fn(pos, opt)
}
// exit only once stdout has drained — a piped reader would otherwise lose the tail
const quit = (code) => process.stdout.write('', () => process.exit(code))
main().then(() => quit(process.exitCode ?? 0), (e) => {
  if (e?.quiet) return quit(e.code)
  process.stderr.write(`gr: ${e instanceof Fail ? e.message : e.stack || e.message}\n`, () => quit(e instanceof Fail ? e.code : 1))
})
