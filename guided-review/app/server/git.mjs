// @ts-check
// Git is the only source of code and diffs. Everything here reads; nothing writes
// to the repository, its index, or its refs.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** @typedef {import('../shared/types.ts').FileDiff} FileDiff */
/** @typedef {import('../shared/types.ts').Hunk} Hunk */
/** @typedef {import('../shared/types.ts').CommitInfo} CommitInfo */

/** git's well-known empty tree: the base of a root commit or of unrelated histories. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '-M']
/** Untracked files larger than this are listed but not inlined. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024

/** Run git in `dir`. Never through a shell.
 *  - core.quotePath=false keeps non-ASCII paths verbatim.
 *  - GIT_OPTIONAL_LOCKS=0: we poll `git status`; without it the index refresh takes
 *    index.lock and can make the user's own concurrent git command fail.
 *  @param {string} dir @param {string[]} args @param {{ input?: string }} [opts]
 *  @returns {Promise<string>} */
export function git(dir, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: dir, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
    if (opts.input != null) child.stdin?.end(opts.input)
  })
}
/** @param {string} dir @param {string[]} args @returns {Promise<string | null>} */
export const tryGit = (dir, args) => git(dir, args).then((s) => s, () => null)

/** A ref the user typed reaches git as a positional operand: refuse anything that
 *  git would read as an option. @param {string} ref */
export function assertSafeRef(ref) {
  if (!ref || /^-/.test(ref) || /[\0\n]/.test(ref)) throw new Error(`invalid ref: ${JSON.stringify(ref)}`)
}

// ── repositories, refs ───────────────────────────────────────
/** The primary worktree of the repository containing `dir`, or null.
 *  @param {string} dir */
export async function primaryRepo(dir) {
  if (!fs.existsSync(dir)) return null
  const top = (await tryGit(dir, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return null
  const trees = await worktrees(top)
  return trees[0]?.path ?? top
}
/** @param {string} dir */
export async function branches(dir) {
  return (await git(dir, ['branch', '--format=%(refname:short)'])).split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('('))
}
/** @param {string} dir */
export async function tags(dir) {
  return (await git(dir, ['tag', '--sort=-creatordate'])).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50)
}
/** Branch checked out in `dir`, or null when HEAD is detached. @param {string} dir */
export async function currentBranch(dir) {
  return (await tryGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null
}
/** @param {string} dir */
export async function defaultBase(dir) {
  const b = await branches(dir)
  return b.includes('main') ? 'main' : b.includes('master') ? 'master' : b[0] ?? 'HEAD'
}
/** Commit a ref points at, or null. @param {string} dir @param {string} ref */
export async function commitOf(dir, ref) {
  if (ref === EMPTY_TREE) return null
  return (await tryGit(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]))?.trim() || null
}
/** @param {string} dir @returns {Promise<{ path: string; branch: string | null; head: string; primary: boolean }[]>} */
export async function worktrees(dir) {
  const out = await git(dir, ['worktree', 'list', '--porcelain'])
  /** @type {{ path: string; branch: string | null; head: string; primary: boolean }[]} */
  const trees = []
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    const wt = lines.find((l) => l.startsWith('worktree '))
    if (!wt || lines.includes('bare')) continue
    const br = lines.find((l) => l.startsWith('branch '))
    trees.push({
      path: wt.slice(9), head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? '',
      branch: br ? br.slice(7).replace(/^refs\/heads\//, '') : null, primary: trees.length === 0
    })
  }
  return trees
}
/** `git status --porcelain` entries (empty = clean). @param {string} dir */
export async function statusEntries(dir) {
  return (await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean)
}
/** @param {string} dir @param {string | null} a @param {string} b @returns {Promise<string | null>} */
export async function mergeBase(dir, a, b) {
  if (!a) return null
  return (await tryGit(dir, ['merge-base', a, b]))?.trim() || null
}
/** @param {string} dir @param {string} range @param {number} [limit] @returns {Promise<CommitInfo[]>} */
export async function log(dir, range, limit = 300) {
  const out = await tryGit(dir, ['log', '--format=%H%x00%s%x00%an%x00%aI', '-n', String(limit), range])
  return (out ?? '').split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split('\0')
    return { sha, subject, author, date }
  })
}
/** Blob hash of each existing path as it is on disk. Reads only (no -w).
 *  @param {string} dir @param {string[]} paths @returns {Promise<Map<string, string>>} */
export async function hashFiles(dir, paths) {
  const existing = paths.filter((p) => { try { return fs.statSync(path.join(dir, p)).isFile() } catch { return false } })
  const out = new Map()
  if (!existing.length) return out
  const raw = await git(dir, ['hash-object', '--stdin-paths'], { input: existing.join('\n') + '\n' })
  const shas = raw.split('\n').filter(Boolean)
  existing.forEach((p, i) => { if (shas[i]) out.set(p, shas[i]) })
  return out
}

// ── diffs ────────────────────────────────────────────────────
/** Parse `git diff` unified output. Paths come from the rename lines or, for every
 *  other file, from the `diff --git a/<p> b/<p>` header whose two halves are equal —
 *  which is unambiguous even for paths containing spaces.
 *  @param {string} raw @returns {FileDiff[]} */
export function parsePatch(raw) {
  /** @type {FileDiff[]} */
  const files = []
  const chunks = raw.split(/^diff --git /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const header = lines[0]
    /** @type {FileDiff['status']} */
    let status = 'modified'
    let binary = false
    let from; let to; let oldMode; let newMode
    /** @type {Hunk[]} */
    const hunks = []
    let i = 1
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (l.startsWith('@@')) break
      if (l.startsWith('rename from ')) { from = l.slice(12); status = 'renamed' }
      else if (l.startsWith('rename to ')) { to = l.slice(10); status = 'renamed' }
      else if (l.startsWith('new file mode')) status = 'added'
      else if (l.startsWith('deleted file mode')) status = 'deleted'
      else if (l.startsWith('old mode ')) oldMode = l.slice(9).trim()
      else if (l.startsWith('new mode ')) newMode = l.slice(9).trim()
      else if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) binary = true
    }
    while (i < lines.length) {
      const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/)
      if (!m) { i++; continue }
      let oldNo = Number(m[1]); let newNo = Number(m[3])
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]); let newLeft = m[4] === undefined ? 1 : Number(m[4])
      /** @type {Hunk} */
      const hunk = { range: lines[i].slice(0, lines[i].indexOf('@@', 2) + 2), header: m[5] ?? '', lines: [] }
      i++
      // the header's counts say exactly how many lines belong to the hunk, so a
      // source line that happens to start with "diff --git" or "@@" cannot end it early
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const l = lines[i++]
        const c = l[0]
        if (c === '\\') continue // "\ No newline at end of file"
        if (c === '+') { hunk.lines.push({ old: null, new: newNo++, kind: 'add', text: l.slice(1) }); newLeft-- }
        else if (c === '-') { hunk.lines.push({ old: oldNo++, new: null, kind: 'del', text: l.slice(1) }); oldLeft-- }
        else { hunk.lines.push({ old: oldNo++, new: newNo++, kind: '', text: l.slice(1) }); oldLeft--; newLeft-- }
      }
      hunks.push(hunk)
    }
    let filePath = to
    if (!filePath) {
      // "a/<p> b/<p>" with identical halves; git quotes paths holding quotes/control chars
      const q = header.match(/^"a\/(.*)" "b\/\1"$/)
      const half = (header.length - 5) / 2
      filePath = q ? unquote(q[1]) : Number.isInteger(half) && header.slice(2, 2 + half) === header.slice(5 + half) ? header.slice(2, 2 + half) : undefined
    }
    if (!filePath) continue
    /** @type {FileDiff} */
    const file = { path: filePath, status, binary, add: 0, del: 0, hunks: binary ? [] : hunks }
    if (status === 'renamed' && from && from !== filePath) file.oldPath = from
    if (oldMode && newMode && oldMode !== newMode) file.modeChange = { from: oldMode, to: newMode }
    for (const h of file.hunks) for (const l of h.lines) { if (l.kind === 'add') file.add++; else if (l.kind === 'del') file.del++ }
    files.push(file)
  }
  return files
}
/** @param {string} s */
function unquote(s) {
  return s.replace(/\\(["\\tn])/g, (_, c) => (c === 't' ? '\t' : c === 'n' ? '\n' : c))
}

/** Diff between two commits/trees. `extra` adds git diff flags (e.g. `-w`).
 *  @param {string} dir @param {string} a @param {string} b @param {string[]} [extra] */
export async function diffTrees(dir, a, b, extra = []) {
  return parsePatch(await git(dir, [...DIFF, ...extra, a, b, '--']))
}
/** Diff from a commit/tree to the working tree of `dir`, untracked files included
 *  as added files. The index is not touched.
 *  @param {string} dir @param {string} from @param {string[]} [extra] */
export async function diffWorktree(dir, from, extra = []) {
  const files = parsePatch(await git(dir, [...DIFF, ...extra, from, '--']))
  const known = new Set(files.map((f) => f.path))
  for (const f of await untrackedFiles(dir)) if (!known.has(f.path)) files.push(f)
  const conflicted = new Set((await git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean))
  for (const f of files) if (conflicted.has(f.path)) f.conflict = true
  return files
}
/** Untracked files as fully-added FileDiffs. Binary (NUL byte) and oversized files
 *  are listed without content. @param {string} dir @returns {Promise<FileDiff[]>} */
export async function untrackedFiles(dir) {
  const paths = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  /** @type {FileDiff[]} */
  const out = []
  for (const p of paths) {
    let stat
    try { stat = fs.statSync(path.join(dir, p)) } catch { continue }
    if (!stat.isFile()) continue
    /** @type {FileDiff} */
    const blob = { path: p, status: 'added', binary: true, untracked: true, add: 0, del: 0, hunks: [] }
    if (stat.size > MAX_INLINE_BYTES) { out.push(blob); continue }
    let content
    try { content = fs.readFileSync(path.join(dir, p), 'utf8') } catch { continue }
    if (content.includes('\0')) { out.push(blob); continue }
    const lines = content.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    out.push({
      path: p, status: 'added', binary: false, untracked: true, add: lines.length, del: 0,
      hunks: lines.length ? [{ range: `@@ -0,0 +1,${lines.length} @@`, header: '', lines: lines.map((text, i) => ({ old: null, new: i + 1, kind: /** @type {const} */ ('add'), text })) }] : []
    })
  }
  return out
}

/** Label every changed line of a base→working-tree diff as committed, staged or
 *  unstaged. All three diffs involved have the working tree as their new side, so
 *  added lines join exactly on new-line number:
 *    unstaged  = added in  index → working tree
 *    staged    = added in  HEAD  → working tree, but not unstaged
 *    committed = everything else
 *  Removed lines have no new-side number; one that the committed diff also removes
 *  (same old-line number) is committed, otherwise it is matched by text against the
 *  unstaged removals.
 *  @param {string} dir @param {FileDiff[]} surface @param {FileDiff[]} committed */
export async function tagOrigins(dir, surface, committed) {
  const [unstaged, uncommitted] = await Promise.all([
    git(dir, [...DIFF, '--']).then(parsePatch),
    git(dir, [...DIFF, 'HEAD', '--']).then(parsePatch, () => /** @type {FileDiff[]} */ ([]))
  ])
  /** @param {FileDiff[]} files @param {'add' | 'del'} kind @param {'new' | 'old' | 'text'} key */
  const index = (files, kind, key) => new Map(files.map((f) => [f.path, new Set(f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === kind).map((l) => (key === 'text' ? l.text : l[key]))))]))
  const unstagedAdds = index(unstaged, 'add', 'new'); const uncommittedAdds = index(uncommitted, 'add', 'new')
  const committedDels = index(committed, 'del', 'old'); const unstagedDelText = index(unstaged, 'del', 'text')
  for (const f of surface) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (f.untracked) { if (l.kind) l.origin = 'unstaged'; continue }
        if (l.kind === 'add') l.origin = unstagedAdds.get(f.path)?.has(l.new) ? 'unstaged' : uncommittedAdds.get(f.path)?.has(l.new) ? 'staged' : 'committed'
        else if (l.kind === 'del') l.origin = committedDels.get(f.path)?.has(l.old) || committedDels.get(f.oldPath ?? '')?.has(l.old) ? 'committed' : unstagedDelText.get(f.path)?.has(l.text) ? 'unstaged' : 'staged'
      }
    }
  }
}

/** A fingerprint of everything reviewable at `headRef` (+ the working tree of
 *  `workdir`): it changes exactly when the code under review changes.
 *  @param {string} repo @param {string} headRef @param {string | null} workdir */
export async function surfaceSignature(repo, headRef, workdir) {
  const head = (await git(workdir ?? repo, ['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`])).trim()
  if (!workdir) return { head, dirty: false, signature: head }
  const status = await statusEntries(workdir)
  if (!status.length) return { head, dirty: false, signature: head }
  const h = createHash('sha256').update(head).update('\0').update(status.join('\0')).update('\0')
  h.update(await git(workdir, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']).catch(() => ''))
  const untracked = (await git(workdir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort()
  const hashes = await hashFiles(workdir, untracked)
  for (const p of untracked) h.update(`${p}\0${hashes.get(p) ?? ''}\0`)
  return { head, dirty: true, signature: `${head}+${h.digest('hex').slice(0, 24)}` }
}
