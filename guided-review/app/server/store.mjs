// @ts-check
// Local persistence: one JSON file per review plus a small index. Only the review
// layer lives here (walkthrough, comments, conversation, requests, marks,
// approvals); code and diffs are always re-read from git.
//
//   <home>/index.json            { nextId, repos: { <path>: { lastOpenedAt } }, prefs }
//   <home>/sessions/<id>.json    one review
//
// One server process owns the directory. Writes are atomic (temp file + rename), so
// a crash leaves the previous version intact.
import fs from 'node:fs'
import path from 'node:path'

/** @typedef {import('../shared/types.ts').RefSide} RefSide */
/** @typedef {import('../shared/types.ts').RefPair} RefPair */
/** @typedef {import('../shared/types.ts').ReviewState} ReviewState */
/** @typedef {import('../shared/types.ts').EffortLevel} EffortLevel */
/** @typedef {{ id: number, repo: string, pair: RefPair, direct: boolean, effort?: EffortLevel, createdAt: string, updatedAt: string, archived: boolean, seq: number, state: ReviewState }} Session */

export const now = () => new Date().toISOString()

/** Stable identity of one side: branches by name (moving), commits by SHA (frozen).
 *  @param {RefSide} s */
export function identity(s) {
  return s.kind === 'branch' ? `b:${s.symbol}` : s.kind === 'commit' ? `c:${s.anchorSha}` : s.kind === 'empty' ? 'e:' : `w:${s.path}`
}
/** @param {RefPair} pair @param {boolean} direct */
export const pairIdentity = (pair, direct) => `${identity(pair.base)}→${identity(pair.compare)}${direct ? '|direct' : ''}`

/** @returns {ReviewState} */
export function emptyState() {
  return {
    iterations: [], comments: [], messages: [], requests: [], viewedAt: {}, reviewedSections: [], resolvedAsks: [],
    fileExcluded: {}, approvals: [], artifactApprovals: {}, artifacts: [], effortDone: {}
  }
}

export class Store {
  /** @param {string} home */
  constructor(home) {
    this.home = home
    this.dir = path.join(home, 'sessions')
    fs.mkdirSync(this.dir, { recursive: true })
    /** @type {string[]} */
    this.notices = []
    /** @type {{ nextId: number, repos: Record<string, { lastOpenedAt: string }>, prefs: Record<string, string> }} */
    this.index = { nextId: 1, repos: {}, prefs: {}, .../** @type {object} */ (this.#read(path.join(home, 'index.json')) ?? {}) }
    /** @type {Map<number, Session>} */
    this.sessions = new Map()
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^\d+\.json$/.test(name)) continue
      const s = /** @type {Session | null} */ (this.#read(path.join(this.dir, name)))
      if (!s || typeof s.id !== 'number' || !s.pair) continue
      s.state = { ...emptyState(), ...s.state }
      this.sessions.set(s.id, s)
      this.index.nextId = Math.max(this.index.nextId, s.id + 1)
    }
  }

  /** Read a JSON file. A file that does not parse is moved aside, never deleted.
   *  @param {string} file */
  #read(file) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
    try { return JSON.parse(raw) } catch {
      const aside = `${file}.corrupt-${Date.now()}`
      try { fs.renameSync(file, aside) } catch { /* leave it */ }
      this.notices.push(`${path.basename(file)} could not be read and was set aside as ${path.basename(aside)}.`)
      return null
    }
  }
  /** @param {string} file @param {unknown} value */
  #write(file, value) {
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1))
    fs.renameSync(tmp, file)
  }
  #saveIndex() { this.#write(path.join(this.home, 'index.json'), this.index) }

  /** @param {number} id @returns {Session} */
  get(id) {
    const s = this.sessions.get(Number(id))
    if (!s) throw new Error(`review #${id} not found`)
    return s
  }
  /** Persist a session after mutating it. @param {Session} s @param {{ touch?: boolean }} [opts] */
  save(s, opts = {}) {
    if (opts.touch !== false) s.updatedAt = now()
    this.#write(path.join(this.dir, `${s.id}.json`), s)
  }
  /** @param {string} repo @param {RefPair} pair @param {boolean} direct @param {EffortLevel} [effort] @returns {Session} */
  create(repo, pair, direct, effort) {
    const t = now()
    /** @type {Session} */
    const s = { id: this.index.nextId++, repo, pair, direct, ...(effort ? { effort } : {}), createdAt: t, updatedAt: t, archived: false, seq: 0, state: emptyState() }
    this.sessions.set(s.id, s)
    this.#saveIndex()
    this.save(s, { touch: false })
    return s
  }
  /** Most recently touched live review with exactly this identity.
   *  @param {string} repo @param {RefPair} pair @param {boolean} direct */
  find(repo, pair, direct) {
    const key = pairIdentity(pair, direct)
    return this.list(repo).find((s) => pairIdentity(s.pair, s.direct) === key) ?? null
  }
  /** Reviews of a repo, most recently touched first. @param {string} repo @param {boolean} [includeArchived] */
  list(repo, includeArchived = false) {
    return [...this.sessions.values()].filter((s) => s.repo === repo && (includeArchived || !s.archived))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  all() { return [...this.sessions.values()].filter((s) => !s.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }

  /** @param {string} repo */
  touchRepo(repo) { this.index.repos[repo] = { lastOpenedAt: now() }; this.#saveIndex() }
  /** @param {string} key @param {string} value */
  setPref(key, value) { this.index.prefs[key] = value; this.#saveIndex() }
  /** A session-unique id such as "c12". @param {Session} s @param {string} prefix */
  nextId(s, prefix) { s.seq = (s.seq ?? 0) + 1; return `${prefix}${s.seq}` }
}
