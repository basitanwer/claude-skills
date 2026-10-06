// @ts-check
// Turns a saved comparison into what the reviewer sees: the live git diff, with
// "since" marks, viewed state, re-anchored comments and discovered spec/plan files.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  EMPTY_TREE, assertSafeRef, branches, commitOf, currentBranch, diffTrees, diffWorktree, git, hashFiles, log, mergeBase,
  statusEntries, surfaceSignature, tagOrigins, tryGit, worktrees
} from './git.mjs'

/** @typedef {import('../shared/types.ts').FileDiff} FileDiff */
/** @typedef {import('../shared/types.ts').RefSide} RefSide */
/** @typedef {import('../shared/types.ts').Comment} Comment */
/** @typedef {import('../shared/types.ts').CommentAnchor} CommentAnchor */
/** @typedef {import('../shared/types.ts').Artifact} Artifact */
/** @typedef {import('../shared/types.ts').Walkthrough} Walkthrough */
/** @typedef {import('../shared/types.ts').LoadedReview} LoadedReview */
/** @typedef {import('./store.mjs').Session} Session */

const short = (/** @type {string} */ sha) => sha.slice(0, 7)

// ── ref input → side ─────────────────────────────────────────
/** Classify what the user typed. An exact local branch name is a moving side;
 *  anything else git resolves to a commit is frozen at that commit.
 *  `@empty` (base only) is the empty tree; `@worktree` (compare only) is the working
 *  tree of a detached HEAD.
 *  @param {string} repo @param {string} input @param {'base' | 'compare'} side @returns {Promise<RefSide>} */
export async function resolveInput(repo, input, side) {
  const ref = String(input ?? '').trim()
  if (ref === '@empty' || ref === EMPTY_TREE) {
    if (side !== 'base') throw new Error('the empty tree can only be the base of a comparison')
    return { kind: 'empty', symbol: 'empty tree', anchorSha: EMPTY_TREE }
  }
  if (ref === '@worktree') {
    if (side !== 'compare') throw new Error('the working tree can only be the compare side')
    const branch = await currentBranch(repo)
    const head = await commitOf(repo, 'HEAD')
    if (!head) throw new Error('this repository has no commits yet')
    if (branch) return { kind: 'branch', symbol: branch, anchorSha: head }
    return { kind: 'worktree', symbol: `working tree (detached at ${short(head)})`, anchorSha: head, path: repo }
  }
  assertSafeRef(ref)
  const sha = await commitOf(repo, ref)
  if ((await branches(repo)).includes(ref) && sha) return { kind: 'branch', symbol: ref, anchorSha: sha }
  if (!sha) throw new Error(`not a branch or commit: ${input}`)
  return { kind: 'commit', symbol: ref, anchorSha: sha }
}

/** Where both sides are right now.
 *  @param {string} repo @param {import('../shared/types.ts').RefPair} pair */
async function resolveNow(repo, pair) {
  /** @type {{ baseSha: string | null, headSha: string, headRef: string, workdir: string | null, missing?: { side: 'base' | 'compare', symbol: string } }} */
  const out = { baseSha: null, headSha: '', headRef: '', workdir: null }
  const { base, compare } = pair
  if (base.kind !== 'empty') {
    out.baseSha = await commitOf(repo, base.kind === 'branch' ? base.symbol : base.anchorSha)
    if (!out.baseSha) { out.missing = { side: 'base', symbol: base.symbol }; return out }
  }
  if (compare.kind === 'worktree') {
    const dir = compare.path ?? repo
    const head = fs.existsSync(dir) ? await commitOf(dir, 'HEAD') : null
    if (!head) { out.missing = { side: 'compare', symbol: compare.symbol }; return out }
    Object.assign(out, { headSha: head, headRef: 'HEAD', workdir: dir })
  } else {
    const ref = compare.kind === 'branch' ? compare.symbol : compare.anchorSha
    const head = await commitOf(repo, ref)
    if (!head) { out.missing = { side: 'compare', symbol: compare.symbol }; return out }
    out.headSha = head; out.headRef = ref
    if (compare.kind === 'branch') out.workdir = (await worktrees(repo)).find((w) => w.branch === compare.symbol)?.path ?? null
  }
  return out
}

/** @param {string} repo @param {RefSide} side @param {string | null} workdir */
async function describeSide(repo, side, workdir) {
  if (side.kind === 'empty') return 'empty tree — every file is shown as added'
  if (side.kind === 'worktree') return `working tree at ${side.path}, HEAD detached — follows your edits`
  if (side.kind === 'branch') {
    const tip = await commitOf(repo, side.symbol)
    if (!tip) return `${side.symbol} — branch missing`
    return `branch tip ${short(tip)}, follows new commits${workdir ? ' and uncommitted changes' : ''}`
  }
  const subject = (await tryGit(repo, ['log', '-1', '--format=%s', side.anchorSha]))?.trim()
  return subject == null ? `${short(side.anchorSha)} — commit missing` : `fixed commit ${short(side.anchorSha)} "${subject}"`
}

// ── "since" marks ────────────────────────────────────────────
/** Diff from an earlier commit to the surface under review.
 *  @param {string} repo @param {string | null} workdir @param {boolean} dirty @param {string} from @param {string} head @param {string[]} [extra] */
const diffSince = (repo, workdir, dirty, from, head, extra = /** @type {string[]} */ ([])) => (workdir && dirty ? diffWorktree(workdir, from, extra) : diffTrees(repo, from, head, extra))

/** Attach the real since-diff hunks to each file and flag the lines they touch.
 *  Added lines join on new-line number (both diffs end at the same surface);
 *  removed lines are matched by text.
 *  @param {FileDiff[]} files @param {FileDiff[]} since @param {'since' | 'sinceViewed'} flag @param {Set<string>} [only] */
function markSince(files, since, flag, only) {
  const by = new Map(since.map((f) => [f.path, f]))
  for (const f of files) {
    if (only && !only.has(f.path)) continue
    const sf = by.get(f.path)
    if (!sf) continue
    f[flag === 'since' ? 'sinceHunks' : 'sinceViewedHunks'] = sf.hunks
    const adds = new Set(); const dels = new Set()
    for (const h of sf.hunks) for (const l of h.lines) { if (l.kind === 'add') adds.add(l.new); else if (l.kind === 'del') dels.add(l.text) }
    for (const h of f.hunks) for (const l of h.lines) {
      if ((l.kind === 'add' && adds.has(l.new)) || (l.kind === 'del' && dels.has(l.text))) l[flag] = true
    }
  }
}

// ── anchors ──────────────────────────────────────────────────
const squash = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim()
/** Lines of one side of a file, in order. @param {FileDiff} f @param {'new' | 'old'} side */
function sideLines(f, side) {
  /** @type {{ no: number, text: string, range: string }[]} */
  const out = []
  for (const h of f.hunks) for (const l of h.lines) {
    const no = side === 'new' ? l.new : l.old
    if (no != null) out.push({ no, text: l.text, range: h.range })
  }
  return out
}
/** @param {number[]} nums */
function ranges(nums) {
  const s = [...new Set(nums)].sort((a, b) => a - b); const out = []
  for (let i = 0; i < s.length; i++) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j
  }
  return out.join(', ') || '(none)'
}
/** @param {FileDiff[]} files @param {string} file */
function findFile(files, file) {
  const f = files.find((x) => x.path === file) ?? files.find((x) => x.oldPath === file)
  if (f) return f
  const base = path.basename(String(file))
  const near = files.filter((x) => path.basename(x.path) === base).map((x) => x.path)
  throw new Error(`${file} is not part of this diff.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} Files in the diff: ${files.map((x) => x.path).join(', ') || '(none)'}`)
}

/** Reads one side of a changed file in full: `new` as the compare side has it
 *  (working tree included), `old` at the diff base. Cached per call site.
 *  @param {string} repo @param {LoadedReview} loaded */
export function sideReader(repo, loaded) {
  /** @type {Map<string, Promise<string[] | null>>} */
  const cache = new Map()
  /** @param {FileDiff} f @param {'new' | 'old'} side */
  return (f, side) => {
    const key = `${f.path}\0${side}`
    if (!cache.has(key)) {
      const text = side === 'old'
        ? (f.status === 'added' ? Promise.resolve(null) : tryGit(repo, ['show', `${loaded.diffBase}:${f.oldPath ?? f.path}`]))
        : (f.status === 'deleted' ? Promise.resolve(null) : readAt(repo, loaded.apply.workdir, loaded.headSha, f.path))
      cache.set(key, text.then((t) => { if (t == null) return null; const l = t.split('\n'); if (l.at(-1) === '') l.pop(); return l }))
    }
    return /** @type {Promise<string[] | null>} */ (cache.get(key))
  }
}

/** Build a full anchor from what a caller named. The line text and context are
 *  copied from git. Any line of a changed file can be anchored — inside the diff's
 *  hunks or outside them (unchanged context); a file that did not change, a line
 *  that does not exist, or a failed `expect` is refused, never guessed.
 *  @param {LoadedReview} loaded @param {any} input @param {ReturnType<typeof sideReader>} [read] @returns {Promise<CommentAnchor>} */
export async function makeAnchor(loaded, input, read) {
  const w = loaded.state.walkthrough
  switch (input?.kind) {
    case 'diff': {
      const f = findFile(loaded.files, input.file)
      if (f.binary) throw new Error(`${f.path} is binary: there are no lines to anchor to. Anchor to the file instead.`)
      const side = input.side === 'old' ? 'old' : 'new'
      const n = Number(input.line)
      if (!Number.isInteger(n) || n < 1) throw new Error(`line must be a positive integer, got ${input.line}`)
      const lines = sideLines(f, side)
      const i = lines.findIndex((l) => l.no === n)
      if (i < 0) {
        // not in a hunk: an unchanged line of this changed file, read from git
        const full = read ? await read(f, side) : null
        if (!full) throw new Error(`${f.path} has no ${side} side (${f.status}). ${side === 'new' ? 'Use --side old for a removed line.' : 'Use the new side.'}`)
        if (n > full.length) throw new Error(`${f.path} has ${full.length} lines on the ${side} side; line ${n} does not exist. Lines inside the diff: ${ranges(lines.map((l) => l.no))}.`)
        if (input.expect && !full[n - 1].includes(input.expect)) throw new Error(`${f.path}:${n} (${side}) reads ${JSON.stringify(full[n - 1])}, which does not contain the expected text ${JSON.stringify(input.expect)}. Re-read the file.`)
        return { kind: 'diff', file: f.path, side, line: n, hunkRange: '', lineContent: full[n - 1], before: full.slice(Math.max(0, n - 3), n - 1), after: full.slice(n, n + 2), outside: true }
      }
      if (input.expect && !lines[i].text.includes(input.expect)) throw new Error(`${f.path}:${n} (${side}) reads ${JSON.stringify(lines[i].text)}, which does not contain the expected text ${JSON.stringify(input.expect)}. Re-read the diff.`)
      return {
        kind: 'diff', file: f.path, side, line: n, hunkRange: lines[i].range, lineContent: lines[i].text,
        before: lines.slice(Math.max(0, i - 2), i).map((l) => l.text), after: lines.slice(i + 1, i + 3).map((l) => l.text)
      }
    }
    case 'file': return { kind: 'file', file: findFile(loaded.files, input.file).path }
    case 'artifact': {
      const art = loaded.artifacts.find((a) => a.path === input.path)
      if (!art) throw new Error(`no spec/plan file ${input.path}. Known: ${loaded.artifacts.map((a) => `${a.path} (${a.role})`).join(', ') || '(none)'}`)
      const n = Number(input.line)
      if (!Number.isInteger(n) || n < 1 || n > art.lines.length) throw new Error(`${art.path} has ${art.lines.length} lines; line ${input.line} is out of range`)
      if (input.expect && !art.lines[n - 1].includes(input.expect)) throw new Error(`${art.path}:${n} reads ${JSON.stringify(art.lines[n - 1])}, which does not contain ${JSON.stringify(input.expect)}`)
      return { kind: 'artifact', path: art.path, line: n, lineContent: art.lines[n - 1] }
    }
    case 'section':
      if (!w?.sections.some((s) => s.id === input.sectionId)) throw new Error(`no section ${input.sectionId}. Sections: ${(w?.sections ?? []).map((s) => `${s.id} (${s.name})`).join(', ') || '(no walkthrough yet)'}`)
      return { kind: 'section', sectionId: input.sectionId }
    case 'question':
      if (!w?.questions.some((q) => q.id === input.questionId)) throw new Error(`no question ${input.questionId}. Questions: ${(w?.questions ?? []).map((q) => q.id).join(', ') || '(none)'}`)
      return { kind: 'question', questionId: input.questionId }
    case 'plan-step': return { kind: 'plan-step', stepN: Number(input.stepN) }
    case 'acceptance': return { kind: 'acceptance', index: Number(input.index) }
    case 'deviation': return { kind: 'deviation', index: Number(input.index) }
    case 'summary': return { kind: 'summary' }
    case 'title': return { kind: 'title' }
    default: throw new Error(`unknown anchor kind: ${JSON.stringify(input?.kind)}`)
  }
}
/** @param {LoadedReview} loaded @param {any} target @param {ReturnType<typeof sideReader>} [read] @returns {Promise<import('../shared/types.ts').FocusTarget>} */
export async function makeFocus(loaded, target, read) {
  const a = await makeAnchor(loaded, target, read)
  if (a.kind === 'diff') return { kind: 'diff', file: a.file, side: a.side, line: a.line }
  if (a.kind === 'file' || a.kind === 'section' || a.kind === 'summary') return a
  throw new Error('a focus target is a diff line, a file, a section, or the summary')
}

/** How many places a resolution names. A fix that touches more is read as a whole diff,
 *  not chip by chip. */
export const MAX_CHANGED = 20
/** The lines a fix changed, as the session named them, checked the way an anchor is: the
 *  file is part of the diff (a rename by either path), and the lines exist on the compare
 *  side as it is now, uncommitted edits included. Only the file and the line numbers are
 *  taken from the caller; the text of the first line is copied from git.
 *  @param {LoadedReview} loaded @param {any} input @param {ReturnType<typeof sideReader>} read
 *  @returns {Promise<import('../shared/types.ts').ChangedRange[]>} */
export async function makeChanged(loaded, input, read) {
  if (!Array.isArray(input)) throw new Error('changed is a list of { file, start, end }')
  if (input.length > MAX_CHANGED) throw new Error(`a resolution names at most ${MAX_CHANGED} changed ranges, got ${input.length}: merge neighbouring ones, or name the ones that matter`)
  const out = []
  for (const r of input) {
    const start = Number(r?.start); const end = r?.end == null ? start : Number(r.end)
    if (typeof r?.file !== 'string' || !r.file || !Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < 1) throw new Error(`changed ${JSON.stringify(r)}: a range is { file, start, end } with line numbers from 1`)
    const name = `changed ${r.file}:${start}${end === start ? '' : `-${end}`}`
    if (end < start) throw new Error(`${name}: the range ends before it starts`)
    let f
    try { f = findFile(loaded.files, r.file) } catch (err) { throw new Error(`${name}: ${err instanceof Error ? err.message : err}`) }
    if (f.binary) throw new Error(`${name}: ${f.path} is binary: it has no lines`)
    const full = await read(f, 'new')
    if (!full) throw new Error(`${name}: ${f.path} has no lines on the compare side (${f.status})`)
    if (end > full.length) throw new Error(`${name}: ${f.path} has ${full.length} lines on the compare side; line ${start > full.length ? start : end} does not exist`)
    out.push({ file: f.path, start, end, lineContent: full[start - 1] })
  }
  return out
}
/** The same for a fix that was committed and whose lines nobody named: the runs of lines
 *  the commit added (against its first parent) in files that are part of the review. A run
 *  is kept only where the compare side still reads as the commit left it, since a later
 *  commit or an uncommitted edit may have moved the lines. `more`: runs beyond the cap.
 *  @param {string} repo @param {LoadedReview} loaded @param {string} sha @param {ReturnType<typeof sideReader>} read */
export async function changedByCommit(repo, loaded, sha, read) {
  const parent = (await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${sha}^`]))?.trim() || EMPTY_TREE
  /** @type {import('../shared/types.ts').ChangedRange[]} */
  const out = []
  // only the review's files, under both names of a rename: a merge of a large branch is not parsed whole
  const paths = [...new Set(loaded.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))]
  if (!paths.length) return { changed: [], more: 0 }
  for (const cf of await diffTrees(repo, parent, sha, [], paths)) {
    const f = loaded.files.find((x) => x.path === cf.path) ?? loaded.files.find((x) => x.oldPath === cf.path)
    if (!f || f.binary) continue
    const added = new Map(cf.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => [/** @type {number} */ (l.new), l.text])))
    const full = added.size ? await read(f, 'new') : null
    if (!full) continue
    const nums = [...added.keys()].sort((a, b) => a - b)
    for (let i = 0; i < nums.length; i++) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
      if (nums.slice(i, j + 1).every((n) => full[n - 1] === added.get(n))) out.push({ file: f.path, start: nums[i], end: nums[j], lineContent: full[nums[i] - 1] })
      i = j
    }
  }
  return { changed: out.slice(0, MAX_CHANGED), more: Math.max(0, out.length - MAX_CHANGED) }
}

/** Keep comments on the line they were written on as the code moves.
 *  A line is recognised by its exact text (falling back to the same text ignoring
 *  whitespace); identical lines are told apart by their neighbours, then by
 *  distance. A comment whose line no longer exists is never moved to other code:
 *  a queued one becomes `outdated`, any other is flagged `lineGone`.
 *  `full` holds whole-file lines (key `path\\0side`) for comments that are, or may
 *  now be, outside the diff's hunks: a line that is no longer part of a hunk but still
 *  exists in the file stays attached, flagged `outside`.
 *  @param {Comment[]} comments @param {FileDiff[]} files @param {Artifact[]} artifacts @param {Map<string, string[]>} [full] @returns {boolean} changed */
export function reanchor(comments, files, artifacts, full = new Map()) {
  const before = JSON.stringify(comments)
  for (const c of comments) {
    const a = c.anchor
    /** @type {{ no: number, text: string, range: string }[] | null} */
    let lines = null
    if (a.kind === 'diff') {
      const f = files.find((x) => x.path === a.file) ?? files.find((x) => x.oldPath === a.file)
      if (f) {
        a.file = f.path; lines = sideLines(f, a.side)
        const whole = full.get(`${f.path}\0${a.side}`)
        if (whole) {
          // hunk lines first (they carry the hunk header), then every other line of the file
          const inHunk = new Set(lines.map((l) => l.no))
          lines = [...lines, ...whole.map((text, k) => ({ no: k + 1, text, range: '' })).filter((l) => !inHunk.has(l.no))].sort((x, y) => x.no - y.no)
        }
      }
    } else if (a.kind === 'artifact') {
      const art = artifacts.find((x) => x.path === a.path)
      if (art) lines = art.lines.map((text, i) => ({ no: i + 1, text, range: '' }))
    } else continue

    let hits = (lines ?? []).map((l, i) => ({ ...l, i })).filter((l) => l.text === a.lineContent)
    if (!hits.length) hits = (lines ?? []).map((l, i) => ({ ...l, i })).filter((l) => squash(l.text) === squash(a.lineContent) && squash(l.text) !== '')
    if (hits.length && lines) {
      const ctx = (/** @type {number} */ i) => {
        if (a.kind !== 'diff') return 0
        const b = lines.slice(Math.max(0, i - 2), i).map((l) => l.text); const af = lines.slice(i + 1, i + 3).map((l) => l.text)
        return (a.before ?? []).filter((t, k, arr) => b[b.length - arr.length + k] === t).length + (a.after ?? []).filter((t, k) => af[k] === t).length
      }
      const best = hits.sort((x, y) => ctx(y.i) - ctx(x.i) || Math.abs(x.no - a.line) - Math.abs(y.no - a.line))[0]
      a.line = best.no; a.lineContent = best.text
      if (a.kind === 'diff') {
        a.hunkRange = best.range
        const f = files.find((x) => x.path === a.file)
        if (f && sideLines(f, a.side).some((l) => l.no === best.no)) delete a.outside; else a.outside = true
        a.before = lines.slice(Math.max(0, best.i - 2), best.i).map((l) => l.text); a.after = lines.slice(best.i + 1, best.i + 3).map((l) => l.text)
      }
      delete c.lineGone
      if (c.status === 'outdated') c.status = 'queued'
    } else if (c.status === 'queued' || c.status === 'outdated') {
      c.status = 'outdated'; delete c.lineGone
    } else {
      c.lineGone = true
    }
  }
  return JSON.stringify(comments) !== before
}

// ── spec / plan discovery ────────────────────────────────────
/** Path conventions that mark a markdown file as a spec or a plan. */
const ARTIFACT_RULES = /** @type {[RegExp, 'spec' | 'plan'][]} */ ([
  [/(^|\/)specs\/[^/]+\/spec\.md$/i, 'spec'],
  [/(^|\/)specs\/[^/]+\/(plan|tasks)\.md$/i, 'plan'],
  [/(^|\/)docs\/superpowers\/specs\/[^/]+\.md$/i, 'spec'],
  [/(^|\/)docs\/superpowers\/plans\/[^/]+\.md$/i, 'plan'],
  [/(^|\/)docs\/(specs?|rfcs?|design|prd)\/[^/]+\.md$/i, 'spec'],
  [/(^|\/)docs\/plans?\/[^/]+\.md$/i, 'plan'],
  [/(^|\/)\.claude\/plans\/[^/]+\.md$/i, 'plan'],
  [/(^|\/)(spec|prd|design)\.md$/i, 'spec'],
  [/(^|\/)(plan|tasks)\.md$/i, 'plan']
])
/** @param {string} p @returns {'spec' | 'plan' | null} */
export const artifactRole = (p) => ARTIFACT_RULES.find(([re]) => re.test(p))?.[1] ?? null

/** Read a file as the compare side has it: from the working tree when there is one,
 *  else from the compare commit. @param {string} repo @param {string | null} workdir @param {string} head @param {string} rel */
export async function readAt(repo, workdir, head, rel) {
  if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) return null
  if (workdir) {
    try {
      const at = path.join(workdir, rel)
      // a symlink reads as git stores it, the path it points at: following it would show
      // (and let a line anchor copy) a file that may be outside the repository
      return fs.lstatSync(at).isSymbolicLink() ? fs.readlinkSync(at) : fs.readFileSync(at, 'utf8')
    } catch { /* fall through to the commit */ }
  }
  return tryGit(repo, ['show', `${head}:${rel}`])
}
/** Spec/plan files for a comparison: every recognised file the diff touches;
 *  otherwise the one candidate per role, or the one that names the branch.
 *  @param {string} repo @param {string | null} workdir @param {string} head @param {string} branch @param {string[]} changed */
async function detectArtifacts(repo, workdir, head, branch, changed) {
  const tracked = ((await tryGit(repo, ['ls-tree', '-r', '--name-only', '-z', head])) ?? '').split('\0').filter((p) => p.toLowerCase().endsWith('.md'))
  const candidates = [...new Set([...changed.filter((p) => p.toLowerCase().endsWith('.md')), ...tracked])]
    .map((p) => ({ path: p, role: artifactRole(p) })).filter((c) => c.role).slice(0, 400)
  const inDiff = candidates.filter((c) => changed.includes(c.path))
  if (inDiff.length) return inDiff.slice(0, 6)
  const out = []
  const tail = branch.split('/').pop() ?? branch
  for (const role of /** @type {const} */ (['spec', 'plan'])) {
    const of = candidates.filter((c) => c.role === role)
    if (of.length === 1) { out.push(of[0]); continue }
    for (const c of of.slice(0, 40)) {
      const head50 = ((await readAt(repo, workdir, head, c.path)) ?? '').split('\n').slice(0, 50).join('\n')
      if (tail.length > 3 && head50.includes(tail)) { out.push(c); break }
    }
  }
  return out
}

// ── walkthrough reconciliation ───────────────────────────────
/** Check a walkthrough written by Claude Code against the live diff. Git wins:
 *  files that are not in the diff are dropped, a file stays in the first section
 *  that lists it, emptied sections are removed, and changed files nobody placed are
 *  collected into "Other changes" so every change is covered. Untracked files are
 *  optional: unplaced ones stay out.
 *  @param {FileDiff[]} files @param {any} raw @returns {{ walkthrough: Walkthrough, warnings: string[] }} */
export function reconcile(files, raw) {
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  if (!raw || typeof raw !== 'object') throw new Error('a walkthrough is a JSON object with "title", "summary" and "sections"')
  if (!str(raw.title).trim()) throw new Error('the walkthrough needs a "title"')
  if (!Array.isArray(raw.sections) || !raw.sections.length) throw new Error('the walkthrough needs at least one section with "name" and "files"')
  const warnings = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (const f of files) if (f.oldPath) byPath.set(f.oldPath, f)
  const assigned = new Set(); const ids = new Set()
  /** @type {import('../shared/types.ts').Section[]} */
  const sections = []
  raw.sections.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    const name = str(s?.name).trim() || `Section ${i + 1}`
    const list = []
    for (const p of Array.isArray(s?.files) ? s.files.map(str) : []) {
      const f = byPath.get(p)
      if (!f) { warnings.push(`section "${name}" lists ${p}, which is not in the diff — dropped`); continue }
      if (assigned.has(f.path)) { warnings.push(`${f.path} is listed in more than one section — kept in the first`); continue }
      assigned.add(f.path); list.push(f.path)
    }
    if (!list.length) { warnings.push(`section "${name}" has no files from the diff — dropped`); return }
    let id = str(s.id).trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `s${i + 1}`
    while (ids.has(id) || id === 'other-changes') id = `${id}-${i + 1}`
    ids.add(id)
    const diagram = Array.isArray(s.diagram)
      ? s.diagram.map((/** @type {any} */ n) => (Array.isArray(n) ? { label: str(n[0]), kind: n[1], sub: str(n[2]) } : { label: str(n?.label), kind: n?.kind, sub: str(n?.sub) }))
        .filter((/** @type {any} */ n) => n.label).map((/** @type {any} */ n) => ({ ...n, kind: n.kind === 'hi' || n.kind === 'new' ? n.kind : '' })).slice(0, 6)
      : []
    const notes = Array.isArray(s.plainNotes) ? Object.fromEntries(s.plainNotes.map((/** @type {any} */ n) => [str(n?.file), str(n?.note)])) : s.plainNotes && typeof s.plainNotes === 'object' ? s.plainNotes : {}
    const plainNotes = Object.fromEntries(Object.entries(notes).map(([p, n]) => [byPath.get(p)?.path, str(n)]).filter(([p, n]) => p && list.includes(/** @type {string} */ (p)) && n))
    sections.push({
      id, name, desc: str(s.desc), what: str(s.what), files: list, order: Number.isFinite(Number(s.order)) ? Number(s.order) : i + 1,
      ...(diagram.length >= 2 ? { diagram } : {}),
      ...(str(s.insight?.caption) ? { insight: { caption: str(s.insight.caption) } } : {}),
      ...(Object.keys(plainNotes).length ? { plainNotes } : {})
    })
  })
  sections.sort((a, b) => a.order - b.order)
  const strays = files.filter((f) => !f.untracked && !assigned.has(f.path)).map((f) => f.path)
  if (strays.length) {
    if (sections.length) warnings.push(`${strays.length} changed file(s) were not placed in a section — collected under "Other changes": ${strays.join(', ')}`)
    sections.push({ id: 'other-changes', name: 'Other changes', desc: 'Changed files the walkthrough did not place in a section.', what: '', files: strays, order: sections.length + 1 })
  }
  if (!sections.length) throw new Error('no section lists a file from the diff; use the exact paths printed by `gr diff --stat`')
  ids.add('other-changes')
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((/** @type {any} */ q, /** @type {number} */ i) => {
    const options = [...new Set((Array.isArray(q?.options) ? q.options : []).map(str).map((/** @type {string} */ o) => o.trim()).filter(Boolean))].slice(0, 4)
    return { id: str(q?.id).trim() || `q${i + 1}`, text: str(q?.text), ...(str(q?.context) ? { context: str(q.context) } : {}), ...(options.length ? { options } : {}) }
  }).filter((/** @type {any} */ q) => q.text)
  const pm = raw.planMap && typeof raw.planMap === 'object' ? raw.planMap : null
  const sid = (/** @type {unknown} */ v) => (ids.has(str(v)) ? str(v) : '')
  const planMap = pm ? {
    acceptance: (Array.isArray(pm.acceptance) ? pm.acceptance : []).map((/** @type {any} */ a) => ({ text: str(a?.text), met: a?.met === 'partial' ? /** @type {const} */ ('partial') : a?.met === true })).filter((/** @type {any} */ a) => a.text),
    steps: (Array.isArray(pm.steps) ? pm.steps : []).map((/** @type {any} */ st, /** @type {number} */ i) => ({ n: Number(st?.n) || i + 1, text: str(st?.text), sectionId: sid(st?.sectionId), status: ['done', 'changed', 'missing'].includes(st?.status) ? st.status : 'missing' })).filter((/** @type {any} */ st) => st.text),
    deviations: (Array.isArray(pm.deviations) ? pm.deviations : []).map((/** @type {any} */ d) => ({ text: str(d?.text), sectionId: sid(d?.sectionId) })).filter((/** @type {any} */ d) => d.text)
  } : undefined
  return { walkthrough: { title: str(raw.title).trim(), summary: str(raw.summary), sections, questions, ...(planMap ? { planMap } : {}) }, warnings }
}

// ── visual: the whole change as diagrams ─────────────────────
/** How much one visual holds. More than this cannot be read as a picture. */
export const VISUAL_MAX = { views: 6, nodes: 40, edges: 80, warnings: 40 }
const VISUAL_KINDS = /** @type {Record<string, import('../shared/types.ts').VisualKind>} */ ({
  architecture: 'architecture', components: 'architecture', modules: 'architecture',
  flow: 'flow', data: 'flow', dataflow: 'flow', 'data-flow': 'flow',
  calls: 'calls', callgraph: 'calls', 'call-graph': 'calls', functions: 'calls'
})
const VISUAL_TITLE = { architecture: 'Architecture', flow: 'Data flow', calls: 'Function calls' }
/** Whether lines `start`..`end` of a changed file's new side are touched by the diff:
 *  one of them was added, or lines were removed from between them or from right next to
 *  them. A removal at the edge of a range counts for it: saying "changed" of a function
 *  whose neighbour lost a line is the smaller mistake than saying "unchanged" of one that
 *  lost its own first or last line.
 *  @param {FileDiff} f @param {number} start @param {number} end */
function touched(f, start, end) {
  for (const h of f.hunks) {
    // the new-side line a removed line comes after
    let last = Number(/\+(\d+)/.exec(h.range)?.[1] ?? 1) - 1
    for (const l of h.lines) {
      if (l.new != null) { last = l.new; if (l.kind === 'add' && l.new >= start && l.new <= end) return true }
      else if (l.kind === 'del' && last >= start - 1 && last <= end) return true
    }
  }
  return false
}
/** Check the diagrams a session drew against git, the way a walkthrough is: nothing in
 *  them is taken on trust that git can answer. A node's path has to be a file or a
 *  directory git knows on the compare side (or one the diff removes), spelled as git
 *  spells it, and its lines have to be there; whether the node is new, changed, deleted
 *  or untouched is read from the diff, whatever the session said. What cannot be
 *  confirmed is removed and reported, never guessed.
 *  Only git is asked about a path the diff does not hold: the JSON may come from a session
 *  that has just read somebody else's branch, and a path handed to the file system could
 *  name a link out of the repository, a device or an ignored file.
 *  @param {string} repo @param {LoadedReview} loaded @param {any} raw @param {ReturnType<typeof sideReader>} read */
export async function reconcileVisual(repo, loaded, raw, read) {
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
  const cut = (/** @type {unknown} */ v, /** @type {number} */ n) => { const t = str(v).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
  /** An id, as a node declares it and as an edge refers to it. */
  const idOf = (/** @type {unknown} */ v) => str(v).trim().slice(0, 80)
  /** A line number as written: a whole number, or digits in a string. */
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN)
  if (!raw || typeof raw !== 'object') throw new Error('a visual is a JSON object with "views"')
  if (!Array.isArray(raw.views) || !raw.views.length) throw new Error('the visual needs at least one view with "nodes" and "edges"')
  /** @type {string[]} */
  const warnings = []
  let unsaid = 0
  const warn = (/** @type {string} */ w) => { if (warnings.length < VISUAL_MAX.warnings) warnings.push(w); else unsaid++ }
  // an untracked file left out of the review is not part of the change
  const files = loaded.files.filter((f) => !f.excluded)
  /** What git has at a path in a commit. @type {Map<string, Promise<'file' | 'dir' | null>>} */
  const kinds = new Map()
  const kindAt = (/** @type {string} */ sha, /** @type {string} */ rel) => {
    const key = `${sha}:${rel}`
    if (!kinds.has(key)) kinds.set(key, tryGit(repo, ['cat-file', '-t', key]).then((t) => (t?.trim() === 'tree' ? 'dir' : t?.trim() === 'blob' ? 'file' : null)))
    return /** @type {Promise<'file' | 'dir' | null>} */ (kinds.get(key))
  }
  /** Whether a directory the diff reaches into still holds a file on the compare side:
   *  one the diff leaves there, or one git tracks that the diff neither removes nor moves away.
   *  @param {string} rel @param {FileDiff[]} here */
  const keeps = async (rel, here) => {
    if (here.some((x) => x.status !== 'deleted')) return true
    const gone = new Set(files.flatMap((x) => (x.status === 'deleted' ? [x.path] : x.oldPath ? [x.oldPath] : [])))
    const tracked = ((await tryGit(repo, ['ls-tree', '-r', '--name-only', '-z', loaded.headSha, '--', rel])) ?? '').split('\0').filter(Boolean)
    return tracked.some((p) => !gone.has(p))
  }
  /** The lines a node names, held to the file's length. @param {string} where @param {number | undefined} line @param {number | undefined} end @param {number | null} total */
  const span = (where, line, end, total) => {
    if (line == null) return {}
    if (total == null || !Number.isInteger(line) || line < 1 || line > total) {
      warn(`${where}:${Number.isNaN(line) ? '?' : line} is named, ${total == null ? 'but the file has no lines to name' : `but the file has ${total} lines`} — the line was removed`)
      return {}
    }
    if (end == null || end === line) return { line }
    if (!Number.isInteger(end) || end < line) { warn(`${where}:${line}: the range ends at ${Number.isNaN(end) ? '?' : end}, before it starts — only line ${line} was kept`); return { line } }
    if (end > total) { warn(`${where}:${line}-${end}: the file has ${total} lines — the range was cut to ${line}-${total}`); end = total }
    return end > line ? { line, end } : { line }
  }
  /** The code a node names, as git has it. @param {string} name @param {any} n */
  const place = async (name, n) => {
    // "path:start-end" in one field, or file / line / end apart
    const at = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(str(n?.at).trim())
    const given = str(n?.file).trim() || at?.[1] || ''
    if (!given) return { status: /** @type {const} */ ('none') }
    const rel = given.replace(/\/+$/, '')
    // the path as git spells it: no "." or ".." or empty part, so that one file has one name
    if (!rel || given.length > 1000 || path.isAbsolute(rel) || rel.split('/').some((p) => p === '..' || p === '.' || p === '' || p.toLowerCase() === '.git')) {
      warn(`${name} names ${JSON.stringify(given.slice(0, 200))}, which is not a path of the repository as git spells it — the path was removed`)
      return { status: /** @type {const} */ ('none') }
    }
    const line = n?.line == null ? (at?.[2] ? Number(at[2]) : undefined) : num(n.line)
    const end = n?.end == null ? (at?.[3] ? Number(at[3]) : undefined) : num(n.end)
    const f = files.find((x) => x.path === rel) ?? files.find((x) => x.oldPath === rel)
    if (f) {
      const base = { file: f.path, inDiff: true }
      if (f.status === 'deleted') return { ...base, status: /** @type {const} */ ('deleted') }
      const full = f.binary ? null : await read(f, 'new')
      const lines = span(`${name}: ${f.path}`, line, end, full ? full.length : null)
      if (lines.line == null) return { ...base, status: f.status === 'added' ? /** @type {const} */ ('new') : /** @type {const} */ ('changed') }
      return { ...base, ...lines, status: f.status === 'added' ? /** @type {const} */ ('new') : touched(f, lines.line, lines.end ?? lines.line) ? /** @type {const} */ ('changed') : /** @type {const} */ ('unchanged') }
    }
    // not a changed file: a directory (judged by the changed files in it and the ones the
    // change took out of it), or something the change does not touch
    const here = files.filter((x) => x.path.startsWith(`${rel}/`))
    const left = files.filter((x) => x.oldPath?.startsWith(`${rel}/`) && !x.path.startsWith(`${rel}/`))
    const kind = await kindAt(loaded.headSha, rel)
    if ((here.length || left.length) && kind !== 'file') {
      const existed = (await kindAt(loaded.diffBase, rel)) === 'dir'
      const status = !(await keeps(rel, here)) ? /** @type {const} */ ('deleted') : existed ? /** @type {const} */ ('changed') : /** @type {const} */ ('new')
      return { file: `${rel}/`, ...(here.length ? { inDiff: true } : {}), status }
    }
    if (!kind) {
      warn(`${name} names ${rel}, which git does not have on the compare side — the path was removed`)
      return { status: /** @type {const} */ ('none') }
    }
    if (kind === 'dir') return { file: `${rel}/`, status: /** @type {const} */ ('unchanged') }
    // untouched, so the commit has it exactly as the compare side does
    const text = line == null ? null : await tryGit(repo, ['show', `${loaded.headSha}:${rel}`])
    const total = text == null ? null : text.split('\n').length - (text.endsWith('\n') || text === '' ? 1 : 0)
    return { file: rel, ...span(`${name}: ${rel}`, line, end, total), status: /** @type {const} */ ('unchanged') }
  }

  if (raw.views.length > VISUAL_MAX.views) warn(`${raw.views.length} views given; a visual holds ${VISUAL_MAX.views} — the rest were dropped`)
  /** @type {import('../shared/types.ts').VisualView[]} */
  const views = []
  const viewIds = new Set()
  for (const [vi, v] of raw.views.slice(0, VISUAL_MAX.views).entries()) {
    const asked = str(v?.kind).trim().toLowerCase()
    const kind = Object.hasOwn(VISUAL_KINDS, asked) ? VISUAL_KINDS[asked] : undefined
    if (!kind) warn(`view ${vi + 1} has kind ${JSON.stringify(cut(v?.kind, 40) || null)}; it is shown as "architecture" (kinds: architecture, flow, calls)`)
    const title = cut(v?.title, 80) || VISUAL_TITLE[kind ?? 'architecture']
    const rawNodes = Array.isArray(v?.nodes) ? v.nodes : []
    /** @type {import('../shared/types.ts').VisualNode[]} */
    const nodes = []
    const ids = new Set()
    // ids the session chose are taken first, so that a made-up one never collides with them
    for (const n of rawNodes) if (idOf(n?.id)) ids.add(idOf(n.id))
    const taken = new Set()
    let auto = 0
    for (const [ni, n] of rawNodes.entries()) {
      if (nodes.length === VISUAL_MAX.nodes) { warn(`view "${title}" has more than ${VISUAL_MAX.nodes} nodes; a view holds ${VISUAL_MAX.nodes} — the rest were dropped`); break }
      const label = cut(n?.label, 60)
      if (!label) { warn(`view "${title}": node ${ni + 1} has no label — dropped`); continue }
      let id = idOf(n?.id)
      if (!id) { do id = `n${++auto}`; while (ids.has(id)); ids.add(id) }
      if (taken.has(id)) { warn(`view "${title}": two nodes have the id ${JSON.stringify(id)} — the second was dropped`); continue }
      taken.add(id)
      const sub = cut(n?.sub, 90); const group = cut(n?.group, 40)
      nodes.push({ id, label, ...(sub ? { sub } : {}), ...(group ? { group } : {}), ...(await place(`view "${title}": node "${label}"`, n)) })
    }
    if (nodes.length < 2) { warn(`view "${title}" has fewer than two nodes — dropped`); continue }
    /** @type {import('../shared/types.ts').VisualEdge[]} */
    const edges = []
    const seen = new Set()
    for (const e of Array.isArray(v?.edges) ? v.edges : []) {
      if (edges.length === VISUAL_MAX.edges) { warn(`view "${title}" has more than ${VISUAL_MAX.edges} edges; a view holds ${VISUAL_MAX.edges} — the rest were dropped`); break }
      const [from, to, label] = Array.isArray(e) ? [idOf(e[0]), idOf(e[1]), cut(e[2], 40)] : [idOf(e?.from), idOf(e?.to), cut(e?.label, 40)]
      if (!taken.has(from) || !taken.has(to)) { warn(`view "${title}": an edge joins ${JSON.stringify(from)} and ${JSON.stringify(to)}, and ${JSON.stringify(taken.has(from) ? to : from)} is not a node of this view — dropped`); continue }
      if (from === to) { warn(`view "${title}": an edge joins ${JSON.stringify(from)} to itself — dropped`); continue }
      if (seen.has(`${from}\0${to}`)) { warn(`view "${title}": ${JSON.stringify(from)} → ${JSON.stringify(to)} is given twice — the second was dropped`); continue }
      seen.add(`${from}\0${to}`)
      const k = Array.isArray(e) ? e[3] : e?.kind
      edges.push({ from, to, ...(label ? { label } : {}), kind: k === 'new' || k === 'removed' ? k : '' })
    }
    let id = idOf(v?.id) || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `v${vi + 1}`
    while (viewIds.has(id)) id = `${id}-${vi + 1}`
    viewIds.add(id)
    views.push({ id, kind: kind ?? 'architecture', title, caption: str(v?.caption).trim().slice(0, 600), nodes, edges })
  }
  if (!views.length) throw new Error('no view has two nodes or more; a view is { "kind", "title", "nodes": [{ "id", "label", "at": "path:start-end" }], "edges": [{ "from", "to" }] }')
  if (unsaid) warnings.push(`…and ${unsaid} more correction(s) of the same kinds`)
  return { visual: { title: cut(raw.title, 120), summary: str(raw.summary).trim().slice(0, 1200), views }, warnings }
}

// ── assembly ─────────────────────────────────────────────────
/** Paths named by `git status --porcelain -z` entries ("XY path", renames are followed
 *  by their original path as a separate entry). @param {string[]} entries */
function statusPaths(entries) {
  const out = new Set()
  for (let i = 0; i < entries.length; i++) {
    out.add(entries[i].slice(3))
    if (/[RC]/.test(entries[i].slice(0, 2))) i++
  }
  return out
}
/** What an approval is recorded under: the compare commit, plus — when the working
 *  tree has uncommitted changes that are part of the review — the content of every
 *  such file. Excluded untracked files do not count, so a scratch file cannot undo
 *  an approval.
 *  @param {string} head @param {FileDiff[]} files */
function approvalHash(head, files) {
  const live = files.filter((f) => f.uncommitted && !f.excluded)
  if (!live.length) return head
  const h = createHash('sha256').update(head)
  for (const f of [...live].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`\0${f.path}\0${f.status}\0${f.fileHash ?? 'gone'}`)
  }
  return `${head}+${h.digest('hex').slice(0, 24)}`
}

/** Build the reviewer-facing review for a session. With `persist`, re-anchored
 *  comments, dropped viewed marks and discovered spec/plan files are saved.
 *  @param {import('./store.mjs').Store | null} store @param {Session} session @param {{ persist: boolean, presence?: import('../shared/types.ts').Presence }} opts
 *  @returns {Promise<LoadedReview>} */
export async function assemble(store, session, opts) {
  const { repo, pair, direct } = session
  const view = { ...(opts.view?.ignoreWhitespace ? { ignoreWhitespace: true } : {}), ...(opts.view?.commit ? { commit: String(opts.view.commit) } : {}) }
  // a view never touches what is stored: it works on a copy and saves nothing
  const viewing = Boolean(view.ignoreWhitespace || view.commit)
  const state = viewing ? structuredClone(session.state) : session.state
  const extra = view.ignoreWhitespace ? ['-w'] : []
  const meta = { id: session.id, repo, pair, direct, createdAt: session.createdAt, updatedAt: session.updatedAt, archived: session.archived }
  const now = await resolveNow(repo, pair)
  /** @type {LoadedReview} */
  const loaded = {
    sessionId: session.id, session: meta, baseContext: await describeSide(repo, pair.base, null), compareContext: await describeSide(repo, pair.compare, now.workdir),
    diffBase: '', headSha: now.headSha, files: [], commits: [], dirty: false, signature: '', state, artifacts: [], approved: false, approvalHash: '', walkthroughStale: false, visualStale: false,
    apply: { enabled: false, reason: 'frozen-commit', workdir: null }, presence: opts.presence ?? 'away',
    ...(viewing ? { view } : {})
  }
  if (now.missing) return { ...loaded, refMissing: now.missing }

  const { headSha, workdir } = now
  const diffBase = !now.baseSha ? EMPTY_TREE : direct ? now.baseSha : (await mergeBase(repo, now.baseSha, headSha)) ?? EMPTY_TREE
  const sig = await surfaceSignature(repo, now.headRef, workdir)
  const dirty = sig.dirty
  const commits = await log(repo, diffBase === EMPTY_TREE ? headSha : `${diffBase}..${headSha}`)
  /** Load the attached spec/plan files as the compare side has them. */
  const readArtifacts = async () => {
    for (const ref of state.artifacts) {
      const text = await readAt(repo, workdir, headSha, ref.path)
      if (text == null) continue
      const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop()
      loaded.artifacts.push({ role: ref.role, path: ref.path, title: lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '') ?? path.basename(ref.path), lines })
    }
  }
  if (view.commit) {
    // one commit of the range against its first parent: read-only, no working tree
    const c = commits.find((x) => x.sha === view.commit || x.sha.startsWith(/** @type {string} */ (view.commit)))
    if (!c) throw new Error(`commit ${view.commit} is not part of this comparison`)
    const parent = (await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${c.sha}^`]))?.trim() || EMPTY_TREE
    const only = await diffTrees(repo, parent, c.sha, extra)
    await readArtifacts()
    return {
      ...loaded, view: { ...view, commit: c.sha }, diffBase, files: only, commits, dirty, signature: sig.signature,
      approvalHash: '', apply: { enabled: false, reason: 'frozen-commit', workdir: null }
    }
  }
  const committed = await diffTrees(repo, diffBase, headSha, extra)
  let files = committed
  if (workdir && dirty) {
    files = await diffWorktree(workdir, diffBase, extra)
    await tagOrigins(workdir, files, committed)
  }
  if (workdir && dirty) {
    const touched = statusPaths(await statusEntries(workdir))
    for (const f of files) if (touched.has(f.path)) f.uncommitted = true
  }
  if (workdir) {
    const hashes = await hashFiles(workdir, files.map((f) => f.path))
    for (const f of files) { const h = hashes.get(f.path); if (h) f.fileHash = h }
  }
  // untracked files can be left out of the review: by the reviewer, or because the
  // walkthrough did not place them in a section
  const sectioned = new Set((state.walkthrough?.sections ?? []).flatMap((s) => s.files))
  for (const f of files) {
    if (f.untracked && (state.fileExcluded[f.path] ?? (Boolean(state.walkthrough) && !sectioned.has(f.path)))) f.excluded = true
  }

  // since: the latest approval if there is one, else the last walkthrough
  const aHash = approvalHash(headSha, files)
  loaded.approved = state.approvals.some((a) => a.hash === aHash)
  loaded.approvalHash = aHash
  loaded.walkthroughStale = Boolean(state.walkthrough) && (state.reviewedSignature ? state.reviewedSignature !== sig.signature : state.reviewedAtSha !== headSha)
  // the diff base is part of it: a base branch that moves changes what every box's status should be
  loaded.visualStale = Boolean(state.visual) && state.visual?.signature !== `${diffBase}:${sig.signature}`
  const lastApproval = state.approvals.find((a) => a.sha === headSha) ?? state.approvals.at(-1)
  const baseline = lastApproval?.sha ?? state.reviewedAtSha
  let changed = false
  if (baseline && await commitOf(repo, baseline)) {
    loaded.since = { kind: lastApproval ? 'approved' : 'reviewed', sha: baseline, moved: baseline !== headSha }
    if (baseline !== headSha || dirty) markSince(files, await diffSince(repo, workdir, dirty, baseline, headSha, extra), 'since')
  }
  // viewed: a file is "changed" once its content differs from when it was marked
  const bySha = new Map()
  for (const [p, mark] of Object.entries(state.viewedAt)) bySha.set(mark.sha, (bySha.get(mark.sha) ?? new Set()).add(p))
  for (const [sha, paths] of bySha) {
    if (!(await commitOf(repo, sha))) { for (const p of paths) delete state.viewedAt[p]; changed = true; continue }
    const since = sha !== headSha || dirty ? await diffSince(repo, workdir, dirty, sha, headSha, extra) : []
    const moved = new Set()
    for (const f of files) {
      if (!paths.has(f.path)) continue
      const mark = state.viewedAt[f.path]
      const isChanged = f.fileHash && mark.hash ? f.fileHash !== mark.hash : since.some((s) => s.path === f.path)
      f.viewed = isChanged ? 'changed' : 'viewed'
      if (isChanged) moved.add(f.path)
    }
    markSince(files, since, 'sinceViewed', moved)
  }

  // spec / plan
  if (!state.artifacts.length && !state.artifactsChecked) {
    state.artifactsChecked = true; changed = true
    const found = await detectArtifacts(repo, workdir, headSha, pair.compare.symbol, files.map((f) => f.path))
    if (found.length) { state.artifacts = found.map((a) => ({ role: /** @type {'spec' | 'plan'} */ (a.role), path: a.path })); changed = true }
  }
  await readArtifacts()

  // Comments are re-anchored against the canonical diff only (a whitespace-insensitive
  // view has fewer hunk lines and must not orphan anything). A comment that is, or may
  // now be, outside the hunks is matched against the whole file.
  if (!viewing) {
    const read = sideReader(repo, { ...loaded, diffBase, headSha, apply: { enabled: Boolean(workdir), reason: 'available', workdir } })
    /** @type {Map<string, string[]>} */
    const full = new Map()
    for (const c of state.comments) {
      const a = c.anchor
      if (a.kind !== 'diff') continue
      const f = files.find((x) => x.path === a.file) ?? files.find((x) => x.oldPath === a.file)
      if (!f || f.binary) continue
      if (!a.outside && sideLines(f, a.side).some((l) => l.text === a.lineContent)) continue
      const lines = await read(f, a.side)
      if (lines) full.set(`${f.path}\0${a.side}`, lines)
    }
    if (reanchor(state.comments, files, loaded.artifacts, full)) changed = true
  }
  if (changed && opts.persist && store && !viewing) store.save(session, { touch: false })

  const dirtyCount = workdir && dirty ? (await statusEntries(workdir)).length : 0
  return {
    ...loaded, diffBase, files, dirty, signature: sig.signature, commits,
    compareContext: dirtyCount ? `${loaded.compareContext} · ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}` : loaded.compareContext,
    apply: pair.compare.kind === 'commit' ? { enabled: false, reason: 'frozen-commit', workdir: null }
      : workdir ? { enabled: true, reason: 'available', workdir } : { enabled: false, reason: 'not-checked-out', workdir: null }
  }
}
/** The hash an approval of this surface is recorded under. @param {LoadedReview} loaded */
export const approvalKey = (loaded) => approvalHash(loaded.headSha, loaded.files)

/** Commits and line counts between an earlier commit and the surface now.
 *  @param {Session} session @param {string} sinceSha @returns {Promise<import('../shared/types.ts').DriftSummary>} */
export async function drift(session, sinceSha) {
  const now = await resolveNow(session.repo, session.pair)
  if (now.missing) throw new Error(`the ${now.missing.side} ref ${now.missing.symbol} no longer resolves`)
  assertSafeRef(sinceSha)
  const sig = await surfaceSignature(session.repo, now.headRef, now.workdir)
  const files = (await commitOf(session.repo, sinceSha)) ? await diffSince(session.repo, now.workdir, sig.dirty, sinceSha, now.headSha) : []
  const commits = Number((await tryGit(session.repo, ['rev-list', '--count', `${sinceSha}..${now.headSha}`]))?.trim()) || 0
  return { headSha: now.headSha, commits, files: files.length, add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0), dirty: sig.dirty }
}
/** Cheap approval state for lists (no diff is built): `yes` when the surface as it is
 *  now was approved, `stale` when an approval exists for an earlier state.
 *  @param {Session} session @returns {Promise<'yes' | 'stale' | 'no'>} */
export async function approvedState(session) {
  const approvals = session.state.approvals
  if (!approvals.length) return 'no'
  const sig = await signatureOf(session).catch(() => null)
  if (!sig) return 'stale'
  return approvals.some((a) => a.signature === sig.signature || (!sig.dirty && a.hash === sig.head)) ? 'yes' : 'stale'
}
/** Current fingerprint of a session's surface, for the watcher. @param {Session} session */
export async function signatureOf(session) {
  const now = await resolveNow(session.repo, session.pair)
  if (now.missing) return null
  return surfaceSignature(session.repo, now.headRef, now.workdir)
}
export { git }
