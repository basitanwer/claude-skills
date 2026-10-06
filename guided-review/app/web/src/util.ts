import type {
  AnchorInput, Comment, CommentAnchor, DriftSummary, FileDiff, FocusTarget, Hunk, LoadedReview, RefSide, ReviewRequest, Section
} from '@shared/types'

// ── routing ───────────────────────────────────────────────────
export type Tab = 'conversation' | 'commits' | 'spec' | 'files'
const TABS: Tab[] = ['conversation', 'commits', 'spec', 'files']
export type Route =
  | { name: 'dashboard' }
  | { name: 'hub'; path: string }
  | { name: 'review'; session?: number; repo?: string; base?: string; compare?: string; fresh?: boolean; direct?: boolean; focus?: string; tab?: Tab
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
    const tab = TABS.find((t) => t === sp.get('tab'))
    const w = sp.get('w') === '1' ? true : undefined
    const commit = sp.get('commit') || undefined
    if (sp.get('session') && Number.isFinite(session)) return { name: 'review', session, focus, tab, w, commit }
    if (sp.get('repo')) {
      return {
        name: 'review', repo: sp.get('repo')!, base: sp.get('base') ?? undefined, compare: sp.get('compare') ?? undefined,
        fresh: sp.get('fresh') === '1', direct: sp.get('direct') === '1', focus, tab, w, commit
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
    if (r.tab && r.tab !== 'files') sp.set('tab', r.tab)
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

// ── requests ──────────────────────────────────────────────────
export const isOpen = (r: ReviewRequest): boolean => r.status === 'pending' || r.status === 'running'

export function requestTitle(r: ReviewRequest): string {
  const n = r.commentIds?.length ?? 0
  switch (r.kind) {
    case 'walkthrough': return r.update ? 'Update the walkthrough' : 'Write a walkthrough'
    case 'question': return 'Answer a question'
    case 'apply': return `Address ${plural(n, 'comment')}${r.commit ? ' and commit the edits' : ''}`
    case 'decisions': return `Fold ${plural(n, 'decision')} into the walkthrough`
  }
}
