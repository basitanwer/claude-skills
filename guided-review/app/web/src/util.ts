import type { CSSProperties } from 'react'
import type {
  AnchorInput, Comment, CommentAnchor, DriftSummary, EffortLevel, FileDiff, FocusTarget, Hunk, LoadedReview, Message, RefSide, ReviewRequest, Section, StateMark
} from '@shared/types'

// ── routing ───────────────────────────────────────────────────
/** What the tabs of the page were called, which an address from before the workspace still names (`tab=`). */
type Tab = 'conversation' | 'commits' | 'spec' | 'visual' | 'files'
/** One of the things the reviewer reasons from, shown in the Guide pane beside the code:
 *  the Walkthrough, Visualize, the Conversation, Spec & plan (and, until it goes, Commits).
 *  The address names it as `guide=`. */
export type Guide = 'walkthrough' | 'visual' | 'conversation' | 'spec' | 'commits'
export const GUIDES: Guide[] = ['walkthrough', 'visual', 'conversation', 'spec', 'commits']
/** A pick: the item chosen in a Guide, which the Code pane is narrowed to. It is small
 *  enough for the address to carry, and says where its code is, not what the code was: a
 *  box of a diagram (by diagram and box, so a redrawn diagram is asked again), a section of
 *  the walkthrough (with, perhaps, the one of its files to go to), a folder, or a file
 *  with, perhaps, lines of it. */
export type CodePick =
  | { box: [view: string, node: string] }
  | { section: string; file?: string }
  | { dir: string }
  | { file: string; side?: 'old' | 'new'; line?: number; end?: number }
/** The Guide a pick is of, where its shape says so: a box is the diagram's, a section the walkthrough's. */
export const guideOfPick = (p: CodePick | null): Guide | null => (!p ? null : 'box' in p ? 'visual' : 'section' in p ? 'walkthrough' : null)
/** A pick as text, the same text for the same pick ('' for none): what the address carries. */
export function pickKey(p: CodePick | null): string {
  if (!p) return ''
  if ('box' in p) return JSON.stringify({ box: [p.box[0], p.box[1]] })
  if ('section' in p) return JSON.stringify({ section: p.section, ...(p.file ? { file: p.file } : {}) })
  if ('dir' in p) return JSON.stringify({ dir: p.dir })
  return JSON.stringify({ file: p.file, ...(p.side === 'old' ? { side: 'old' } : {}), ...(p.line != null ? { line: p.line } : {}), ...(p.line != null && p.end != null && p.end > p.line ? { end: p.end } : {}) })
}
/** The pick an address carries, or null when it carries none or one that makes no sense. */
export function parsePick(json: string | undefined): CodePick | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Record<string, unknown>
    if (Array.isArray(p.box) && typeof p.box[0] === 'string' && typeof p.box[1] === 'string') return { box: [p.box[0], p.box[1]] }
    if (typeof p.section === 'string' && p.section) return { section: p.section, ...(typeof p.file === 'string' && p.file ? { file: p.file } : {}) }
    if (typeof p.dir === 'string' && p.dir) return { dir: p.dir }
    if (typeof p.file === 'string' && p.file) {
      const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)
      return { file: p.file, ...(p.side === 'old' ? { side: 'old' as const } : {}), line: n(p.line), end: n(p.end) }
    }
  } catch { /* not JSON */ }
  return null
}
/** What a pick narrows the Code pane to: the files on show, the place in them to go to, and words for it. */
export interface Narrowing { files: string[]; file?: string; side?: 'old' | 'new'; line?: number; end?: number; label: string
  /** the files are shown in this order, not the tree's (a section's files, in the walkthrough's order) */
  ordered?: boolean }
/** A pick's code in the comparison as the page has it, or null: there is no pick, it has
 *  no code (a box that is not code, or that this change does not touch), or what it named
 *  is gone (a diagram drawn anew, a walkthrough written anew, a file that left the
 *  comparison). A section's files are in the walkthrough's order; the place to go to is
 *  the file named with it, else the first of its files not yet viewed. */
export function narrowingOf(pick: CodePick | null, loaded: LoadedReview | null): Narrowing | null {
  if (!pick || !loaded) return null
  const files = loaded.files.filter((f) => !f.excluded)
  if ('section' in pick) {
    const section = loaded.state.walkthrough?.sections.find((s) => s.id === pick.section)
    if (!section) return null
    // (a file the walkthrough names can have left the comparison since it was written)
    const its = section.files.flatMap((p) => files.find((f) => f.path === p || f.oldPath === p) ?? [])
    const at = its.find((f) => f.path === pick.file) ?? its.find((f) => f.viewed !== 'viewed') ?? its[0]
    return { files: its.map((f) => f.path), file: at?.path, label: `“${section.name}” (${plural(its.length, 'file')})`, ordered: true }
  }
  const under = (dir: string): Narrowing | null => {
    const d = dir.endsWith('/') ? dir : `${dir}/`
    const inside = files.filter((f) => f.path.startsWith(d)).map((f) => f.path)
    return inside.length ? { files: inside, label: `${d} (${plural(inside.length, 'file')})` } : null
  }
  const lines = (path: string, side: 'old' | 'new' | undefined, line: number | undefined, end: number | undefined): Narrowing | null => {
    const f = files.find((x) => x.path === path || x.oldPath === path)
    if (!f) return null
    if (line == null || f.binary || (f.status === 'deleted' && side !== 'old')) return { files: [f.path], file: f.path, label: baseName(f.path) }
    const last = end != null && end > line ? end : undefined
    return { files: [f.path], file: f.path, side: side ?? 'new', line, end: last, label: `${baseName(f.path)}, ${last ? `lines ${line}–${last}` : `line ${line}`}${side === 'old' ? ' (old)' : ''}` }
  }
  if ('dir' in pick) return under(pick.dir)
  if ('file' in pick) return lines(pick.file, pick.side, pick.line, pick.end)
  const node = loaded.state.visual?.views.find((v) => v.id === pick.box[0])?.nodes.find((n) => n.id === pick.box[1])
  if (!node?.file || !node.inDiff) return null
  return node.file.endsWith('/') ? under(node.file) : lines(node.file, 'new', node.line ?? undefined, node.end ?? undefined)
}
/** The event the page sends itself (on `window`) when a drag of the divider between the
 *  panes is released: what waits for a pane's width to settle is laid out for it then. */
export const PANES_SETTLED = 'gr-panes-settled'
/** A pane of the workspace that scrolls by itself: the Code pane, or one Guide in the Guide pane. */
export type Pane = 'code' | Guide
export type Route =
  | { name: 'dashboard' }
  | { name: 'hub'; path: string }
  | { name: 'review'; session?: number; repo?: string; base?: string; compare?: string; fresh?: boolean; direct?: boolean; focus?: string
      /** the Guide on show in the Guide pane (none: the pane is closed) */
      guide?: Guide
      /** the pick the Code pane follows (the most recent one), as JSON (see CodePick) */
      pick?: string
      /** beside a Guide: all the files are on show, not only the pick's (or the list of files) */
      all?: boolean
      /** the address itself says where to be (a Guide, a pick, a focus): it is followed,
       *  and the review is not reopened where it was left. Not part of the address. */
      here?: boolean
      /** hide whitespace-only changes */
      w?: boolean
      /** show only this commit of the range */
      commit?: string }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '') || '/'
  const q = h.indexOf('?')
  const p = q < 0 ? h : h.slice(0, q)
  const sp = new URLSearchParams(q < 0 ? '' : h.slice(q + 1))
  if (p === '/repo' && sp.get('path')) return { name: 'hub', path: sp.get('path')! }
  if (p === '/review') {
    const session = Number(sp.get('session'))
    const focus = sp.get('focus') ?? undefined
    // `guide=` names the Guide; an address from before the workspace names it as `tab=`
    // (`tab=files`: the Guide pane closed). Anything else either says is not followed.
    const tab = sp.get('tab') as Tab | null
    const guide = GUIDES.find((g) => g === sp.get('guide')) ?? GUIDES.find((g) => g === tab)
    const pick = pickKey(parsePick(sp.get('pick') ?? undefined)) || undefined
    const all = guide && sp.get('all') === '1' ? true : undefined
    // (`guide=none`: the Guide pane closed, said outright, so that the address of a review
    // with the pane closed opens so anywhere, and not where another browser left it)
    const here = Boolean(guide || pick || focus || tab === 'files' || sp.get('guide') === 'none') || undefined
    const w = sp.get('w') === '1' ? true : undefined
    const commit = sp.get('commit') || undefined
    if (sp.get('session') && Number.isFinite(session)) return { name: 'review', session, focus, guide, pick, all, here, w, commit }
    if (sp.get('repo')) {
      return {
        name: 'review', repo: sp.get('repo')!, base: sp.get('base') ?? undefined, compare: sp.get('compare') ?? undefined,
        fresh: sp.get('fresh') === '1', direct: sp.get('direct') === '1', focus, guide, pick, all, here, w, commit
      }
    }
  }
  return { name: 'dashboard' }
}

export function routeHash(r: Route): string {
  if (r.name === 'hub') return '#/repo?' + new URLSearchParams({ path: r.path }).toString()
  if (r.name === 'review') {
    const sp = new URLSearchParams()
    if (r.session != null) sp.set('session', String(r.session))
    else {
      if (r.repo) sp.set('repo', r.repo)
      if (r.base) sp.set('base', r.base)
      if (r.compare) sp.set('compare', r.compare)
      if (r.fresh) sp.set('fresh', '1')
      if (r.direct) sp.set('direct', '1')
    }
    if (r.guide) sp.set('guide', r.guide)
    else if (r.here) sp.set('guide', 'none')
    if (r.pick) sp.set('pick', r.pick)
    if (r.all && r.guide) sp.set('all', '1')
    if (r.w) sp.set('w', '1')
    if (r.commit) sp.set('commit', r.commit)
    if (r.focus) sp.set('focus', r.focus)
    return '#/review?' + sp.toString()
  }
  return '#/'
}

// ── small formatters ──────────────────────────────────────────
export function ago(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString()
}
export const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7)
/** A ref as the reviewer typed it; a bare full SHA is shortened for display. */
export const symLabel = (symbol: string): string => (/^[0-9a-f]{40}$/.test(symbol) ? symbol.slice(0, 7) : symbol)
export const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
export const newId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
/** Escape a value for use inside a double-quoted CSS attribute selector. */
export const cssq = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
export const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** What to send to the server to name a comparison side again. */
export function refInput(side: RefSide): string {
  if (side.kind === 'empty') return '@empty'
  if (side.kind === 'worktree') return '@worktree'
  return side.kind === 'commit' ? side.anchorSha : side.symbol
}

export const SIDE_KIND: Record<RefSide['kind'], { label: string; title: string }> = {
  branch: { label: 'moving branch', title: 'Follows the branch as it moves, including its working tree when checked out' },
  commit: { label: 'fixed commit', title: 'Frozen at this commit' },
  empty: { label: 'empty tree', title: 'Nothing: everything on the other side is shown as added' },
  worktree: { label: 'working tree', title: 'The working tree of a detached HEAD, uncommitted changes included' }
}

/** "1 new commit · 2 files +3 −1 · uncommitted edits" */
export function driftText(d: DriftSummary | null): string {
  if (!d) return ''
  const parts: string[] = []
  if (d.commits > 0) parts.push(plural(d.commits, 'new commit'))
  if (d.files > 0) parts.push(`${plural(d.files, 'file')} +${d.add} −${d.del}`)
  if (d.dirty) parts.push('uncommitted edits')
  return parts.join(' · ')
}

// ── the rendered diff surface ─────────────────────────────────
export type DiffMode = 'all' | 'since' | 'viewed'
export function hunksForMode(f: FileDiff, mode: DiffMode): Hunk[] {
  // a wholly-new untracked file has no earlier version: its since-diff is its diff
  if (mode === 'since') return f.untracked ? f.hunks : (f.sinceHunks ?? [])
  if (mode === 'viewed') return f.untracked ? f.hunks : (f.sinceViewedHunks ?? [])
  return f.hunks
}

// ── effort levels ─────────────────────────────────────────────
/** Lowest first. The names do not say that each level includes the ones before it, so
 *  wherever a level is shown, what it covers is said with it. */
export const EFFORT_LEVELS: EffortLevel[] = ['read', 'check', 'bugs']
export const EFFORT: Record<EffortLevel, { part: string; covers: string; sum: string; runs: string }> = {
  read: { part: 'Walkthrough', covers: 'the walkthrough only', sum: 'walkthrough only', runs: 'Sonnet' },
  check: { part: 'Fact check', covers: 'the walkthrough and a fact check', sum: 'walkthrough + fact check', runs: 'Sonnet' },
  bugs: { part: 'Bug hunt', covers: 'the walkthrough, a fact check and a bug hunt', sum: 'walkthrough + fact check + bug hunt', runs: "the session's model" }
}
export const effortTitle = (l: EffortLevel): string => `Effort level "${l}": ${EFFORT[l].covers}, on ${EFFORT[l].runs}. Chosen with /guided-review --effort read | check | bugs; each level includes the ones before it.`
/** Whether something recorded at `mark` is about an earlier state of the code than the one shown. */
export const fromEarlier = (mark: StateMark | undefined, loaded: LoadedReview | null): boolean => Boolean(mark && loaded && mark.signature !== loaded.signature)

/** Whether the "since approved / since reviewed" switch has anything to show. */
export function sinceActive(loaded: LoadedReview | null): boolean {
  return Boolean(loaded?.since && (loaded.since.moved || loaded.dirty))
}

export interface Grouping {
  sections: { section: Section; files: FileDiff[] }[]
  /** files in the comparison that no section claims (new since the walkthrough, or no walkthrough yet) */
  loose: FileDiff[]
  /** untracked files left out of the review */
  excluded: FileDiff[]
  narrated: boolean
}

export function groupFiles(loaded: LoadedReview | null): Grouping {
  const files = loaded?.files ?? []
  const wt = loaded?.state.walkthrough
  const excluded = files.filter((f) => f.excluded)
  const kept = files.filter((f) => !f.excluded)
  const byPath = new Map(kept.map((f) => [f.path, f]))
  const sectioned = new Set((wt?.sections ?? []).flatMap((s) => s.files))
  const sections = (wt?.sections ?? []).map((section) => ({
    section, files: section.files.map((p) => byPath.get(p)).filter((f): f is FileDiff => Boolean(f))
  }))
  return { sections, loose: kept.filter((f) => !sectioned.has(f.path)), excluded, narrated: Boolean(wt) }
}

// ── comments ──────────────────────────────────────────────────
/** Where a comment renders: positional anchors key on the exact spot, the rest on
 *  the id or path they reference. */
export function anchorKey(a: CommentAnchor | AnchorInput): string {
  switch (a.kind) {
    case 'diff': return `diff:${a.file}:${a.side ?? 'new'}:${a.line}`
    case 'artifact': return `artifact:${a.path}:${a.line}`
    case 'plan-step': return `plan-step:${a.stepN}`
    case 'section': return `section:${a.sectionId}`
    case 'summary': return 'summary'
    case 'file': return `file:${a.file}`
    case 'question': return `question:${a.questionId}`
    case 'title': return 'title'
    case 'acceptance': return `acceptance:${a.index}`
    case 'deviation': return `deviation:${a.index}`
  }
}

export function anchorLabel(a: CommentAnchor | AnchorInput): string {
  switch (a.kind) {
    case 'diff': return `${a.file}:${a.line}${a.side === 'old' ? ' (old)' : ''}`
    case 'artifact': return `${a.path}:${a.line}`
    case 'plan-step': return `plan step ${a.stepN}`
    case 'section': return `section ${a.sectionId}`
    case 'summary': return 'summary'
    case 'file': return a.file
    case 'question': return `question ${a.questionId}`
    case 'title': return 'title'
    case 'acceptance': return `acceptance criterion ${a.index + 1}`
    case 'deviation': return `deviation ${a.index + 1}`
  }
}

export function targetLabel(t: FocusTarget): string {
  return t.kind === 'diff' ? `${t.file}:${t.line}` : t.kind === 'file' ? t.file : t.kind === 'section' ? `section ${t.sectionId}` : 'summary'
}

/** A walkthrough section's colour, from its position in the walkthrough: sets `--sec` on
 *  an element (and so on everything inside it). Eight colours, then they repeat. */
export const secStyle = (no: number | undefined): CSSProperties | undefined =>
  no == null || no < 0 ? undefined : ({ '--sec': `var(--sec-${(no % 8) + 1})` } as CSSProperties)

/** The part of an anchor the review can scroll to, if any. */
export function focusable(a: CommentAnchor): FocusTarget | null {
  if (a.kind === 'diff') return { kind: 'diff', file: a.file, side: a.side, line: a.line }
  if (a.kind === 'file' || a.kind === 'section' || a.kind === 'summary') return a
  return null
}

/** Comments indexed by where they render. `outdated` comments are left out: they
 *  are listed on their own, never re-attached to a line. */
export function indexComments(comments: Comment[]): Map<string, Comment[]> {
  const out = new Map<string, Comment[]>()
  for (const c of comments) {
    if (c.status === 'outdated') continue
    const k = anchorKey(c.anchor)
    const list = out.get(k)
    if (list) list.push(c)
    else out.set(k, [c])
  }
  return out
}

// ── questions asked from a spot ───────────────────────────────
/** The id prefix of a thread that is a question and its answer, not a comment. */
export const ASK = 'ask:'
/** Questions the reviewer asked about a specific spot ("Ask Claude Code" on a line, a
 *  file, a section), shaped as threads so they show at that spot as well as in the
 *  conversation: the question, then as its replies Claude's answer and every follow-up
 *  asked from the thread with its answer, in order. One thread per first question, at
 *  that question's spot (a follow-up carries the same anchor and must not show twice). */
export function askThreads(messages: Message[]): Comment[] {
  const out = new Map<string, Comment>()
  const threadOf = new Map<string, string>()
  for (const m of messages) {
    if (!m.requestId) continue
    if (m.role === 'agent') { out.get(threadOf.get(m.requestId) ?? '')?.replies.push({ author: 'agent', text: m.text, at: m.at }); continue }
    const root = m.threadId ?? m.requestId
    threadOf.set(m.requestId, root)
    const t = out.get(root)
    if (t) t.replies.push({ author: 'user', text: m.text, at: m.at })
    else if (m.anchor && !m.threadId) out.set(root, { id: ASK + root, anchor: m.anchor, author: 'user', text: m.text, status: 'note', createdAt: m.at, iteration: 0, replies: [] })
  }
  return [...out.values()]
}
/** One question of a Question thread and what came back for it. */
export interface AskExchange { id: string; text: string; at: string; request?: ReviewRequest; answers: Message[] }
/** A Question thread as its exchanges, oldest first: the first question (request `root`)
 *  and every follow-up. A follow-up just sent is known as a request a moment before its
 *  message arrives with the next refresh, so those are included from the request. */
export function askExchanges(root: string, messages: Message[], requests: ReviewRequest[]): AskExchange[] {
  const mine = requests.filter((r) => r.kind === 'question' && (r.threadId ?? r.id) === root)
  const asked = messages.filter((m) => m.role === 'user' && m.requestId && (m.threadId ?? m.requestId) === root)
  const out: AskExchange[] = asked.map((m) => ({ id: m.requestId!, text: m.text, at: m.at, request: mine.find((r) => r.id === m.requestId), answers: messages.filter((a) => a.role === 'agent' && a.requestId === m.requestId) }))
  for (const r of mine) if (!out.some((x) => x.id === r.id)) out.push({ id: r.id, text: r.text ?? '', at: r.createdAt, request: r, answers: [] })
  return out
}
/** Where an exchange stands: answered, or what became of its request. */
export const askStatus = (x: AskExchange): 'answered' | ReviewRequest['status'] | 'unknown' => (x.answers.length ? 'answered' : x.request?.status ?? 'unknown')

// ── requests ──────────────────────────────────────────────────
export const isOpen = (r: ReviewRequest): boolean => r.status === 'pending' || r.status === 'running'

export function requestTitle(r: ReviewRequest): string {
  const n = r.commentIds?.length ?? 0
  switch (r.kind) {
    case 'walkthrough': return r.update ? 'Update the walkthrough' : 'Write a walkthrough'
    case 'question': return 'Answer a question'
    case 'apply': {
      const replies = r.replyIds?.length ?? 0
      const fresh = n - replies
      const what = [fresh ? plural(fresh, 'comment') : '', replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''].filter(Boolean).join(' and ')
      return `${r.editable === false ? 'Answer' : 'Address'} ${what || plural(n, 'comment')}${r.commit ? ' and commit the edits' : ''}`
    }
    case 'decisions': return `Fold ${plural(n, 'decision')} into the walkthrough`
    case 'visualize': return r.update ? 'Redraw the diagrams of this change' : 'Draw this change as diagrams'
  }
}

// ── pending comments and replies ──────────────────────────────
/** The reviewer replied in this thread and has not sent the reply to Claude Code yet. */
export const hasPendingReply = (c: Comment): boolean => c.replies.some((r) => r.pending)
/** What "send to Claude Code" will hand over: new comments, and threads with a new
 *  reply. Answers to the walkthrough's questions travel separately (as decisions). */
export function pendingThreads(comments: Comment[]): { queued: Comment[]; replied: Comment[]; all: Comment[] } {
  const queued = comments.filter((c) => c.status === 'queued' && c.anchor.kind !== 'question')
  const replied = comments.filter((c) => !queued.includes(c) && hasPendingReply(c))
  return { queued, replied, all: [...queued, ...replied] }
}
/** "2 pending comments and replies" / "1 pending comment" / "3 pending replies" */
export function pendingLabel(queued: number, replied: number): string {
  const n = queued + replied
  if (queued && replied) return `${n} pending comments and replies`
  if (replied) return `${n} pending ${replied === 1 ? 'reply' : 'replies'}`
  return `${n} pending comment${queued === 1 ? '' : 's'}`
}

// ── how long a request has been running ───────────────────────
/** "45s", "2m 10s", "1h 03m" */
export function elapsed(sinceIso: string | undefined, now = Date.now()): string {
  const t = sinceIso ? Date.parse(sinceIso) : NaN
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
/** How long a running request may go without a progress line before the page offers
 *  "Send again". With a session attached, five minutes: silence may only mean a long
 *  job. With none reachable (`away`), half a minute: nobody is there to finish it. For
 *  testing, both can be set, in seconds, with `window.__grStuckSeconds = 10` in the
 *  console or `?stuck=10` in the page URL (before the `#`). */
export function stuckAfterMs(away = false): number {
  const w = (window as unknown as { __grStuckSeconds?: number }).__grStuckSeconds
  const q = Number(new URLSearchParams(window.location.search).get('stuck'))
  const s = typeof w === 'number' && w > 0 ? w : q > 0 ? q : away ? 30 : 300
  return s * 1000
}
/** When the session holding a request last showed it is on it: its latest progress line,
 *  but never earlier than when it claimed the request (a line from before that, such as
 *  "Sent again by the reviewer", is not its doing). */
const lastSign = (r: ReviewRequest): number => Math.max(Date.parse(r.startedAt ?? r.createdAt), Date.parse(r.progress.at(-1)?.at ?? r.startedAt ?? r.createdAt))
/** Why a claimed request looks dropped, if it does. `away`: no Claude Code session is
 *  reachable, so the one that took it is gone (closed terminal, crashed). `silent`: a
 *  session is attached but has reported nothing on it for a long time. Either way the
 *  reviewer can put it back in the queue; they are different claims and read differently. */
export function stuckReason(r: ReviewRequest, away: boolean, now = Date.now()): 'away' | 'silent' | null {
  if (r.status !== 'running' || !r.startedAt) return null
  const limit = stuckAfterMs(away)
  const last = lastSign(r)
  return now - Date.parse(r.startedAt) >= limit && now - last >= limit ? (away ? 'away' : 'silent') : null
}
/** The label and its tooltip for a request that looks dropped. */
export function stuckText(r: ReviewRequest, why: 'away' | 'silent', now = Date.now()): { label: string; title: string } {
  if (why === 'away') return { label: 'Claude Code may not be listening', title: 'A session picked this up, but no Claude Code session is reachable now: it may have closed. Send it again and the next session that listens takes it.' }
  const quiet = elapsed(new Date(lastSign(r)).toISOString(), now).replace(/ \d+s$/, '')
  return { label: `No progress for ${quiet}`, title: 'A Claude Code session is attached but has reported nothing on this for a while. It may still be working; if it is not, send it again.' }
}
/** A request nobody has picked up for half a minute while no session is attached. */
export const isUnclaimed = (r: ReviewRequest, away: boolean, now = Date.now()): boolean =>
  r.status === 'pending' && away && now - Date.parse(r.createdAt) >= 30_000
