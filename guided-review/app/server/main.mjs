// @ts-check
// The guided-review server: a local HTTP process with no dependencies.
//   POST /rpc/<channel>   JSON array of arguments → { value } | { error }
//   GET  /events          Server-Sent Events: { channel, msg }
//   GET  /*               the built web UI (app/web/dist)
// The contract is app/shared/types.ts. It binds loopback only unless told otherwise.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store, emptyState, now } from './store.mjs'
import { approvalKey, approvedState, artifactRole, assemble, drift, makeAnchor, makeFocus, readAt, reconcile, resolveInput, sideReader, signatureOf } from './review.mjs'
import { assertSafeRef, branches, currentBranch, defaultBase, log, primaryRepo, statusEntries, tags, tryGit, worktrees } from './git.mjs'

/** @typedef {import('./store.mjs').Session} Session */
/** @typedef {import('../shared/types.ts').ReviewRequest} ReviewRequest */

const VERSION = '0.2.0'
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATIC_ROOT = process.env.GUIDED_REVIEW_STATIC || path.join(APP, 'web', 'dist')
const HOST = process.env.GUIDED_REVIEW_HOST || '127.0.0.1'
const PORT = Number(process.env.GUIDED_REVIEW_PORT || 8791)
const TOKEN = process.env.GUIDED_REVIEW_TOKEN || ''
function defaultHome() {
  const h = os.homedir()
  return process.platform === 'darwin' ? path.join(h, 'Library', 'Application Support', 'guided-review')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'guided-review')
}
const HOME = process.env.GUIDED_REVIEW_HOME || defaultHome()
/** Stop by itself after this long with nothing connected and no request (0 = never). */
const IDLE_MS = Number(process.env.GUIDED_REVIEW_IDLE_MINUTES ?? 30) * 60_000
const store = new Store(HOME)

// ── push ─────────────────────────────────────────────────────
/** @type {Set<{ res: http.ServerResponse, sessionId: number | null, repo: string | null, ui: boolean, bridge: boolean, changes: boolean }>} */
const clients = new Set()
/** Send to every client watching this review (and to clients watching none: the dashboard).
 *  @param {string} channel @param {{ sessionId: number } & Record<string, unknown>} msg */
function push(channel, msg) {
  const batch = scope.getStore()?.batch
  if (batch) { batch.pushes.push([channel, msg]); return } // delivered when the batch commits
  const frame = `data: ${JSON.stringify({ channel, msg })}\n\n`
  const repo = store.sessions.get(msg.sessionId)?.repo
  for (const c of clients) {
    // a client hears about its review, or about every review of its repository;
    // one with neither (the dashboard) hears everything
    if (c.repo ? c.repo === repo : c.sessionId == null || c.sessionId === msg.sessionId) c.res.write(frame)
  }
}
const changed = (/** @type {number} */ sessionId) => push('session:changed', { sessionId })
/** Persist a review — unless a batch is collecting changes, which saves once at the end.
 *  @param {Session} s @param {{ touch?: boolean }} [opts] */
function save(s, opts) {
  if (!scope.getStore()?.batch) store['save'](s, opts)
}
const tabsOf = (/** @type {number} */ sessionId) => [...clients].filter((c) => c.ui && c.sessionId === sessionId).length
/** Tell the reviewer something finished: open tabs raise a browser notification when
 *  hidden; with no tab on this review, fall back to a macOS banner.
 *  @param {number} sessionId @param {string} title @param {string} body */
function notify(sessionId, title, body) {
  const batch = scope.getStore()?.batch
  if (batch) { batch.notes.push([sessionId, title, body]); return }
  push('notify', { sessionId, title, body })
  if (tabsOf(sessionId) === 0 && process.platform === 'darwin' && process.env.GUIDED_REVIEW_OS_NOTIFY !== '0') {
    const esc = (/** @type {string} */ s) => s.replace(/[\\"]/g, '\\$&')
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "Guided review" subtitle "${esc(title)}"`], () => {})
  }
}

// ── presence of a Claude Code session ────────────────────────
/** last time the bridge touched each review */
const seen = new Map()
const lastPresence = new Map()
const WORKING_WINDOW_MS = 120_000
/** `listening`: `gr wait` is connected right now. `working`: the bridge was active in
 *  the last two minutes, or it holds a request. Otherwise `away`.
 *  @param {number} sessionId @returns {import('../shared/types.ts').Presence} */
function presenceOf(sessionId) {
  const s = store.sessions.get(sessionId)
  if (s?.state.requests.some((r) => r.status === 'running')) return 'working'
  if ([...clients].some((c) => c.bridge && (c.sessionId === sessionId || (c.repo && c.repo === s?.repo)))) return 'listening'
  return Date.now() - (seen.get(sessionId) ?? 0) < WORKING_WINDOW_MS ? 'working' : 'away'
}
/** A bridge listener connected or left: refresh the reviews it covers.
 *  @param {{ bridge: boolean, sessionId: number | null, repo: string | null }} client */
function markBridge(client) {
  if (!client.bridge) return
  const ids = client.repo ? store.list(client.repo).map((x) => x.id) : client.sessionId ? [client.sessionId] : []
  for (const id of ids) { seen.set(id, Date.now()); refreshPresence(id) }
}
function refreshPresence(/** @type {number} */ sessionId) {
  const p = presenceOf(sessionId)
  if (lastPresence.get(sessionId) !== p) { lastPresence.set(sessionId, p); push('presence', { sessionId, presence: p }) }
}
setInterval(() => { for (const id of lastPresence.keys()) refreshPresence(id) }, 10_000).unref()

// ── watcher: one fingerprint per review that somebody has open ──
const signatures = new Map()
let watching = false
setInterval(async () => {
  if (watching) return
  watching = true
  try {
    const open = new Set([...clients].map((c) => c.sessionId).filter((id) => id != null))
    // a repository-wide listener that asked for code changes (`gr listen --on-change`)
    // has every review of its repository watched, tab or no tab
    for (const c of clients) if (c.repo && c.changes) for (const s of store.list(c.repo)) open.add(s.id)
    for (const id of signatures.keys()) if (!open.has(id)) signatures.delete(id)
    for (const id of open) {
      const s = store.sessions.get(/** @type {number} */ (id))
      if (!s) continue
      const sig = await signatureOf(s).catch(() => null)
      if (!sig) continue
      const prev = signatures.get(id)
      signatures.set(id, sig.signature)
      if (prev !== undefined && prev !== sig.signature) push('repo:changed', { sessionId: /** @type {number} */ (id), signature: sig.signature, headSha: sig.head, dirty: sig.dirty })
    }
  } finally { watching = false }
}, 1500).unref()

// ── idle shutdown ────────────────────────────────────────────
// "In use" means a browser tab or a `gr wait` is connected, or a request arrived
// recently. With neither for IDLE_MS the server exits; `gr` starts it again on demand
// and nothing is lost, because every change is already on disk.
let lastActivity = Date.now()
const touch = () => { lastActivity = Date.now() }
if (IDLE_MS > 0) {
  setInterval(() => {
    if (clients.size === 0 && Date.now() - lastActivity >= IDLE_MS) {
      console.log(`[guided-review] idle for ${Math.round(IDLE_MS / 60_000)} min with nothing connected — stopping`)
      process.exit(0)
    }
  }, Math.max(250, Math.min(60_000, IDLE_MS / 4))).unref()
}

// ── helpers ──────────────────────────────────────────────────
/** One mutation at a time per review. @type {Map<number, Promise<unknown>>} */
const locks = new Map()
/** What the current call chain holds: the review it has locked and, inside `batch`,
 *  the pushes and notifications waiting for the commit.
 *  @type {AsyncLocalStorage<{ id: number, batch?: { pushes: [string, any][], notes: [number, string, string][] } }>} */
const scope = new AsyncLocalStorage()
/** @template T @param {number} id @param {() => Promise<T>} fn @returns {Promise<T>} */
function locked(id, fn) {
  if (scope.getStore()?.id === id) return fn() // already inside this review's lock (a batch step)
  const inner = fn
  fn = () => scope.run({ id }, inner)
  const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn)
  locks.set(id, run.catch(() => {}))
  return run
}
const load = (/** @type {Session} */ s) => assemble(store, s, { persist: true, presence: presenceOf(s.id) })
/** @param {Session} s */
const listItem = async (s) => ({
  id: s.id, repo: s.repo, pair: s.pair, direct: s.direct, createdAt: s.createdAt, updatedAt: s.updatedAt, archived: s.archived,
  title: s.state.walkthrough?.title, hasWalkthrough: Boolean(s.state.walkthrough),
  unresolved: s.state.comments.filter((c) => c.status === 'queued' || c.status === 'sent').length,
  pendingRequests: s.state.requests.filter((r) => r.status === 'pending' || r.status === 'running').length,
  approved: await approvedState(s).catch(() => /** @type {const} */ ('no'))
})
/** @param {string} dir */
async function repoOf(dir) {
  const repo = await primaryRepo(path.resolve(String(dir)))
  if (!repo) throw new Error(`${dir} is not inside a git repository`)
  return repo
}
/** @param {string} repo */
async function repoState(repo) {
  const [bs, cur, base, trees, status] = await Promise.all([branches(repo), currentBranch(repo), defaultBase(repo), worktrees(repo), statusEntries(repo)])
  const wts = await Promise.all(trees.map(async (w) => ({ ...w, dirty: (await statusEntries(w.path).catch(() => [])).length > 0 })))
  return { path: repo, branches: bs, current: cur ?? 'HEAD', defaultBase: base, dirty: status.length > 0, dirtyCount: status.length, worktrees: wts }
}
/** @param {string} repo @param {string} baseIn @param {string} compareIn */
async function resolvePair(repo, baseIn, compareIn) {
  const pair = { base: await resolveInput(repo, baseIn, 'base'), compare: await resolveInput(repo, compareIn, 'compare') }
  if (pair.base.anchorSha === pair.compare.anchorSha && pair.compare.kind === 'commit') throw new Error('base and compare are the same commit — nothing to review')
  return pair
}
/** Finish a request: record the outcome, hand back comments nobody resolved.
 *  @param {Session} s @param {ReviewRequest} r @param {'done' | 'failed' | 'cancelled'} status @param {string} [error] */
function finish(s, r, status, error) {
  r.status = status; r.finishedAt = now()
  if (error) r.error = error
  for (const c of s.state.comments) if (r.commentIds?.includes(c.id) && c.status === 'sent') c.status = 'queued'
}
/** @param {Session} s @param {string} id */
function liveRequest(s, id) {
  const r = s.state.requests.find((x) => x.id === id)
  if (!r) throw new Error(`no request ${id}`)
  if (r.status === 'cancelled') throw new Error('cancelled: the reviewer cancelled this request — stop working on it')
  if (r.status !== 'pending' && r.status !== 'running') throw new Error(`request ${id} is already ${r.status}`)
  return r
}

// ── RPC handlers (the Api in app/shared/types.ts) ────────────
/** @type {Record<string, (...args: any[]) => any>} */
const api = {
  info: () => ({ app: 'guided-review', version: VERSION, pid: process.pid, home: HOME, host: HOST, port: PORT, tabs: [...clients].filter((c) => c.ui).length }),

  async dashboard() {
    const all = store.all()
    const paths = new Set([...Object.keys(store.index.repos), ...all.map((s) => s.repo)])
    const repos = []
    for (const p of paths) {
      if (!fs.existsSync(p)) continue
      const mine = all.filter((s) => s.repo === p)
      const last = [store.index.repos[p]?.lastOpenedAt ?? '', ...mine.map((s) => s.updatedAt)].sort().at(-1) ?? ''
      try { repos.push({ path: p, current: (await currentBranch(p)) ?? 'HEAD', defaultBase: await defaultBase(p), sessionCount: mine.length, lastActivity: last }) } catch { /* not a repo any more */ }
    }
    repos.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    return { repos, recentSessions: await Promise.all(all.slice(0, 25).map(listItem)), notices: store.notices }
  },
  async openRepo(/** @type {string} */ dir) { const repo = await repoOf(dir); store.touchRepo(repo); return repoState(repo) },
  async repoState(/** @type {string} */ repo) { return repoState(await repoOf(repo)) },
  async refOptions(/** @type {string} */ repo, /** @type {string | null} */ relativeTo) {
    relativeTo = relativeTo || 'HEAD' // JSON null means "not given"
    assertSafeRef(relativeTo)
    return { branches: await branches(repo), tags: await tags(repo), defaultBase: await defaultBase(repo), commits: await log(repo, relativeTo, 50) }
  },
  async listSessions(/** @type {string} */ repo, includeArchived = false) { return Promise.all(store.list(await repoOf(repo), includeArchived).map(listItem)) },

  async startSession(/** @type {string} */ dir, /** @type {string} */ baseIn, /** @type {string} */ compareIn, /** @type {any} */ opts) {
    opts = opts ?? {}
    const repo = await repoOf(dir)
    const pair = await resolvePair(repo, baseIn, compareIn)
    const existing = opts.fresh ? null : store.find(repo, pair, Boolean(opts.direct))
    const s = existing ?? store.create(repo, pair, Boolean(opts.direct))
    store.touchRepo(repo)
    return { sessionId: s.id, resumed: Boolean(existing) }
  },
  async findSession(/** @type {string} */ dir, /** @type {string} */ baseIn, /** @type {string} */ compareIn, /** @type {any} */ opts) {
    opts = opts ?? {}
    const repo = await repoOf(dir)
    const s = store.find(repo, await resolvePair(repo, baseIn, compareIn), Boolean(opts.direct))
    return s ? { sessionId: s.id } : null
  },
  async previewReview(/** @type {string} */ dir, /** @type {string} */ baseIn, /** @type {string} */ compareIn, /** @type {any} */ opts) {
    opts = opts ?? {}
    const repo = await repoOf(dir)
    const pair = await resolvePair(repo, baseIn, compareIn)
    const t = now()
    return assemble(null, { id: 0, repo, pair, direct: Boolean(opts.direct), createdAt: t, updatedAt: t, archived: false, seq: 0, state: emptyState() }, { persist: false, view: opts.view })
  },
  loadSession: (/** @type {number} */ id, /** @type {any} */ view) => locked(id, () => assemble(store, store.get(id), { persist: true, presence: presenceOf(id), view: view ?? undefined })),
  archiveSession: (/** @type {number} */ id, /** @type {boolean} */ archived) => locked(id, async () => { const s = store.get(id); s.archived = Boolean(archived); save(s, { touch: false }); changed(id) }),
  retargetSession: (/** @type {number} */ id, /** @type {string} */ compareIn) => locked(id, async () => {
    const s = store.get(id)
    s.pair.compare = await resolveInput(s.repo, compareIn, 'compare')
    save(s); changed(id)
  }),
  driftSince: (/** @type {number} */ id, /** @type {string} */ sinceSha) => drift(store.get(id), sinceSha),
  /** Lines of a changed file outside its diff hunks, for "expand context". The new
   *  side is read as the compare side has it, the old side from the diff base. */
  async fileLines(/** @type {number} */ id, /** @type {string} */ file, /** @type {'new' | 'old'} */ side, /** @type {number} */ start, /** @type {number} */ end) {
    const s = store.get(id)
    const loaded = await load(s)
    const f = loaded.files.find((x) => x.path === file || x.oldPath === file)
    if (!f) throw new Error(`${file} is not part of this diff`)
    if (f.binary) throw new Error(`${f.path} is binary`)
    const text = side === 'old'
      ? (f.status === 'added' ? '' : await tryGit(s.repo, ['show', `${loaded.diffBase}:${f.oldPath ?? f.path}`]))
      : (f.status === 'deleted' ? '' : await readAt(s.repo, loaded.apply.workdir, loaded.headSha, f.path))
    if (text == null) throw new Error(`cannot read ${f.path} on the ${side} side`)
    const all = text.split('\n'); if (all.at(-1) === '') all.pop()
    const from = Math.max(1, Number(start) || 1); const to = Math.min(all.length, Number(end) || all.length)
    return { start: from, lines: from <= to ? all.slice(from - 1, to) : [], total: all.length }
  },

  saveUiState: (/** @type {number} */ id, /** @type {any} */ patch) => locked(id, async () => {
    const s = store.get(id)
    for (const k of /** @type {const} */ (['viewedAt', 'reviewedSections', 'fileExcluded'])) if (patch?.[k] !== undefined) /** @type {any} */ (s.state)[k] = patch[k]
    save(s); changed(id)
    return s.state
  }),
  setViewed: (/** @type {number} */ id, /** @type {string} */ file, /** @type {boolean} */ viewed) => locked(id, async () => {
    const s = store.get(id)
    const loaded = await load(s)
    const f = loaded.files.find((x) => x.path === file || x.oldPath === file)
    if (!f) throw new Error(`${file} is not part of this diff`)
    if (viewed) s.state.viewedAt[f.path] = { sha: loaded.headSha, hash: f.fileHash ?? '' }; else delete s.state.viewedAt[f.path]
    save(s); changed(id)
    return s.state
  }),
  commentAdd: (/** @type {number} */ id, /** @type {any} */ input) => locked(id, async () => {
    const s = store.get(id)
    const text = String(input?.text ?? '').trim()
    if (!text) throw new Error('a comment needs text')
    const author = input.author === 'agent' ? 'agent' : 'user'
    const loaded = await load(s)
    const anchor = await makeAnchor(loaded, input.anchor, sideReader(s.repo, loaded))
    /** @type {import('../shared/types.ts').Comment} */
    const c = {
      id: store.nextId(s, 'c'), anchor, author, text, status: input.status === 'note' || input.status === 'queued' ? input.status : author === 'agent' ? 'note' : 'queued',
      replies: [], createdAt: now(), iteration: s.state.iterations.length
    }
    s.state.comments.push(c)
    save(s); changed(id)
    return c
  }),
  commentUpdate: (/** @type {number} */ id, /** @type {string} */ cid, /** @type {any} */ patch) => locked(id, async () => {
    const s = store.get(id)
    const c = s.state.comments.find((x) => x.id === cid)
    if (!c) throw new Error(`no comment ${cid}`)
    if (typeof patch?.text === 'string' && patch.text.trim()) c.text = patch.text.trim()
    if (patch?.reply?.text) {
      const author = patch.reply.author === 'agent' ? 'agent' : 'user'
      // a reviewer's reply waits, like a new comment, until they send their review
      c.replies.push({ author, text: String(patch.reply.text), at: now(), ...(author === 'user' ? { pending: true } : {}) })
    }
    if (patch?.resolution) {
      if (!['addressed', 'reworked', 'skipped'].includes(patch.resolution.verdict)) throw new Error('verdict must be addressed, reworked or skipped')
      c.status = 'resolved'
      c.resolution = { verdict: patch.resolution.verdict, note: String(patch.resolution.note ?? ''), ...(patch.resolution.commit ? { commit: String(patch.resolution.commit) } : {}), at: now() }
    } else if (patch?.status) {
      if (!['note', 'queued', 'resolved'].includes(patch.status)) throw new Error(`cannot set status ${patch.status}`)
      c.status = patch.status
      if (patch.status !== 'resolved') delete c.resolution
    }
    save(s); changed(id)
    return c
  }),
  commentDelete: (/** @type {number} */ id, /** @type {string} */ cid) => locked(id, async () => {
    const s = store.get(id)
    s.state.comments = s.state.comments.filter((c) => c.id !== cid)
    save(s); changed(id)
  }),
  approve: (/** @type {number} */ id) => locked(id, async () => {
    const s = store.get(id)
    const loaded = await load(s)
    if (loaded.refMissing) throw new Error('cannot approve: a side of this comparison no longer resolves')
    const hash = approvalKey(loaded)
    if (!s.state.approvals.some((a) => a.hash === hash)) s.state.approvals.push({ sha: loaded.headSha, hash, at: now(), signature: loaded.signature })
    save(s); changed(id)
    return s.state
  }),
  unapprove: (/** @type {number} */ id) => locked(id, async () => {
    const s = store.get(id)
    const hash = approvalKey(await load(s))
    s.state.approvals = s.state.approvals.filter((a) => a.hash !== hash)
    save(s); changed(id)
    return s.state
  }),
  approveArtifact: (/** @type {number} */ id, /** @type {string} */ p, /** @type {boolean} */ approved) => locked(id, async () => {
    const s = store.get(id)
    if (approved) s.state.artifactApprovals[p] = (await load(s)).headSha; else delete s.state.artifactApprovals[p]
    save(s); changed(id)
    return s.state
  }),
  setArtifacts: (/** @type {number} */ id, /** @type {any[]} */ refs) => locked(id, async () => {
    const s = store.get(id)
    s.state.artifactsChecked = true
    s.state.artifacts = (Array.isArray(refs) ? refs : []).map((r) => ({ role: r?.role === 'plan' ? /** @type {const} */ ('plan') : /** @type {const} */ ('spec'), path: String(r?.path ?? '') })).filter((r) => r.path)
    const loaded = await load(s)
    const missing = s.state.artifacts.filter((r) => !loaded.artifacts.some((a) => a.path === r.path)).map((r) => r.path)
    if (missing.length) { s.state.artifacts = s.state.artifacts.filter((r) => !missing.includes(r.path)); save(s); throw new Error(`cannot read ${missing.join(', ')} on the compare side`) }
    save(s); changed(id)
    return s.state
  }),
  getPrefs: () => store.index.prefs,
  setPref: (/** @type {string} */ key, /** @type {string} */ value) => { store.setPref(String(key), String(value)) },

  // ── requests from the reviewer to the Claude Code session ──
  requestCreate: (/** @type {number} */ id, /** @type {any} */ input) => locked(id, async () => {
    const s = store.get(id)
    const kind = input?.kind
    if (!['walkthrough', 'question', 'apply', 'decisions'].includes(kind)) throw new Error(`unknown request kind ${kind}`)
    const text = String(input.text ?? '').trim()
    const open = s.state.requests.filter((r) => r.status === 'pending' || r.status === 'running')
    const loaded = await load(s)
    /** @type {ReviewRequest} */
    const r = { id: store.nextId(s, 'r'), kind, status: 'pending', progress: [], createdAt: now() }
    if (text) r.text = text
    if (kind === 'walkthrough') {
      if (open.some((x) => x.kind === 'walkthrough')) throw new Error('a walkthrough request is already waiting')
      r.update = Boolean(input.update && s.state.walkthrough)
    } else if (kind === 'question') {
      if (!text) throw new Error('a question needs text')
      if (input.anchor) r.anchor = await makeAnchor(loaded, input.anchor, sideReader(s.repo, loaded))
      s.state.messages.push({ id: store.nextId(s, 'm'), role: 'user', text, at: now(), ...(r.anchor ? { anchor: r.anchor } : {}), requestId: r.id })
    } else {
      const ids = Array.isArray(input.commentIds) ? input.commentIds.map(String) : []
      const hasReply = (/** @type {import('../shared/types.ts').Comment} */ c) => c.replies.some((x) => x.pending)
      const picked = s.state.comments.filter((c) => ids.includes(c.id) && (c.status === 'queued' || (kind === 'apply' && hasReply(c))))
      if (!picked.length) throw new Error('none of those comments is waiting to be sent')
      if (kind === 'apply') {
        // threads sent only for a new reply keep their status; new comments become `sent`
        r.replyIds = picked.filter((c) => c.status !== 'queued').map((c) => c.id)
        r.editable = loaded.apply.enabled
        r.commit = Boolean(input.commit) && loaded.apply.enabled
      }
      for (const c of picked) {
        if (c.status === 'queued') c.status = 'sent'
        for (const x of c.replies) delete x.pending
      }
      r.commentIds = picked.map((c) => c.id)
    }
    s.state.requests.push(r)
    save(s); changed(id)
    return r
  }),
  requestCancel: (/** @type {number} */ id, /** @type {string} */ rid) => locked(id, async () => {
    const s = store.get(id)
    const r = s.state.requests.find((x) => x.id === rid)
    if (!r) throw new Error(`no request ${rid}`)
    const wasRunning = r.status === 'running'
    if (r.status === 'pending' || r.status === 'running') finish(s, r, 'cancelled')
    save(s); changed(id); refreshPresence(id)
    if (wasRunning) push('request:cancelled', { sessionId: id, requestId: r.id })
    return r
  }),
  requestRetry: (/** @type {number} */ id, /** @type {string} */ rid) => locked(id, async () => {
    const s = store.get(id)
    const r = s.state.requests.find((x) => x.id === rid)
    if (!r) throw new Error(`no request ${rid}`)
    if (r.status !== 'running') throw new Error(`request ${rid} is ${r.status}, not running`)
    r.status = 'pending'; delete r.startedAt
    r.progress.push({ at: now(), text: 'Sent again by the reviewer.' })
    save(s); changed(id); refreshPresence(id)
    return r
  }),
  requestTake: (/** @type {number} */ id) => locked(id, async () => {
    const s = store.get(id)
    const taken = s.state.requests.filter((r) => r.status === 'pending')
    for (const r of taken) { r.status = 'running'; r.startedAt = now() }
    if (taken.length) { save(s); changed(id) }
    refreshPresence(id)
    return taken
  }),
  async requestTakeAll(/** @type {string} */ dir, includeRunning = false) {
    const repo = await repoOf(dir)
    const out = []
    for (const s of store.list(repo)) {
      const got = await locked(s.id, async () => {
        const mine = s.state.requests.filter((r) => r.status === 'pending' || (includeRunning && r.status === 'running'))
        const items = mine.map((r) => ({ sessionId: s.id, request: r, resumed: r.status === 'running', comments: s.state.comments.filter((c) => r.commentIds?.includes(c.id)) }))
        let any = false
        for (const r of mine) if (r.status === 'pending') { r.status = 'running'; r.startedAt = now(); any = true }
        if (any) { save(s); changed(s.id) }
        if (mine.length) { seen.set(s.id, Date.now()); refreshPresence(s.id) }
        return structuredClone(items)
      })
      out.push(...got)
    }
    return out
  },
  /** Several bridge calls as one update. Nothing is saved or announced until every step
   *  has succeeded; if one fails the review is put back exactly as it was. */
  batch: (/** @type {number} */ id, /** @type {any[]} */ ops) => locked(id, async () => {
    const s = store.get(id)
    if (!Array.isArray(ops) || !ops.length) throw new Error('a batch is a non-empty list of operations')
    const before = { state: structuredClone(s.state), seq: s.seq, updatedAt: s.updatedAt }
    const batch = { pushes: /** @type {[string, any][]} */ ([]), notes: /** @type {[number, string, string][]} */ ([]) }
    const results = []
    try {
      await scope.run({ id, batch }, async () => {
        for (const [i, op] of ops.entries()) {
          if (!BATCHABLE.has(op?.channel)) throw new Error(`operation ${i + 1}: "${op?.channel}" cannot be used in a batch`)
          try { results.push(await api[op.channel](id, ...(Array.isArray(op.args) ? op.args : []))) } catch (err) {
            throw new Error(`operation ${i + 1} (${op.channel}) failed: ${err instanceof Error ? err.message : err} — nothing was applied`)
          }
        }
      })
    } catch (err) {
      Object.assign(s, { state: before.state, seq: before.seq, updatedAt: before.updatedAt })
      store['save'](s, { touch: false }) // a load inside the batch may have written a partial state
      throw err
    }
    store.save(s)
    changed(id)
    for (const [channel, msg] of batch.pushes) if (channel !== 'session:changed') push(channel, msg)
    for (const [sid, title, body] of batch.notes.slice(-1)) notify(sid, title, body)
    refreshPresence(id)
    return { results }
  }),
  requestUpdate: (/** @type {number} */ id, /** @type {string} */ rid, /** @type {any} */ patch) => locked(id, async () => {
    const s = store.get(id)
    const r = liveRequest(s, rid)
    if (patch?.progress) r.progress.push({ at: now(), text: String(patch.progress) })
    if (patch?.status === 'done' || patch?.status === 'failed') {
      finish(s, r, patch.status, patch.status === 'failed' ? String(patch.error || 'failed') : undefined)
      notify(id, patch.status === 'done' ? 'Claude Code finished' : 'Claude Code could not finish', r.kind === 'apply' ? `${r.commentIds?.length ?? 0} comment(s) handled` : r.error ?? r.kind)
    }
    save(s); changed(id); refreshPresence(id)
    return r
  }),
  messagePost: (/** @type {number} */ id, /** @type {any} */ input) => locked(id, async () => {
    const s = store.get(id)
    const text = String(input?.text ?? '').trim()
    if (!text) throw new Error('a message needs text')
    const r = input.requestId ? liveRequest(s, String(input.requestId)) : null
    if (r && r.kind !== 'question') throw new Error(`request ${r.id} is a ${r.kind} request, not a question`)
    const loaded = input.actions?.length ? await load(s) : null
    const actions = []
    for (const a of input.actions ?? []) actions.push(await checkAction(s, /** @type {any} */ (loaded), a))
    /** @type {import('../shared/types.ts').Message} */
    const m = { id: store.nextId(s, 'm'), role: 'agent', text, at: now(), ...(r ? { requestId: r.id } : {}), ...(actions.length ? { actions } : {}) }
    s.state.messages.push(m)
    if (r) { finish(s, r, 'done'); notify(id, 'Claude Code answered', text.slice(0, 120)) }
    save(s); changed(id); refreshPresence(id)
    // the first focus/tour also plays live, so the answer lands with the code it cites on screen
    if (actions[0]) push('ui:action', { sessionId: id, action: actions[0] })
    return m
  }),
  annotate: (/** @type {number} */ id, /** @type {any} */ raw, /** @type {string} */ requestId) => locked(id, async () => {
    const s = store.get(id)
    const r = requestId ? liveRequest(s, String(requestId)) : null
    const loaded = await load(s)
    if (loaded.refMissing) throw new Error('a side of this comparison no longer resolves')
    const { walkthrough, warnings } = reconcile(loaded.files, raw)
    s.state.walkthrough = walkthrough
    s.state.iterations.push({ n: s.state.iterations.length + 1, at: now(), endSha: loaded.headSha, title: walkthrough.title, summary: walkthrough.summary })
    s.state.reviewedAtSha = loaded.headSha
    s.state.reviewedSignature = loaded.signature
    s.state.reviewedSections = s.state.reviewedSections.filter((sid) => walkthrough.sections.some((x) => x.id === sid))
    for (const p of Array.isArray(raw.artifactPaths) ? raw.artifactPaths.map(String) : []) {
      const role = artifactRole(p)
      if (role && !s.state.artifacts.some((a) => a.path === p) && (await tryGit(s.repo, ['cat-file', '-e', `${loaded.headSha}:${p}`])) !== null) s.state.artifacts.push({ role, path: p })
    }
    if (r) finish(s, r, 'done')
    save(s); changed(id); refreshPresence(id)
    notify(id, 'Walkthrough ready', `${walkthrough.sections.length} sections — ${walkthrough.title}`)
    return { sections: walkthrough.sections.length, warnings }
  }),
  uiAction: (/** @type {number} */ id, /** @type {any} */ action) => locked(id, async () => {
    const s = store.get(id)
    const checked = await checkAction(s, await load(s), action)
    push('ui:action', { sessionId: id, action: checked })
    return { tabs: tabsOf(id) }
  })
}
/** Validate a UI action; focus and tour targets must exist in a changed file.
 *  @param {Session} s @param {import('../shared/types.ts').LoadedReview} loaded @param {any} a */
async function checkAction(s, loaded, a) {
  const read = sideReader(s.repo, loaded)
  if (a?.kind === 'focus') return { kind: 'focus', target: await makeFocus(loaded, a.target, read) }
  if (a?.kind === 'tour') {
    if (!Array.isArray(a.stops) || a.stops.length < 2 || a.stops.length > 8) throw new Error('a tour has 2 to 8 stops')
    const stops = []
    for (const st of a.stops) stops.push({ target: await makeFocus(loaded, st?.target, read), ...(st?.note ? { note: String(st.note) } : {}) })
    return { kind: 'tour', stops, ...(a.loop ? { loop: true } : {}) }
  }
  if (a?.kind === 'status' && a.text) return { kind: 'status', text: String(a.text).slice(0, 300) }
  if (a?.kind === 'navigate' && /^#\//.test(a.hash ?? '')) return { kind: 'navigate', hash: String(a.hash) }
  throw new Error('unknown UI action')
}
/** What a batch may contain. */
const BATCHABLE = new Set(['commentAdd', 'commentUpdate', 'commentDelete', 'messagePost', 'requestUpdate', 'annotate', 'uiAction', 'setViewed', 'setArtifacts'])
/** Channels the bridge uses; a call to one marks the session as present. */
const BRIDGE_HEADER = 'x-guided-review-bridge'

// ── HTTP ─────────────────────────────────────────────────────
const isLoopback = (/** @type {string} */ name) => ['localhost', '127.0.0.1', '::1'].includes(name.toLowerCase().replace(/^\[|\]$/g, ''))
/** Cross-site and DNS-rebinding guard for /rpc and /events: an Origin, when present,
 *  must match Host; and without a token Host must be a loopback name.
 *  @param {http.IncomingMessage} req */
function sameSite(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try { if (new URL(origin).host.toLowerCase() !== host) return false } catch { return false }
  }
  return Boolean(TOKEN) || isLoopback(host.replace(/:\d+$/, ''))
}
/** @param {http.IncomingMessage} req @param {URL} url */
function authorized(req, url) {
  if (!TOKEN) return true
  const eq = (/** @type {string} */ a) => a.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(TOKEN))
  const h = req.headers.authorization
  return (typeof h === 'string' && h.startsWith('Bearer ') && eq(h.slice(7))) || eq(url.searchParams.get('token') ?? '')
}
const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8'
})
/** @param {string} pathname @param {http.ServerResponse} res */
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const full = path.join(STATIC_ROOT, rel)
  const file = full === STATIC_ROOT || full.startsWith(STATIC_ROOT + path.sep) ? full : path.join(STATIC_ROOT, 'index.html')
  fs.readFile(file, (err, buf) => {
    if (!err) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf); return }
    fs.readFile(path.join(STATIC_ROOT, 'index.html'), (e2, idx) => {
      if (e2) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('The web UI is not built. Run scripts/install.sh in the guided-review skill.')
      else res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(idx)
    })
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const active = url.pathname === '/events' || url.pathname.startsWith('/rpc/')
  if (active && !authorized(req, url)) { res.writeHead(401).end('unauthorized'); return }
  if (active && !sameSite(req)) { res.writeHead(403).end('forbidden origin'); return }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
    res.write('retry: 2000\n\n')
    const sid = Number(url.searchParams.get('session'))
    const client = { res, sessionId: Number.isInteger(sid) && sid > 0 ? sid : null, repo: url.searchParams.get('repo') || null, ui: url.searchParams.get('ui') === '1', bridge: url.searchParams.get('bridge') === '1', changes: url.searchParams.get('changes') === '1' }
    clients.add(client); touch()
    markBridge(client)
    // a tab learns the current fingerprint as soon as it connects, so a change that
    // landed between its load and the watcher's first look is not missed
    const opened = client.ui && client.sessionId ? store.sessions.get(client.sessionId) : null
    if (opened) {
      signatureOf(opened).then((sig) => {
        if (sig && clients.has(client)) res.write(`data: ${JSON.stringify({ channel: 'repo:changed', msg: { sessionId: opened.id, signature: sig.signature, headSha: sig.head, dirty: sig.dirty } })}\n\n`)
      }, () => {})
    }
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(keepalive); clients.delete(client); touch()
      markBridge(client)
    })
    return
  }
  if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) {
    const channel = decodeURIComponent(url.pathname.slice(5))
    const fn = Object.hasOwn(api, channel) ? api[channel] : null
    if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `unknown channel ${channel}` })); return }
    touch()
    const chunks = /** @type {Buffer[]} */ ([])
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const args = raw ? JSON.parse(raw) : []
        if (!Array.isArray(args)) throw new Error('the request body must be a JSON array of arguments')
        if (req.headers[BRIDGE_HEADER] && typeof args[0] === 'number' && store.sessions.has(args[0])) { seen.set(args[0], Date.now()); refreshPresence(args[0]) }
        const value = await fn(...args)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ value: value ?? null }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    })
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') { serveStatic(url.pathname, res); return }
  res.writeHead(405).end('method not allowed')
})

if (!isLoopback(HOST) && !TOKEN) {
  console.error(`[guided-review] refusing to bind ${HOST} without GUIDED_REVIEW_TOKEN: that would expose this machine's repositories to the network.`)
  process.exit(1)
}
server.listen(PORT, HOST, () => {
  console.log(`[guided-review] ${VERSION} listening on http://${HOST}:${PORT}  (data: ${HOME})`)
})
for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.on(sig, () => { for (const c of clients) c.res.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref() })
