import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import type {
  AnchorInput, Artifact, Comment, FileDiff, LoadedReview, Message, PlanMap, RefSide, ReviewRequest, Section, TourStop, UiAction
} from '@shared/types'
import { useStore, treeWidthLimits, type Filters } from '../store'
import { focusAnchor, focusQuestion, followFiles, goToSection, showSection, startTour } from '../focus'
import {
  ago, anchorKey, anchorLabel, askThreads, baseName, driftText, elapsed, focusable, hasPendingReply, indexComments, isOpen, isUnclaimed, pendingLabel,
  pendingThreads, plural, requestTitle, routeHash, secStyle, short, SIDE_KIND,
  sinceActive, stuckReason, stuckText, symLabel, targetLabel, type DiffMode, type Tab
} from '../util'
import { AwayHint, CopyButton, DiffStat, FileIcon, Icon, Md, Menu, MenuItem, PresenceDot, currentTheme, setTheme } from '../components/common'
import { CommentButton, CommentSlot, CommentsCtx, Composer, STATUS, Thread, Who, useCommentsAt } from '../components/comments'
import { FileBox, hoveredLine } from '../components/diff'
import { VisualTab } from '../components/visual'
import { TopBar } from './Home'

function useTick(ms: number): void {
  const [, bump] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => bump((n) => n + 1), ms)
    return () => window.clearInterval(t)
  }, [ms])
}
function useWide(px: number): boolean {
  const q = `(min-width: ${px}px)`
  const [wide, setWide] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = (): void => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [q])
  return wide
}

// ── header ────────────────────────────────────────────────────
function RefChip({ side, sha }: { side: RefSide; sha?: string }) {
  const kind = SIDE_KIND[side.kind]
  return <span className="ref-chip mono" title={`${kind.label}: ${kind.title}${sha ? ` · now at ${short(sha)}` : ''}`}>{symLabel(side.symbol)}</span>
}

function reviewState(loaded: LoadedReview, saved: boolean): { cls: string; text: string } {
  if (!saved) return { cls: 'draft', text: 'Draft' }
  if (loaded.approved) return { cls: 'approved', text: 'Approved' }
  if (loaded.state.approvals.length > 0) return { cls: 'changed', text: 'Changes since approval' }
  return { cls: 'open', text: 'Open' }
}

function PageHeader({ loaded }: { loaded: LoadedReview }) {
  const saved = useStore((s) => s.sessionId != null)
  const retarget = useStore((s) => s.retarget)
  const [ref, setRef] = useState('')
  const { pair } = loaded.session
  const wt = loaded.state.walkthrough
  const st = reviewState(loaded, saved)
  const title = wt?.title || `${symLabel(pair.compare.symbol)} against ${symLabel(pair.base.symbol)}`
  return (
    <div className="pr-head">
      <div className="pr-title-row">
        <h1 data-gr="title">{title}{saved && <span className="pr-num"> #{loaded.sessionId}</span>}</h1>
        <CommentButton k="title" title="Comment on the title" />
        <span className="grow" />
        <PresenceDot presence={loaded.presence} />
      </div>
      <div className="pr-meta">
        <span className={'state ' + st.cls} data-gr="state" data-gr-state={st.cls}><Icon name={st.cls === 'approved' ? 'check' : 'pr'} />{st.text}</span>
        <span className="pr-compare">
          Comparing <RefChip side={pair.base} /> ← <RefChip side={pair.compare} sha={loaded.headSha} />
          <CopyButton text={pair.compare.kind === 'commit' ? pair.compare.anchorSha : pair.compare.symbol} title="Copy the compare ref" />
          <span className="muted">· {plural(loaded.commits.length, 'commit')}</span>
          {loaded.session.direct && <span className="label" title="The two endpoints are compared as they are, not from their merge-base">endpoints</span>}
          {loaded.dirty && <span className="label warn" title="The working tree has uncommitted changes; they are part of this review">uncommitted changes</span>}
        </span>
      </div>
      <CommentSlot anchor={{ kind: 'title' }} k="title" />
      {loaded.refMissing && (
        <div className="flash-banner bad" data-gr="ref-missing">
          <span className="grow">The {loaded.refMissing.side} ref <span className="mono">{loaded.refMissing.symbol}</span> no longer resolves.</span>
          {loaded.refMissing.side === 'compare' && saved && (
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); void retarget(ref) }}>
              <input name="gr-field" className="mono" value={ref} placeholder="another branch or commit" onChange={(e) => setRef(e.target.value)} aria-label="New compare ref" />
              <button className="btn sm" type="submit" disabled={!ref.trim()}>Re-target</button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

function DriftBanner() {
  const drift = useStore((s) => s.drift)
  const reload = useStore((s) => s.reload)
  if (!drift) return null
  const text = driftText(drift.summary)
  return (
    <div className="flash-banner info" data-gr="drift">
      <span className="grow">This comparison changed since you loaded it{text ? ` — ${text}` : ''}.</span>
      <button className="btn sm" onClick={() => void reload()}>Refresh</button>
    </div>
  )
}

/** What Claude Code has been asked and has not finished: one compact row each, on every tab. */
function RequestsStrip({ loaded }: { loaded: LoadedReview }) {
  useTick(loaded.state.requests.some(isOpen) ? 1000 : 30_000)
  const dismissed = useStore((s) => s.dismissed)
  const { cancelRequest, dismissRequest, retryRequest, setTab } = useStore.getState()
  const away = loaded.presence === 'away'
  const rows = loaded.state.requests.filter((r) => isOpen(r) || (r.status === 'failed' && !dismissed.includes(r.id) && Date.now() - Date.parse(r.finishedAt ?? r.createdAt) < 600_000))
  // Everything that sticks below the strip (toolbar, file headers, tree, section panel)
  // is offset by its height, which varies: rows stack, and wrap on a narrow window.
  const strip = useRef<HTMLDivElement>(null)
  const shown = rows.length > 0
  useLayoutEffect(() => {
    const el = strip.current
    const page = el?.parentElement
    if (!el || !page) return
    const measure = (): void => page.style.setProperty('--strip-h', `${el.offsetHeight}px`)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect(); page.style.removeProperty('--strip-h') }
  }, [shown])
  if (!shown) return null
  return (
    <div className="req-strip" data-gr="requests" ref={strip}>
      {rows.map((r) => {
        const stuck = stuckReason(r, away)
        const why = stuck && stuckText(r, stuck)
        return (
          <div key={r.id} className={'req-row ' + r.status} data-gr-request={r.id} data-gr-request-kind={r.kind} data-gr-request-status={r.status}>
            {isOpen(r) ? <span className="spinner" /> : <Icon name="x" size={14} />}
            <button className="link strong" onClick={() => setTab(r.kind === 'visualize' ? 'visual' : 'conversation')}>{requestTitle(r)}</button>
            <span className="muted" data-gr="request-state">
              {r.status === 'pending' ? 'waiting for Claude Code' : r.status === 'running' ? `${stuck === 'away' ? 'picked up' : 'working for'} ${elapsed(r.startedAt) || '0s'}${stuck === 'away' ? ' ago' : ''}` : `failed: ${r.error ?? 'no reason given'}`}
            </span>
            {why && <span className="label warn" data-gr="request-stuck" data-gr-stuck={stuck} title={why.title}>{why.label}</span>}
            {isOpen(r) && r.progress.length > 0 && <span className="req-progress" title={r.progress.map((p) => p.text).join('\n')}>{r.progress[r.progress.length - 1].text}</span>}
            <span className="grow" />
            {isUnclaimed(r, away) && <span className="away-hint small" data-gr="request-unclaimed" title="In Claude Code run /guided-review --resume — it will pick this up">nothing is listening — run /guided-review --resume</span>}
            {stuck && <button className="btn sm" data-gr="request-retry" title="Put it back in the queue for the next Claude Code session that listens" onClick={() => void retryRequest(r.id)}>Send again</button>}
            {isOpen(r)
              ? <button className="btn sm" data-gr="request-cancel" onClick={() => void cancelRequest(r.id)}>Cancel</button>
              : <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissRequest(r.id)}><Icon name="x" size={14} /></button>}
          </div>
        )
      })}
    </div>
  )
}

// ── tabs ──────────────────────────────────────────────────────
const generalComment = (c: Comment): boolean => ['summary', 'title', 'section', 'plan-step', 'acceptance', 'deviation'].includes(c.anchor.kind)

function Tabs({ loaded }: { loaded: LoadedReview }) {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const wsOnly = useStore((s) => s.wsOnly)
  const files = [...loaded.files, ...wsOnly.filter((f) => !loaded.files.some((x) => x.path === f.path))].filter((f) => !f.excluded)
  const conv = loaded.state.messages.length + loaded.state.comments.filter(generalComment).length
  const hasSpec = loaded.artifacts.length > 0 || Boolean(loaded.state.walkthrough?.planMap)
  const items: { id: Tab; label: string; icon: string; n: number }[] = [
    { id: 'conversation', label: 'Conversation', icon: 'comment', n: conv },
    { id: 'commits', label: 'Commits', icon: 'commit', n: loaded.commits.length },
    ...(hasSpec ? [{ id: 'spec' as Tab, label: 'Spec & plan', icon: 'book', n: loaded.artifacts.length }] : []),
    { id: 'visual', label: 'Visualize', icon: 'graph', n: loaded.state.visual?.views.length ?? 0 },
    { id: 'files', label: 'Files changed', icon: 'file', n: files.length }
  ]
  return (
    <div className="tabs-row">
      <nav className="tabs" role="tablist" aria-label="Review">
        {items.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={'tab' + (tab === t.id ? ' on' : '')} data-gr-tab={t.id} onClick={() => { useStore.getState().set({ returnTo: null }); setTab(t.id) }}>
            <Icon name={t.icon} />{t.label}<span className="counter">{t.n}</span>
          </button>
        ))}
      </nav>
      <span className="grow" />
      <DiffStat add={files.reduce((a, f) => a + f.add, 0)} del={files.reduce((a, f) => a + f.del, 0)} />
    </div>
  )
}

// ── Review ▾ (GitHub's "Submit review") ───────────────────────
function ReviewMenu({ loaded }: { loaded: LoadedReview }) {
  const drift = useStore((s) => s.drift)
  const { request, toggleApprove } = useStore.getState()
  const { queued, replied, all: pending } = pendingThreads(loaded.state.comments)
  const what = pendingLabel(queued.length, replied.length)
  const editable = loaded.apply.enabled
  const [choice, setChoice] = useState<'send' | 'approve'>('send')
  const [note, setNote] = useState('')
  const [commit, setCommit] = useState(false)
  const [busy, setBusy] = useState(false)
  const blocked = pending.length === 0 ? 'There are no pending comments or replies.' : null
  const canApprove = !drift && !loaded.refMissing
  const act = choice === 'send' && blocked ? 'approve' : choice
  if (loaded.view?.commit) {
    return <button className="btn sm primary" disabled data-gr="review-menu" title="A review covers the whole comparison — show all changes to send comments or approve">Review<Icon name="chevDown" size={12} /></button>
  }
  return (
    <Menu
      label={<>Review{pending.length > 0 && <span className="counter on-accent">{pending.length}</span>}<Icon name="chevDown" size={12} /></>}
      className="btn sm primary" align="right" hook="review-menu" title="Send your pending comments and replies to Claude Code, or approve"
    >
      {(close) => (
        <div className="review-pop">
          <div className="pop-title">Finish your review</div>
          <textarea name="gr-text" rows={3} value={note} placeholder="Leave a note for Claude Code (optional)" disabled={act !== 'send'} onChange={(e) => setNote(e.target.value)} />
          <label className={'radio' + (blocked ? ' off' : '')} title={blocked ?? 'Delivered when Claude Code is listening. It answers in each thread and reports an outcome for each comment.'}>
            <input type="radio" name="gr-review-choice" checked={act === 'send'} disabled={Boolean(blocked)} onChange={() => setChoice('send')} />
            <span><strong data-gr="send-label">Send {what} to Claude Code</strong>{blocked && <span className="muted small"> — {blocked}</span>}</span>
          </label>
          {act === 'send' && editable && (
            <label className="check sub" title="Off: the edits stay uncommitted for you to check">
              <input type="checkbox" name="gr-field" checked={commit} onChange={(e) => setCommit(e.target.checked)} data-gr="commit-toggle" /> commit the changes
            </label>
          )}
          {act === 'send' && !editable && (
            <div className="muted small sub" data-gr="not-editable">
              {loaded.apply.reason === 'frozen-commit' ? 'Fixed commit: Claude Code can answer here but not edit.' : 'The branch is not checked out anywhere: Claude Code can answer here but not edit.'}
            </div>
          )}
          <label className={'radio' + (canApprove ? '' : ' off')} title={drift ? 'Refresh first: the code changed since you loaded it' : 'Records your approval of exactly this state'}>
            <input type="radio" name="gr-review-choice" checked={act === 'approve'} disabled={!canApprove} onChange={() => setChoice('approve')} />
            <span><strong>{loaded.approved ? 'Withdraw approval' : 'Approve'}</strong>{drift && <span className="muted small"> — refresh first</span>}</span>
          </label>
          <AwayHint />
          <div className="row end">
            <button
              className="btn sm primary" data-gr={act === 'send' ? 'send-batch' : 'approve'} data-gr-approved={loaded.approved ? 'true' : 'false'}
              disabled={busy || (act === 'send' ? Boolean(blocked) : !canApprove)}
              onClick={() => {
                setBusy(true)
                const done = (): void => { setBusy(false); setNote(''); close() }
                if (act === 'send') void request({ kind: 'apply', commentIds: pending.map((c) => c.id), text: note.trim() || undefined, commit: commit && editable }).then(done)
                else void toggleApprove().then(done)
              }}
            >
              {act === 'send' ? 'Send to Claude Code' : loaded.approved ? 'Withdraw approval' : 'Approve'}
            </button>
          </div>
        </div>
      )}
    </Menu>
  )
}

function CommentsMenu({ loaded }: { loaded: LoadedReview }) {
  const setTab = useStore((s) => s.setTab)
  const all = loaded.state.comments
  const groups: { title: string; list: Comment[] }[] = [
    { title: 'Pending', list: all.filter((c) => c.status === 'queued' || hasPendingReply(c)) },
    { title: 'With Claude Code', list: all.filter((c) => c.status === 'sent') },
    { title: 'Answered by Claude', list: all.filter((c) => c.status === 'answered') },
    { title: 'Notes from Claude', list: all.filter((c) => c.status === 'note') },
    { title: 'Resolved', list: all.filter((c) => c.status === 'resolved') },
    { title: 'Outdated', list: all.filter((c) => c.status === 'outdated') }
  ].filter((g) => g.list.length > 0)
  return (
    <Menu label={<><Icon name="comment" /><span className="counter">{all.length}</span></>} className="btn sm" align="right" hook="comments-menu" title="All comments">
      {(close) => (
        <div className="comments-pop">
          {groups.length === 0 && <div className="pop-note">No comments yet.</div>}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="pop-head">{g.title} <span className="counter">{g.list.length}</span></div>
              {g.list.map((c) => {
                const t = c.lineGone || c.status === 'outdated' ? null : focusable(c.anchor)
                return (
                  <button key={c.id} className="pop-item col" onClick={() => { close(); if (t) focusAnchor(t); else setTab(c.anchor.kind === 'artifact' ? 'spec' : 'conversation') }}>
                    <span className="mono small muted">{c.author === 'agent' ? 'Claude' : 'You'} · {anchorLabel(c.anchor)}</span>
                    <span className="clip">{c.text}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </Menu>
  )
}

// ── Files changed ─────────────────────────────────────────────
/** The narrowest window in which a diff stays split while a section is docked in the
 *  tree's place: its column is then as wide (about 730px) as the narrowest one that is
 *  split by default with the tree showing. */
const SPLIT_BESIDE_SECTION = 1200
/** Drag (or arrow keys) to resize the file panel; double-click resets it. */
function ResizeHandle({ width, onChange }: { width: number; onChange: (px: number | null) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const down = (e: RPointerEvent<HTMLDivElement>): void => { drag.current = { x: e.clientX, w: width }; e.currentTarget.setPointerCapture(e.pointerId) }
  const move = (e: RPointerEvent<HTMLDivElement>): void => { if (drag.current) onChange(drag.current.w + e.clientX - drag.current.x) }
  const up = (): void => { drag.current = null }
  const key = (e: RKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(width + (e.key === 'ArrowLeft' ? -20 : 20)) }
    else if (e.key === 'Home') onChange(null)
  }
  return (
    <div
      className="resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize the file panel" tabIndex={0} data-gr="tree-resize"
      aria-valuenow={width} aria-valuemin={treeWidthLimits.min} aria-valuemax={treeWidthLimits.max}
      title="Drag to resize · double-click to reset" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => onChange(null)} onKeyDown={key}
    />
  )
}
interface DirNode { name: string; path: string; dirs: DirNode[]; files: FileDiff[] }
/** Nest files by directory, folding chains of single-child directories into one row. */
function buildTree(files: FileDiff[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] }
  for (const f of files) {
    let node = root
    for (const part of f.path.split('/').slice(0, -1)) {
      let next = node.dirs.find((d) => d.name === part)
      if (!next) { next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: [], files: [] }; node.dirs.push(next) }
      node = next
    }
    node.files.push(f)
  }
  const fold = (n: DirNode): DirNode => {
    let cur = n
    while (cur.files.length === 0 && cur.dirs.length === 1 && cur.name) cur = { ...cur.dirs[0], name: `${cur.name}/${cur.dirs[0].name}` }
    return { ...cur, dirs: cur.dirs.map(fold).sort((a, b) => a.name.localeCompare(b.name)), files: [...cur.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path))) }
  }
  return fold(root)
}
/** Files in the order the tree shows them: folders first, depth-first. */
const treeOrder = (n: DirNode): FileDiff[] => [...n.dirs.flatMap(treeOrder), ...n.files]

/** How far each level of the tree is indented: the width of a chevron and the gap after
 *  it, so a row's chevron (or a file's empty chevron slot) sits under its parent's folder icon. */
const TREE_STEP = 16
const STATUS_MARK: Record<FileDiff['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: '' }
/** `nested`: the row is in the folder tree, so it keeps an empty slot where a folder has its chevron. */
/** Whether a row in a list of files is the one to mark as where the reviewer is: `is`
 *  says so of the file under the top of the window. When the mark lands on a row of the
 *  file tree, the tree scrolls itself just enough to show it — never the page, which a
 *  scrollIntoView would also move. */
function useHere<T extends HTMLElement>(is: (file: string) => boolean): { ref: RefObject<T | null>; here: boolean } {
  const here = useStore((s) => s.currentFile != null && is(s.currentFile))
  const ref = useRef<T>(null)
  useEffect(() => {
    const row = ref.current
    const box = row?.closest<HTMLElement>('.tree')
    if (!here || !row || !box) return
    const r = row.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 4
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4
  }, [here])
  return { ref, here }
}
function TreeFile({ file, depth, comments, showDir, nested }: { file: FileDiff; depth: number; comments: number; showDir?: boolean; nested?: boolean }) {
  const sec = useContext(SectionsCtx).get(file.path)
  const { ref, here } = useHere<HTMLButtonElement>((f) => f === file.path)
  return (
    <button ref={ref} className={'tree-row leaf' + (sec ? ' in-sec' : '') + (here ? ' here' : '')} aria-current={here ? 'true' : undefined} style={{ paddingLeft: `${8 + depth * TREE_STEP}px`, ...(sec ? secStyle(sec.no) : {}) }} title={`${file.path} (${file.status})${sec ? ` · ${sec.section.name}` : ''}`} data-gr-tree-file={file.path} data-gr-status={file.status} onClick={() => focusAnchor({ kind: 'file', file: file.path }, { nav: true, top: true })}>
      {nested && <span className="tree-chev" />}
      <FileIcon path={file.path} />
      <span className={'tree-name' + (file.status === 'deleted' ? ' gone' : '')}>{baseName(file.path)}{showDir && file.path.includes('/') && <span className="muted small"> {file.path.slice(0, file.path.lastIndexOf('/'))}</span>}</span>
      {STATUS_MARK[file.status] && <span className={'tree-status st-' + file.status}>{STATUS_MARK[file.status]}</span>}
      {comments > 0 && <span className="tree-dot" title={plural(comments, 'comment')}>{comments}</span>}
      {file.viewed === 'viewed' && <Icon name="check" size={12} className="tree-viewed" />}
      {file.viewed === 'changed' && <span className="tree-changed" title="Changed since last view" />}
    </button>
  )
}
/** For the file tree: each file's walkthrough section and its position (empty when the
 *  tree is already grouped by section, where the group's row carries the colour). */
type SectionMap = Map<string, { section: Section; no: number }>
const NO_SECTIONS: SectionMap = new Map()
const SectionsCtx = createContext<SectionMap>(NO_SECTIONS)
function TreeDir({ node, depth, closed, toggle, counts }: { node: DirNode; depth: number; closed: Set<string>; toggle: (p: string) => void; counts: Map<string, number> }) {
  const open = !closed.has(node.path)
  // folded, it stands for the files inside it. Only rows with every folder above them
  // open are drawn, so the folded one that holds the file is the nearest row on screen.
  const { ref, here } = useHere<HTMLButtonElement>((f) => !open && f.startsWith(node.path + '/'))
  return (
    <>
      <button ref={ref} className={'tree-row dir' + (here ? ' here' : '')} aria-current={here ? 'true' : undefined} style={{ paddingLeft: `${8 + depth * TREE_STEP}px` }} aria-expanded={open} title={node.path} data-gr-dir={node.path} onClick={() => toggle(node.path)}>
        <Icon name={open ? 'chevDown' : 'chevRight'} size={12} className="tree-chev" /><Icon name="folder" className="folder" /><span className="tree-name">{node.name}</span>
      </button>
      {open && node.dirs.map((d) => <TreeDir key={d.path} node={d} depth={depth + 1} closed={closed} toggle={toggle} counts={counts} />)}
      {open && node.files.map((f) => <TreeFile key={f.path} file={f} depth={depth + 1} comments={counts.get(f.path) ?? 0} nested />)}
    </>
  )
}

function SectionHeader({ section, files, no }: { section: Section; files: FileDiff[]; no: number }) {
  const reviewed = useStore((s) => s.reviewedSections.includes(section.id))
  const toggle = useStore((s) => s.toggleSectionReviewed)
  const k = anchorKey({ kind: 'section', sectionId: section.id })
  return (
    <div className="sec-head" style={secStyle(no)} data-gr-section={section.id} data-gr-reviewed={reviewed ? 'true' : 'false'}>
      <div className="sec-title-row">
        <span className="sec-dot" />
        <h3>{section.name}</h3>
        <span className="muted small">{plural(files.length, 'file')}</span>
        <span className="grow" />
        <CommentButton k={k} title="Comment on this section" />
        <label className={'viewed-box' + (reviewed ? ' on' : '')}><input type="checkbox" name="gr-field" checked={reviewed} onChange={() => void toggle(section.id)} data-gr="section-reviewed" /> Reviewed</label>
      </div>
      {section.desc && <div className="sec-desc">{section.desc}</div>}
      {section.what && <Md text={section.what} />}
      <Diagram section={section} />
      <CommentSlot anchor={{ kind: 'section', sectionId: section.id }} k={k} />
    </div>
  )
}
/** A walkthrough section beside the code: what it says, its files, and the same
 *  Reviewed mark and comment thread it has in the Conversation tab. Opened from a file's
 *  section chip, so reading about a group of files never means leaving them. It is also
 *  how the walkthrough is gone through in order: its arrows and "Reviewed, next" open
 *  another section and bring the code to it (goToSection). */
function SectionPanel({ sections }: { sections: Section[] }) {
  const id = useStore((s) => s.sectionPanel)
  const done = useStore((s) => s.reviewedSections)
  const toggle = useStore((s) => s.toggleSectionReviewed)
  const files = useStore((s) => s.loaded?.files)
  const set = useStore((s) => s.set)
  const no = sections.findIndex((s) => s.id === id)
  const section = sections[no]
  // the file being read, when it is one of this section's
  const here = useStore((s) => (s.currentFile && section?.files.includes(s.currentFile) ? s.currentFile : null))
  const stepped = useRef(0)
  useEffect(() => {
    if (!section) return
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof Element && e.target.closest('input, textarea, [role="menu"]')
      if (e.key === 'Escape' && !typing) showSection(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [section, set])
  if (!section) return null
  const k = anchorKey({ kind: 'section', sectionId: section.id })
  const reviewed = done.includes(section.id)
  const step = (d: number): void => goToSection(sections[(no + d + sections.length) % sections.length].id)
  // the next section still to review: after this one, then round to the earliest (the list
  // of reviewed ids can hold sections of an earlier walkthrough, so it is never counted)
  const next = [...sections.slice(no + 1), ...sections.slice(0, no)].find((s) => !done.includes(s.id))
  const allDone = sections.every((s) => done.includes(s.id))
  const reviewedNext = (): void => {
    // the second click of a double click would tick the section just arrived at, unread
    if (Date.now() - stepped.current < 500) return
    // never a toggle: on a section already ticked it only moves on
    void (reviewed ? Promise.resolve() : toggle(section.id)).then(() => {
      // (they may have moved on by hand while the tick was being saved)
      if (!next || useStore.getState().sectionPanel !== section.id) return
      stepped.current = Date.now()
      goToSection(next.id)
    })
  }
  return (
    <aside className="sec-panel" style={secStyle(no)} aria-label="Walkthrough section" data-gr="section-panel" data-gr-section-panel={section.id} data-gr-reviewed={reviewed ? 'true' : 'false'}>
      <div className="sec-panel-head">
        <span className="sec-dot" /><span className="muted small">Section {no + 1} of {sections.length}</span>
        {reviewed && <span className="sec-tick" role="img" aria-label="Reviewed" title="You marked this section reviewed" data-gr="section-tick"><Icon name="check" size={14} /></span>}
        <span className="grow" />
        {sections.length > 1 && <button className="icon-btn" title="Previous section, and its code" aria-label="Previous section" data-gr="section-prev" onClick={() => step(-1)}><Icon name="chevUp" /></button>}
        {sections.length > 1 && <button className="icon-btn" title="Next section, and its code" aria-label="Next section" data-gr="section-next" onClick={() => step(1)}><Icon name="chevDown" /></button>}
        <button className="icon-btn" title="Close (Esc)" aria-label="Close section" data-gr="section-panel-close" onClick={() => showSection(null)}><Icon name="x" /></button>
      </div>
      <h3>{section.name}</h3>
      {section.desc && <div className="sec-desc">{section.desc}</div>}
      <div className="row gap wrap">
        {allDone
          ? <span className="sec-all-done" data-gr="sections-done"><Icon name="check" size={14} />{sections.length === 1 ? 'The section is reviewed' : `All ${sections.length} sections reviewed`}</span>
          : (
            <button className="btn sm primary" data-gr="section-reviewed-next" title={reviewed ? `Go to the next section you have not reviewed: “${next?.name}”` : next ? `Mark this section reviewed and go to the next one you have not reviewed: “${next.name}”` : 'Mark this section reviewed — it is the last one left'} onClick={reviewedNext}>
              <Icon name={reviewed ? 'arrowDown' : 'check'} size={14} />{reviewed ? 'Next unreviewed' : next ? 'Reviewed, next' : 'Reviewed, finish'}
            </button>
          )}
        <label className={'viewed-box' + (reviewed ? ' on' : '')}><input type="checkbox" name="gr-field" checked={reviewed} onChange={() => void toggle(section.id)} data-gr="section-reviewed" /> Reviewed</label>
        <button className="btn sm" data-gr="section-comment" onClick={() => set({ composer: k })}><Icon name="comment" size={14} /> Comment</button>
      </div>
      <CommentSlot anchor={{ kind: 'section', sectionId: section.id }} k={k} />
      {section.what && <Md text={section.what} />}
      <Diagram section={section} />
      <div className="sec-panel-files">
        <div className="side-title">{plural(section.files.length, 'file')}</div>
        {section.files.map((p) => {
          const f = files?.find((x) => x.path === p)
          return (
            <button key={p} className={'tree-row leaf' + (p === here ? ' here' : '') + (f ? '' : ' gone')} disabled={!f} aria-current={p === here ? 'true' : undefined} title={f ? p : `${p} — no longer part of this comparison`} data-gr-panel-file={p} onClick={() => focusAnchor({ kind: 'file', file: p }, { nav: true, top: true })}>
              <FileIcon path={p} /><span className="tree-name">{baseName(p)}</span>
              {f?.viewed === 'viewed' && <Icon name="check" size={12} className="tree-viewed" />}
              {f && <DiffStat add={f.add} del={f.del} />}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
function Diagram({ section }: { section: Section }) {
  if (!section.diagram?.length) return null
  return (
    <figure className="diagram">
      <div className="nodes">
        {section.diagram.map((n, i) => (
          <span key={i} className="node-wrap">
            {i > 0 && <span className="node-arrow" aria-hidden="true">→</span>}
            <span className={'node ' + n.kind}><span className="node-label">{n.label}</span>{n.sub && <span className="node-sub">{n.sub}</span>}</span>
          </span>
        ))}
      </div>
      {section.insight?.caption && <figcaption className="muted small">{section.insight.caption}</figcaption>}
    </figure>
  )
}

function FilesTab({ loaded }: { loaded: LoadedReview }) {
  const mode = useStore((s) => s.diffMode)
  const filters = useStore((s) => s.filters)
  const query = useStore((s) => s.fileQuery)
  const panelOpen = useStore((s) => s.panelOpen)
  const diffView = useStore((s) => s.diffView)
  const treeView = useStore((s) => s.treeView)
  const view = useStore((s) => s.view)
  const treeWidth = useStore((s) => s.treeWidth)
  const { set, setFilters, setDiffView, setTreeView, setView, setTreeWidth } = useStore.getState()
  const commitView = loaded.view?.commit
  const shownCommit = commitView ? loaded.commits.find((c) => c.sha === commitView) : undefined
  const wide = useWide(1100)
  const medium = useWide(760)
  const roomy = useWide(900)
  const widest = useWide(1600)
  const fits = useWide(SPLIT_BESIDE_SECTION)
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [, bump] = useState(0)
  const wt = loaded.state.walkthrough
  const since = loaded.since
  const showSince = sinceActive(loaded)
  const anyViewed = Object.keys(loaded.state.viewedAt).length > 0
  const eff: DiffMode = commitView || (mode === 'since' && !showSince) || (mode === 'viewed' && !anyViewed) ? 'all' : mode
  useEffect(() => { if (eff !== mode) set({ diffMode: eff }) }, [eff, mode, set])

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    if (commitView) return m      // comments belong to the whole comparison
    for (const c of loaded.state.comments) if ((c.anchor.kind === 'diff' || c.anchor.kind === 'file') && c.status !== 'outdated') m.set(c.anchor.file, (m.get(c.anchor.file) ?? 0) + 1)
    return m
  }, [loaded.state.comments, commitView])
  const sectionOf = useMemo(() => {
    const m = new Map<string, Section>()
    for (const s of wt?.sections ?? []) for (const p of s.files) m.set(p, s)
    return m
  }, [wt])
  // each file's section and that section's position in the walkthrough (its colour)
  const sections = useMemo(() => {
    const m: SectionMap = new Map()
    for (const [no, s] of (wt?.sections ?? []).entries()) for (const p of s.files) m.set(p, { section: s, no })
    return m
  }, [wt])
  const sectionNo = (s: Section | null | undefined): number => (s ? (wt?.sections ?? []).indexOf(s) : -1)
  const secPanelId = useStore((s) => s.sectionPanel)
  const reviewed = useStore((s) => s.reviewedSections)
  const secPanel = Boolean(secPanelId && wt?.sections.some((s) => s.id === secPanelId))
  // From 1100px the open section is a column, not a drawer over the code. Up to 1600px
  // there is no room for three columns: it takes the tree's place until it is closed, and
  // where the diff column left beside it is too narrow to read two-up, the diff is unified.
  // Between 760 and 1100px it is still a drawer, and the tree gives way just the same, or
  // the two together would leave a sliver of the code the section is about.
  const forTree = secPanel && medium && !widest
  const treeShown = panelOpen && !forTree
  const canSplit = roomy && !(forTree && !fits)
  const split = canSplit && (diffView ?? (wide ? 'split' : 'unified')) === 'split'

  const wsOnly = useStore((s) => s.wsOnly)
  const wsPaths = useMemo(() => new Set(wsOnly.map((f) => f.path)), [wsOnly])
  const allFiles = useMemo(() => [...loaded.files, ...wsOnly.filter((f) => !loaded.files.some((x) => x.path === f.path))], [loaded.files, wsOnly])
  const kept = allFiles.filter((f) => !f.excluded)
  const excluded = allFiles.filter((f) => f.excluded)
  const q = query.trim().toLowerCase()
  const visible = kept.filter((f) =>
    (!q || f.path.toLowerCase().includes(q)) && (!filters.hideViewed || f.viewed !== 'viewed') && (!filters.onlyCommented || (counts.get(f.path) ?? 0) > 0)
    && (eff === 'all' || f.untracked || (eff === 'since' ? f.sinceHunks !== undefined : f.sinceViewedHunks !== undefined)))
  const tree = useMemo(() => buildTree(visible), [visible]) // eslint-disable-line react-hooks/exhaustive-deps
  const bySection = filters.bySection && Boolean(wt)
  const groups: { section: Section | null; files: FileDiff[] }[] = bySection
    ? [
        ...(wt?.sections ?? []).map((s) => ({ section: s, files: s.files.map((p) => visible.find((f) => f.path === p)).filter((f): f is FileDiff => Boolean(f)) })),
        { section: null, files: visible.filter((f) => !sectionOf.has(f.path)) }
      ].filter((g) => g.files.length > 0)
    : [{ section: null, files: treeView === 'tree' ? treeOrder(tree) : visible }]
  const viewed = kept.filter((f) => f.viewed === 'viewed').length
  // the list of reviewed ids can hold sections of an earlier walkthrough: count this one's
  const secCount = wt?.sections.length ?? 0
  const secDone = (wt?.sections ?? []).filter((s) => reviewed.includes(s.id)).length
  const secNext = wt?.sections.find((s) => !reviewed.includes(s.id)) ?? wt?.sections[0]
  // the file under the top of the window, for the tree and the section panel to mark:
  // followed anew when other boxes are drawn, or the same ones in another order or under
  // other groups, which no scroll or resize tells
  const list = useRef<HTMLDivElement>(null)
  const order = groups.flatMap((g) => g.files.map((f) => f.path)).join('\n')
  useEffect(() => (list.current ? followFiles(list.current) : undefined), [order, bySection, filters.showExcluded])
  const toggleDir = (p: string): void => setClosed((prev) => { const next = new Set(prev); if (next.has(p)) next.delete(p); else next.add(p); return next })
  const modeLabel = shownCommit ? `${short(shownCommit.sha)} ${shownCommit.subject}` : commitView ? short(commitView) : eff === 'all' ? 'All changes' : eff === 'since' ? (since?.kind === 'approved' ? 'Since approved' : 'Since reviewed') : 'Since viewed'
  const pick = (m: DiffMode, close: () => void): void => { set({ diffMode: m }); if (commitView) void setView({ commit: undefined }); close() }
  const dirty = loaded.dirty && loaded.files.some((f) => f.uncommitted)

  return (
    <div className="files-tab">
      <div className="files-toolbar">
        <button className="btn sm icon" title={treeShown ? 'Hide the file tree' : forTree ? 'Show the file tree (closes the section beside the code)' : 'Show the file tree'} aria-label="Toggle file tree" aria-pressed={treeShown} onClick={() => { if (forTree) { showSection(null); set({ panelOpen: true }) } else set({ panelOpen: !panelOpen }) }}><Icon name="sidebar" /></button>
        <Menu label={<><Icon name="commit" /><span className="mode-label">{modeLabel}</span><Icon name="chevDown" size={12} /></>} className="btn sm mode-btn" hook="diff-mode" title="Which changes to show">
          {(close) => (
            <div className="commit-menu">
              <MenuItem checked={!commitView && eff === 'all'} onClick={() => pick('all', close)}>Show all changes <span className="muted small">{plural(loaded.commits.length, 'commit')}</span></MenuItem>
              {showSince && since && <MenuItem checked={!commitView && eff === 'since'} title={`Since ${short(since.sha)}`} onClick={() => pick('since', close)}>{since.kind === 'approved' ? 'Since approved' : 'Since reviewed'} <span className="mono muted small">{short(since.sha)}</span></MenuItem>}
              {anyViewed && <MenuItem checked={!commitView && eff === 'viewed'} onClick={() => pick('viewed', close)}>Since viewed</MenuItem>}
              {loaded.commits.length > 0 && <div className="menu-sep" />}
              {loaded.commits.map((c) => (
                <button key={c.sha} className="menu-item commit-item" role="menuitem" data-gr-commit-pick={c.sha} onClick={() => { void setView({ commit: c.sha }); close() }}>
                  <span className="menu-check">{commitView === c.sha ? <Icon name="check" size={14} /> : null}</span>
                  <span className="grow"><span className="clip strong">{c.subject}</span><span className="muted small"><span className="mono">{short(c.sha)}</span> · {c.author} · {ago(c.date)}</span></span>
                </button>
              ))}
            </div>
          )}
        </Menu>
        {dirty && <span className="legend small muted" title="Uncommitted lines carry a stripe in the gutter"><span className="swatch staged" />staged<span className="swatch unstaged" />unstaged</span>}
        <span className="grow" />
        <span className="viewed-progress" data-gr="viewed-progress"><Icon name="circle" size={14} /><strong>{viewed}</strong> / {kept.length} viewed</span>
        {secNext && (
          <button
            className={'btn sm sec-progress' + (secDone === secCount ? ' done' : '')} style={secStyle(sectionNo(secNext))} data-gr="sections-progress" data-gr-reviewed={secDone} data-gr-sections={secCount}
            title={`Guided review: go through the walkthrough section by section, marking each Reviewed.\n${secDone === secCount ? `All ${plural(secCount, 'section')} reviewed — opens the first one` : `Opens the first section you have not reviewed, “${secNext.name}”,`} beside the code and takes you to its first file not yet viewed.`}
            onClick={() => goToSection(secNext.id)}
          >
            {secDone === secCount ? <Icon name="check" size={14} /> : <span className="sec-dot" />}<span><strong>{secDone}</strong> / {plural(secCount, 'section')}</span>
          </button>
        )}
        <ReviewMenu loaded={loaded} />
        <Menu label={<Icon name="gear" />} className="btn sm icon" align="right" hook="view-settings" title="View settings">
          {(close) => (
            <>
              <div className="pop-head">Diff view</div>
              <MenuItem checked={split} disabled={!canSplit} title={roomy && !canSplit ? 'Not enough room beside the section — close it to split the diff' : undefined} onClick={() => { setDiffView('split'); close() }}>Split</MenuItem>
              <MenuItem checked={!split} onClick={() => { if (canSplit) setDiffView('unified'); close() }}>Unified</MenuItem>
              <label className="menu-item" title="Leave out changes that only alter whitespace"><span className="menu-check"><input type="checkbox" name="gr-field" data-gr="hide-whitespace" checked={Boolean(view.ignoreWhitespace)} onChange={(e) => { void setView({ ignoreWhitespace: e.target.checked }); close() }} /></span>Hide whitespace</label>
              <div className="pop-head">File panel</div>
              <MenuItem checked={treeView === 'tree'} onClick={() => { setTreeView('tree'); close() }}>Tree</MenuItem>
              <MenuItem checked={treeView === 'list'} onClick={() => { setTreeView('list'); close() }}>List</MenuItem>
              <div className="pop-head">Theme</div>
              <MenuItem checked={currentTheme() === 'light'} onClick={() => { setTheme('light'); bump((n) => n + 1); close() }}>Light</MenuItem>
              <MenuItem checked={currentTheme() === 'dark'} onClick={() => { setTheme('dark'); bump((n) => n + 1); close() }}>Dark</MenuItem>
            </>
          )}
        </Menu>
        <CommentsMenu loaded={loaded} />
      </div>

      {commitView && (
        <div className="flash-banner info" data-gr="commit-view">
          <span className="grow">Showing changes from commit <span className="ref-chip mono">{short(commitView)}</span> only — comments and review apply to the whole comparison.</span>
          <button className="btn sm" onClick={() => void setView({ commit: undefined })}>Show all changes</button>
        </div>
      )}
      <div className={'files-layout' + (treeShown ? '' : ' no-panel') + (secPanel ? ' with-sec' : '')} style={{ '--tree-w': `${treeWidth}px` } as React.CSSProperties}>
        {treeShown && (
          <SectionsCtx.Provider value={bySection ? NO_SECTIONS : sections}>
          <aside className="tree-panel" aria-label="Files" data-gr="files-view" data-gr-files-view={bySection ? 'sections' : treeView}>
            <ResizeHandle width={treeWidth} onChange={setTreeWidth} />
            <div className="tree-filter">
              <span className="filter-input"><Icon name="search" size={14} /><input id="gr-file-filter" name="gr-field" value={query} placeholder="Filter files…" aria-label="Filter files" onChange={(e) => set({ fileQuery: e.target.value })} /></span>
              <Menu label={<Icon name="filter" />} className="btn sm icon" align="right" hook="file-filters" title="Filter options">
                {(close) => (
                  <>
                    {(['hideViewed', 'onlyCommented', 'bySection', 'showExcluded'] as (keyof Filters)[]).map((k) => (
                      <MenuItem key={k} checked={filters[k]} disabled={(k === 'bySection' && !wt) || (k === 'showExcluded' && excluded.length === 0)} onClick={() => { setFilters({ [k]: !filters[k] }); close() }}>
                        {k === 'hideViewed' ? 'Hide viewed files' : k === 'onlyCommented' ? 'Only files with comments' : k === 'bySection' ? 'Group by walkthrough section' : `Show untracked files left out${excluded.length ? ` (${excluded.length})` : ''}`}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Menu>
            </div>
            <div className="tree">
              {visible.length === 0 && <div className="pop-note">No files match.</div>}
              {bySection
                ? groups.map((g) => (
                    <div key={g.section?.id ?? '-'} style={g.section ? secStyle(sectionNo(g.section)) : undefined}>
                      <button className="tree-row dir sec" title={g.section?.desc} data-gr-tree-section={g.section?.id} data-gr-reviewed={g.section && reviewed.includes(g.section.id) ? 'true' : 'false'} onClick={() => { if (g.section) { const el = document.querySelector(`[data-gr-section="${g.section.id}"]`); el?.scrollIntoView({ block: 'start' }) } }}>
                        {g.section && <span className="sec-dot" />}<span className="tree-name">{g.section?.name ?? 'Not in the walkthrough'}</span>
                        {g.section && reviewed.includes(g.section.id) && <span className="sec-tick" role="img" aria-label="Reviewed" title="You marked this section reviewed"><Icon name="check" size={12} /></span>}
                        <span className="muted small">{g.files.length}</span>
                      </button>
                      {g.files.map((f) => <TreeFile key={f.path} file={f} depth={1} comments={counts.get(f.path) ?? 0} showDir />)}
                    </div>
                  ))
                : treeView === 'tree'
                  ? <>{tree.dirs.map((d) => <TreeDir key={d.path} node={d} depth={0} closed={closed} toggle={toggleDir} counts={counts} />)}{tree.files.map((f) => <TreeFile key={f.path} file={f} depth={0} comments={counts.get(f.path) ?? 0} nested />)}</>
                  : visible.map((f) => <TreeFile key={f.path} file={f} depth={0} comments={counts.get(f.path) ?? 0} showDir />)}
            </div>
          </aside>
          </SectionsCtx.Provider>
        )}
        <div className="files-list" ref={list}>
          {kept.length === 0 && <div className="blankslate"><h3>No changes</h3><p className="muted">The two sides of this comparison are identical.</p></div>}
          {kept.length > 0 && visible.length === 0 && <div className="blankslate"><h3>No files match</h3><p className="muted">Change the filter or the “{modeLabel}” view.</p></div>}
          {groups.map((g) => (
            <div key={g.section?.id ?? '-'} className={'file-group' + (bySection && g.section ? ' sec' : '')} style={bySection && g.section ? secStyle(sectionNo(g.section)) : undefined}>
              {bySection && (g.section
                ? <SectionHeader section={g.section} files={g.files} no={sectionNo(g.section)} />
                : <div className="sec-head plain" id="gr-loose"><h3>Not in the walkthrough</h3><span className="muted small">{plural(g.files.length, 'file')}</span></div>)}
              {g.files.map((f) => <FileBox key={f.path} file={f} split={split} whitespaceOnly={wsPaths.has(f.path)} section={sectionOf.get(f.path)} sectionNo={sections.get(f.path)?.no} grouped={bySection} note={sectionOf.get(f.path)?.plainNotes?.[f.path]} />)}
            </div>
          ))}
          {filters.showExcluded && excluded.length > 0 && (
            <div className="file-group" id="gr-excluded">
              <div className="sec-head plain"><h3>Untracked, left out of the review</h3><span className="muted small">{plural(excluded.length, 'file')}</span></div>
              {excluded.map((f) => <FileBox key={f.path} file={f} split={split} />)}
            </div>
          )}
        </div>
        {secPanel && <SectionPanel sections={wt?.sections ?? []} />}
      </div>
    </div>
  )
}

// ── Conversation ──────────────────────────────────────────────
function TourCard({ stops, loop }: { stops: TourStop[]; loop?: boolean }) {
  const set = useStore((s) => s.set)
  const start = (idx: number): void => startTour(stops, loop, idx)
  return (
    <div className="tour-card" data-gr="chat-tour">
      <div className="pop-head">Tour · {stops.length} stops{loop ? ' · loops' : ''}</div>
      <ol>{stops.map((s, i) => <li key={i}><button className="link mono small" onClick={() => start(i)}>{targetLabel(s.target)}</button>{s.note && <span className="muted"> — {s.note}</span>}</li>)}</ol>
      <button className="btn sm" onClick={() => start(0)}>Start the tour</button>
    </div>
  )
}
function ActionChip({ action }: { action: UiAction }) {
  if (action.kind === 'focus') return <button className="ref-chip mono link-chip" data-gr="chat-focus" title="Show this in Files changed" onClick={() => focusAnchor(action.target)}>{targetLabel(action.target)}</button>
  if (action.kind === 'tour') return <TourCard stops={action.stops} loop={action.loop} />
  return null
}

function Progress({ r }: { r: ReviewRequest }) {
  useTick(1000)
  const cancel = useStore((s) => s.cancelRequest)
  const retry = useStore((s) => s.retryRequest)
  const away = useStore((s) => s.loaded?.presence === 'away')
  const stuck = stuckReason(r, away)
  const why = stuck && stuckText(r, stuck)
  return (
    <div className="tl-progress" data-gr-request={r.id}>
      <div className="row gap wrap">
        <span className="spinner" />
        <span data-gr="request-state">{r.status === 'pending' ? 'Waiting for Claude Code to pick this up' : stuck === 'away' ? `A Claude Code session picked this up ${elapsed(r.startedAt) || '0s'} ago` : `Claude Code is working on it — working for ${elapsed(r.startedAt) || '0s'}`}</span>
        {why && <span className="label warn" data-gr="request-stuck" data-gr-stuck={stuck} title={why.title}>{why.label}</span>}
        {stuck && <button className="link" data-gr="request-retry" onClick={() => void retry(r.id)}>Send again</button>}
        <button className="link" data-gr="request-cancel" onClick={() => void cancel(r.id)}>Cancel</button>
      </div>
      {(isUnclaimed(r, away) || stuck === 'away') && <AwayHint />}
      {r.progress.map((p, i) => <div key={i} className="progress-line small"><span className="muted">{ago(p.at)}</span> {p.text}</div>)}
    </div>
  )
}

function Box({ author, at, label, children, cls, hook }: { author: 'user' | 'agent'; at?: string; label?: ReactNode; children: ReactNode; cls?: string; hook?: Record<string, string> }) {
  return (
    <div className={'tl-item ' + author + (cls ? ' ' + cls : '')} {...hook}>
      <span className={'avatar lg ' + author} aria-hidden="true">{author === 'agent' ? 'C' : 'Y'}</span>
      <div className="tl-box">
        <div className="tl-box-head"><strong>{author === 'agent' ? 'Claude' : 'You'}</strong>{label && <span className="muted"> {label}</span>}{at && <span className="muted"> · {ago(at)}</span>}</div>
        <div className="tl-box-body">{children}</div>
      </div>
    </div>
  )
}
function Event({ icon, at, children }: { icon: string; at?: string; children: ReactNode }) {
  return <div className="tl-event"><span className="tl-badge"><Icon name={icon} size={14} /></span><span>{children}</span>{at && <span className="muted"> · {ago(at)}</span>}</div>
}

function Decisions({ loaded }: { loaded: LoadedReview }) {
  const questions = loaded.state.walkthrough?.questions ?? []
  const comments = loaded.state.comments
  const iteration = loaded.state.iterations.at(-1)?.n ?? 0
  const waiting = loaded.state.requests.some((r) => r.kind === 'decisions' && isOpen(r))
  const { addComment, updateComment, request } = useStore.getState()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  if (questions.length === 0) return null
  const rows = questions.map((q) => {
    // question ids repeat across walkthroughs: only answers to THIS walkthrough count
    const mine = comments.filter((c) => c.anchor.kind === 'question' && c.anchor.questionId === q.id && c.iteration >= iteration)
    return { q, resolved: mine.filter((c) => c.status === 'resolved').pop(), pending: mine.filter((c) => c.status === 'queued' || c.status === 'sent').pop() }
  })
  const open = rows.filter((r) => !r.resolved)
  const valueOf = (r: (typeof rows)[number]): string => answers[r.q.id] ?? r.pending?.text ?? ''
  const ready = open.some((r) => valueOf(r).trim() && r.pending?.status !== 'sent') && !busy && !waiting
  const submit = (): void => {
    setBusy(true)
    void (async () => {
      const ids: string[] = []
      for (const r of open) {
        const text = valueOf(r).trim()
        if (!text || r.pending?.status === 'sent') continue
        if (r.pending) { if (r.pending.text !== text) await updateComment(r.pending.id, { text }); ids.push(r.pending.id) }
        else { const id = await addComment({ kind: 'question', questionId: r.q.id }, text); if (id) ids.push(id) }
      }
      if (ids.length) await request({ kind: 'decisions', commentIds: ids })
      setBusy(false)
    })()
  }
  return (
    <Box author="agent" label={open.length > 0 ? `needs ${plural(open.length, 'decision')}` : 'has no open questions'} cls="decisions" hook={{ 'data-gr': 'questions', id: 'gr-questions' }}>
      {rows.map((r) => (
        <div key={r.q.id} className={'question' + (r.resolved ? ' done' : '')} data-gr-question={r.q.id}>
          <div className="q-text">{r.q.text}{r.q.context && <span className="muted small"> · {r.q.context}</span>}</div>
          {r.resolved ? <div className="q-answer"><span className="label resolved">Answered</span> {r.resolved.text}{r.resolved.resolution?.note && <span className="muted small"> — {r.resolved.resolution.note}</span>}</div>
            : r.pending?.status === 'sent' ? <div className="q-answer"><span className="label sent">With Claude Code</span> {r.pending.text}</div>
              : (
                <div className="row gap wrap">
                  {(r.q.options ?? []).map((o) => <button key={o} className={'btn sm' + (valueOf(r) === o ? ' selected' : '')} onClick={() => setAnswers({ ...answers, [r.q.id]: o })}>{o}</button>)}
                  <input name="gr-field" className="grow" value={valueOf(r)} onChange={(e) => setAnswers({ ...answers, [r.q.id]: e.target.value })} placeholder="Your decision" aria-label={`Answer to: ${r.q.text}`} />
                </div>
              )}
        </div>
      ))}
      {open.length > 0 && <div className="row gap end"><AwayHint /><button className="btn sm primary" data-gr="send-answers" disabled={!ready} onClick={submit}>Send decisions to Claude Code</button></div>}
    </Box>
  )
}

function planSummary(p: PlanMap): string {
  const met = p.acceptance.filter((a) => a.met === true).length
  const parts: string[] = []
  if (p.acceptance.length) parts.push(`${met} of ${p.acceptance.length} acceptance criteria met`)
  if (p.steps.length) parts.push(`${p.steps.filter((s) => s.status === 'done').length} of ${p.steps.length} plan steps done`)
  if (p.deviations.length) parts.push(plural(p.deviations.length, 'deviation'))
  return parts.join(' · ')
}

function Description({ loaded }: { loaded: LoadedReview }) {
  const wt = loaded.state.walkthrough
  const sectionOpen = useStore((s) => s.sectionOpen)
  const reviewed = useStore((s) => s.reviewedSections)
  const { request, setSectionOpen, setTab, toggleSectionReviewed } = useStore.getState()
  const [steer, setSteer] = useState('')
  const asking = loaded.state.requests.some((r) => r.kind === 'walkthrough' && isOpen(r))
  const it = loaded.state.iterations.at(-1)
  const ask = (update: boolean): void => { void request({ kind: 'walkthrough', text: steer.trim() || undefined, update }).then((r) => { if (r) setSteer('') }) }
  if (!wt) {
    return (
      <Box author="agent" label="has not written a walkthrough yet" cls="description">
        <div data-gr="summary" className="muted">The diff in Files changed comes straight from git.</div>
        <div className="row gap wrap ask-row">
          <input name="gr-field" className="grow" value={steer} placeholder="What should it focus on? (optional)" onChange={(e) => setSteer(e.target.value)} aria-label="Steer" />
          <button className="btn sm primary" data-gr="generate" disabled={asking || Boolean(loaded.refMissing)} onClick={() => ask(false)}>Ask Claude Code for a walkthrough</button>
        </div>
        <AwayHint />
        <CommentSlot anchor={{ kind: 'summary' }} k="summary" />
      </Box>
    )
  }
  return (
    <Box author="agent" label="wrote the walkthrough" at={it?.at} cls="description">
      {loaded.walkthroughStale && (
        <div className="flash-banner warn" data-gr="stale">
          <span className="grow">The code changed since this walkthrough.</span>
          <button className="btn sm" data-gr="update" disabled={asking} onClick={() => ask(true)}>Ask Claude Code to update it</button>
        </div>
      )}
      <div data-gr="summary" className="summary-wrap"><Md text={wt.summary || '_No summary._'} /><CommentButton k="summary" title="Comment on the summary" /></div>
      <CommentSlot anchor={{ kind: 'summary' }} k="summary" />
      <div className="sec-list">
        {wt.sections.map((s) => {
          const open = sectionOpen[s.id] ?? false
          const k = anchorKey({ kind: 'section', sectionId: s.id })
          const done = reviewed.includes(s.id)
          return (
            <div key={s.id} className={'sec-item' + (open ? ' open' : '')} style={secStyle(wt.sections.indexOf(s))} data-gr-section={s.id} data-gr-reviewed={done ? 'true' : 'false'}>
              <div className="sec-item-head">
                <button className="sec-toggle" aria-expanded={open} onClick={() => setSectionOpen(s.id, !open)}>
                  <Icon name={open ? 'chevDown' : 'chevRight'} size={12} /><strong>{s.name}</strong>{s.desc && <span className="muted"> — {s.desc}</span>}
                </button>
                <span className="muted small nowrap">{plural(s.files.length, 'file')}</span>
                {done && <Icon name="check" size={14} className="tree-viewed" />}
              </div>
              {open && (
                <div className="sec-item-body">
                  {s.what && <Md text={s.what} />}
                  <Diagram section={s} />
                  <div className="row gap wrap">
                    {s.files.map((p) => <button key={p} className="ref-chip mono link-chip" onClick={() => focusAnchor({ kind: 'file', file: p })}>{p}</button>)}
                  </div>
                  <div className="row gap">
                    <label className={'viewed-box' + (done ? ' on' : '')}><input type="checkbox" name="gr-field" checked={done} onChange={() => void toggleSectionReviewed(s.id)} data-gr="section-reviewed" /> Reviewed</label>
                    <CommentButton k={k} title="Comment on this section" />
                  </div>
                  <CommentSlot anchor={{ kind: 'section', sectionId: s.id }} k={k} />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {wt.planMap && planSummary(wt.planMap) && <div className="plan-line"><Icon name="book" size={14} /> <button className="link" onClick={() => setTab('spec')}>Spec check</button>: {planSummary(wt.planMap)}</div>}
      <div className="desc-foot muted small">
        Walkthrough #{it?.n ?? 1} · written at <span className="mono">{short(loaded.state.reviewedAtSha)}</span>
        <span className="grow" />
        <input name="gr-field" value={steer} placeholder="Steer (optional)" onChange={(e) => setSteer(e.target.value)} aria-label="Steer" />
        <button className="btn sm" data-gr="generate" disabled={asking} onClick={() => ask(false)}>Ask for a fresh walkthrough</button>
      </div>
    </Box>
  )
}

/** how much of the first question a follow-up quotes in the timeline */
const FOLLOWS_QUOTE = 80
function MessageEntry({ m, request, answered }: { m: Message; request?: ReviewRequest; answered: boolean }) {
  // a follow-up names the question that opened its thread: in the timeline other entries can sit between the two
  const first = useStore((s) => (m.threadId ? s.loaded?.state.messages.find((x) => x.role === 'user' && x.requestId === m.threadId) : undefined))
  if (m.role === 'user') {
    const t = m.anchor ? focusable(m.anchor) : null
    return (
      <>
        <Box author="user" label={m.threadId ? 'asked a follow-up' : 'asked'} at={m.at} hook={{ 'data-gr-message': m.id }}>
          {m.anchor && <button className="ref-chip mono link-chip" disabled={!t} onClick={() => t && focusAnchor(t)}>{anchorLabel(m.anchor)}</button>}
          {first && <div className="muted small ask-follows" data-gr="follows">Follows <button className="link" title="Show the question that opened this thread" onClick={() => focusQuestion(first.requestId!)}>“{first.text.length > FOLLOWS_QUOTE ? first.text.slice(0, FOLLOWS_QUOTE).trimEnd() + '…' : first.text}”</button></div>}
          <div className="pre-wrap">{m.text}</div>
          {request && !answered && isOpen(request) && <Progress r={request} />}
          {request && !answered && request.status === 'failed' && <div className="flash-banner bad" data-gr="chat-error">Claude Code could not answer: {request.error ?? 'no reason given'}</div>}
          {request && !answered && request.status === 'cancelled' && <div className="muted small">Cancelled.</div>}
        </Box>
      </>
    )
  }
  const actions = m.actions ?? []
  return (
    <Box author="agent" label="answered" at={m.at} hook={{ 'data-gr-message': m.id }}>
      <Md text={m.text} />
      {actions.length > 0 && <div className="row gap wrap">{actions.map((a, i) => <ActionChip key={i} action={a} />)}</div>}
    </Box>
  )
}

function ConversationTab({ loaded }: { loaded: LoadedReview }) {
  useTick(30_000)
  const { request, addComment, setTab } = useStore.getState()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const st = loaded.state
  const byId = useMemo(() => new Map(st.requests.map((r) => [r.id, r])), [st.requests])
  const answered = useMemo(() => new Set(st.messages.filter((m) => m.role === 'agent' && m.requestId).map((m) => m.requestId!)), [st.messages])
  const shown = new Set(st.messages.filter((m) => m.role === 'user' && m.requestId).map((m) => m.requestId!))
  const entries: { at: string; key: string; node: ReactNode }[] = [
    ...st.messages.map((m) => ({ at: m.at, key: 'm' + m.id, node: <MessageEntry m={m} request={m.requestId ? byId.get(m.requestId) : undefined} answered={Boolean(m.requestId && answered.has(m.requestId))} /> })),
    ...st.requests.filter((r) => r.kind === 'question' && isOpen(r) && !shown.has(r.id)).map((r) => ({ at: r.createdAt, key: 'q' + r.id, node: <Box author="user" label="asked" at={r.createdAt}><div className="pre-wrap">{r.text}</div><Progress r={r} /></Box> })),
    ...st.requests.filter((r) => r.kind !== 'question').map((r) => ({
      at: r.createdAt, key: 'r' + r.id,
      node: (
        <>
          <Event icon={r.status === 'done' ? 'check' : r.status === 'failed' || r.status === 'cancelled' ? 'x' : 'circle'} at={r.createdAt}>
            You asked Claude Code to <strong>{requestTitle(r).replace(/^./, (c) => c.toLowerCase())}</strong>{r.text ? <span className="muted"> — “{r.text}”</span> : null}
            {r.status === 'done' && <span className="label resolved">Done</span>}{r.status === 'failed' && <span className="label bad" title={r.error}>Failed{r.error ? `: ${r.error}` : ''}</span>}{r.status === 'cancelled' && <span className="label">Cancelled</span>}
          </Event>
          {isOpen(r) && <div className="tl-indent"><Progress r={r} /></div>}
        </>
      )
    })),
    ...st.comments.filter(generalComment).map((c) => ({ at: c.createdAt, key: 'c' + c.id, node: <div className="tl-indent"><Thread c={c} showAnchor /></div> })),
    ...st.approvals.map((a, i) => ({ at: a.at, key: 'a' + i, node: <Event icon="check" at={a.at}>You approved <span className="mono">{short(a.sha)}</span>{a.hash !== a.sha ? ' with its uncommitted changes' : ''}</Event> })),
    ...st.iterations.slice(1).map((it) => ({ at: it.at, key: 'i' + it.n, node: <Event icon="book" at={it.at}>Claude wrote walkthrough #{it.n} at <span className="mono">{short(it.endSha)}</span></Event> }))
  ].sort((a, b) => a.at.localeCompare(b.at))
  const kept = loaded.files.filter((f) => !f.excluded)
  const count = (s: Comment['status']): number => st.comments.filter((c) => c.status === s).length
  const send = (kind: 'ask' | 'comment'): void => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    const p = kind === 'ask' ? request({ kind: 'question', text: body }).then(Boolean) : addComment({ kind: 'summary' }, body).then(Boolean)
    void p.then((ok) => { setBusy(false); if (ok) setText('') })
  }
  return (
    <div className="conv">
      <div className="timeline">
        <Description loaded={loaded} />
        <Decisions loaded={loaded} />
        {entries.map((e) => <div key={e.key}>{e.node}</div>)}
        <div className="tl-item user compose">
          <span className="avatar lg user" aria-hidden="true">Y</span>
          <div className="tl-box">
            <div className="tl-box-head"><strong>Ask or comment</strong></div>
            <div className="tl-box-body">
              <textarea name="gr-text" data-gr="chat-input" rows={4} value={text} placeholder="Ask Claude Code about this change, or leave a comment"
                onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send('ask') }} />
              <div className="row gap end wrap">
                <AwayHint />
                <button className="btn sm" disabled={!text.trim() || busy} onClick={() => send('comment')} title="Add a pending comment on the summary">Comment</button>
                <button className="btn sm primary" data-gr="chat-send" disabled={!text.trim() || busy} onClick={() => send('ask')} title="Delivered when Claude Code is listening; its answer appears here (⌘/Ctrl + Enter)">Ask Claude Code</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <aside className="conv-side" aria-label="Review details">
        <div className="side-block"><div className="side-title">Claude Code</div><PresenceDot presence={loaded.presence} /></div>
        <div className="side-block">
          <div className="side-title">Approval</div>
          <div>{loaded.approved ? 'This state is approved' : st.approvals.length ? 'Changed since approval' : 'Not approved'}</div>
          {st.approvals.slice().reverse().slice(0, 5).map((a, i) => <div key={i} className="muted small"><span className="mono">{short(a.sha)}</span>{a.hash === loaded.approvalHash ? ' · this state' : ''} · {ago(a.at)}</div>)}
        </div>
        <div className="side-block">
          <div className="side-title">Files viewed</div>
          <div>{kept.filter((f) => f.viewed === 'viewed').length} / {kept.length}</div>
          <div className="meter"><span style={{ width: `${kept.length ? (100 * kept.filter((f) => f.viewed === 'viewed').length) / kept.length : 0}%` }} /></div>
        </div>
        {loaded.artifacts.length > 0 && (
          <div className="side-block">
            <div className="side-title">Spec &amp; plan</div>
            {loaded.artifacts.map((a) => <button key={a.path} className="link block" data-gr-artifact={a.path} title={a.path} onClick={() => { useStore.getState().set({ docPath: a.path }); setTab('spec') }}>{a.title}</button>)}
          </div>
        )}
        <div className="side-block">
          <div className="side-title">Comments</div>
          {pendingThreads(st.comments).all.length > 0 && <div className="side-stat" data-gr="side-pending"><span>Pending</span><span>{pendingThreads(st.comments).all.length}</span></div>}
          {(['sent', 'answered', 'note', 'resolved', 'outdated'] as Comment['status'][]).filter((s) => count(s) > 0).map((s) => <div key={s} className="side-stat"><span>{s === 'note' ? 'Notes from Claude' : STATUS[s].text}</span><span>{count(s)}</span></div>)}
          {st.comments.length === 0 && <div className="muted">None yet</div>}
        </div>
      </aside>
    </div>
  )
}

// ── Commits ───────────────────────────────────────────────────
function CommitsTab({ loaded }: { loaded: LoadedReview }) {
  const since = loaded.since
  const cut = since?.moved ? loaded.commits.findIndex((c) => c.sha === since.sha) : -1
  return (
    <div className="commits">
      {loaded.commits.length === 0 && <div className="blankslate"><h3>No commits</h3><p className="muted">{loaded.dirty ? 'Only uncommitted changes are under review.' : 'Nothing separates the two sides.'}</p></div>}
      <div className="list-box">
        {loaded.commits.map((c, i) => (
          <div key={c.sha}>
            {i === cut && cut > 0 && <div className="list-divider">↑ New since the {since?.kind === 'approved' ? 'approved state' : 'walkthrough'}</div>}
            <div className="list-row" data-gr-commit={c.sha}>
              <div className="grow">
                <button className="link strong commit-link" title="Show only this commit's changes" onClick={() => { useStore.getState().setTab('files'); void useStore.getState().setView({ commit: c.sha }) }}>{c.subject}</button>
                <div className="muted small">{c.author} committed {ago(c.date)}</div>
              </div>
              <span className="ref-chip mono">{short(c.sha)}</span>
              <CopyButton text={c.sha} title="Copy the full SHA" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Spec & plan ───────────────────────────────────────────────
function DocLine({ path, n, text }: { path: string; n: number; text: string }) {
  const k = `artifact:${path}:${n}`
  const threads = useCommentsAt(k)
  const composing = useStore((s) => s.composer === k)
  const set = useStore((s) => s.set)
  const anchor: AnchorInput = { kind: 'artifact', path, line: n, expect: text }
  // drawn on the line only while the line still reads what the comment was written on
  const here = threads.filter((c) => !c.lineGone && (c.anchor.kind !== 'artifact' || !c.anchor.lineContent || c.anchor.lineContent === text))
  return (
    <div className="dr-wrap">
      <div className="dr doc" data-gr-docline={`${path}:${n}`}>
        <span className="ln ctx">{n}</span>
        <span className={'code ctx' + (/^#{1,6}\s/.test(text) ? ' heading' : '')}>
          <button className="add-line" title="Comment on this line" aria-label={`Comment on line ${n}`} onClick={() => set({ composer: k })}><Icon name="plus" size={12} /></button>
          <span className="sg" /><code>{text || ' '}</code>
        </span>
      </div>
      {(here.length > 0 || composing) && <div className="dr-threads">{here.map((c) => <Thread key={c.id} c={c} />)}{composing && <Composer anchor={anchor} k={k} />}</div>}
    </div>
  )
}
function PlanRow({ anchor, cls, label, children }: { anchor: AnchorInput; cls: string; label: string; children: ReactNode }) {
  const k = anchorKey(anchor)
  return (
    <li>
      <div className="plan-row"><span className={'label ' + cls}>{label}</span><span className="grow">{children}</span><CommentButton k={k} title="Comment on this" /></div>
      <CommentSlot anchor={anchor} k={k} />
    </li>
  )
}
function PlanCheck({ plan, sections }: { plan: PlanMap; sections: Section[] }) {
  const link = (id: string): ReactNode => {
    const s = sections.find((x) => x.id === id)
    return s ? <> <button className="link small" onClick={() => focusAnchor({ kind: 'section', sectionId: id })}>{s.name}</button></> : null
  }
  if (plan.acceptance.length + plan.steps.length + plan.deviations.length === 0) return null
  return (
    <div className="list-box plan" id="gr-plan" data-gr="plan">
      <div className="list-head"><span className="avatar agent sm" aria-hidden="true">C</span><strong>Checked against the spec and plan</strong></div>
      <ul className="plan-list">
        {plan.deviations.map((d, i) => <PlanRow key={'d' + i} anchor={{ kind: 'deviation', index: i }} cls="warn" label="Diverged">{d.text}{link(d.sectionId)}</PlanRow>)}
        {plan.acceptance.map((a, i) => <PlanRow key={'a' + i} anchor={{ kind: 'acceptance', index: i }} cls={a.met === true ? 'resolved' : a.met === 'partial' ? 'warn' : 'bad'} label={a.met === true ? 'Met' : a.met === 'partial' ? 'Partial' : 'Not met'}>{a.text}</PlanRow>)}
        {plan.steps.map((s) => <PlanRow key={'s' + s.n} anchor={{ kind: 'plan-step', stepN: s.n }} cls={s.status === 'done' ? 'resolved' : s.status === 'changed' ? 'warn' : 'bad'} label={s.status === 'done' ? 'Done' : s.status === 'changed' ? 'Changed' : 'Missing'}>{s.n}. {s.text}{link(s.sectionId)}</PlanRow>)}
      </ul>
    </div>
  )
}
function SpecTab({ loaded }: { loaded: LoadedReview }) {
  const docPath = useStore((s) => s.docPath)
  const { set, toggleArtifactApproval } = useStore.getState()
  const wt = loaded.state.walkthrough
  const art: Artifact | undefined = loaded.artifacts.find((a) => a.path === docPath) ?? loaded.artifacts[0]
  const approvedAt = art ? loaded.state.artifactApprovals[art.path] : undefined
  const gone = art ? loaded.state.comments.filter((c) => c.status !== 'outdated' && c.anchor.kind === 'artifact' && c.anchor.path === art.path && (
    c.lineGone || art.lines[c.anchor.line - 1] === undefined || (c.anchor.lineContent && art.lines[c.anchor.line - 1] !== c.anchor.lineContent)
  )) : []
  const stale = loaded.state.comments.filter((c) => c.status === 'outdated' && c.anchor.kind === 'artifact')
  return (
    <div className="spec">
      {wt?.planMap && <PlanCheck plan={wt.planMap} sections={wt.sections} />}
      {!art && <div className="blankslate"><h3>No spec or plan attached</h3><p className="muted">Claude Code can attach one with <span className="mono">gr artifact add</span>.</p></div>}
      {art && (
        <div className={'spec-layout' + (loaded.artifacts.length > 1 ? '' : ' single')}>
          {loaded.artifacts.length > 1 && (
            <aside className="tree-panel" aria-label="Spec and plan files">
              <div className="tree">
                {loaded.artifacts.map((a) => (
                  <button key={a.path} className={'tree-row leaf' + (a.path === art.path ? ' on' : '')} title={a.path} data-gr-artifact={a.path} onClick={() => set({ docPath: a.path })}>
                    <Icon name="book" /><span className="tree-name">{a.title}</span><span className="label">{a.role}</span>
                  </button>
                ))}
              </div>
            </aside>
          )}
          <div className="file open" data-gr="doc">
            <div className="file-head">
              <Icon name="book" /><span className="mono file-path">{art.path}</span><CopyButton text={art.path} title="Copy path" />
              <span className="label">{art.role}</span>
              <span className="grow" />
              <label className={'viewed-box' + (approvedAt ? ' on' : '')} title={approvedAt ? `Approved at ${short(approvedAt)}` : `Approve this ${art.role}`}>
                <input type="checkbox" name="gr-field" checked={Boolean(approvedAt)} onChange={() => void toggleArtifactApproval(art.path)} data-gr="approve-artifact" /> Approved{approvedAt ? ` at ${short(approvedAt)}` : ''}
              </label>
            </div>
            <div className="file-body">
              <div className="diff unified doc">{art.lines.map((text, i) => <DocLine key={i} path={art.path} n={i + 1} text={text} />)}</div>
              {(gone.length > 0 || stale.length > 0) && (
                <div className="unplaced" data-gr="line-gone">
                  <div className="unplaced-head">Outdated — written on lines that are no longer in the document</div>
                  {[...gone, ...stale].map((c) => <Thread key={c.id} c={c} showAnchor />)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── page ──────────────────────────────────────────────────────
export function Review() {
  const loaded = useStore((s) => s.loaded)
  const loading = useStore((s) => s.loading)
  const tab = useStore((s) => s.tab)
  // comments, plus the questions asked from a spot, which show at that spot too
  const index = useMemo(() => indexComments([...(loaded?.state.comments ?? []), ...askThreads(loaded?.state.messages ?? [])]), [loaded?.state.comments, loaded?.state.messages])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      const st = useStore.getState()
      if (e.key === 't' && st.tab === 'files') {
        e.preventDefault()
        if (!st.panelOpen) st.set({ panelOpen: true })
        // on a mid-width window an open section sits in the tree's place: closing it brings the tree back
        if (st.sectionPanel && window.matchMedia('(min-width: 760px) and (max-width: 1599px)').matches) showSection(null)
        window.setTimeout(() => document.getElementById('gr-file-filter')?.focus(), 30)
      } else if (e.key === 'c' && hoveredLine()) {
        e.preventDefault()
        st.set({ composer: hoveredLine() })
      } else if (e.key === 'Escape' && st.composer) st.set({ composer: null })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!loaded) {
    return (
      <div className="page" data-gr-screen="review">
        <TopBar crumbs={[]} />
        <main className="page-body">
          {loading ? <div className="blankslate"><span className="spinner" /> Loading the review…</div>
            : <div className="blankslate"><h3>This review could not be opened</h3><a href="#/">Back to the repositories</a></div>}
        </main>
      </div>
    )
  }
  const stale = loaded.state.comments.filter((c) => c.status === 'outdated' && c.anchor.kind === 'diff')
  return (
    <CommentsCtx.Provider value={index}>
      <div className="page review" data-gr-screen="review" data-gr-session={loaded.sessionId || undefined} data-gr-tab={tab}>
        <TopBar crumbs={[{ label: baseName(loaded.session.repo), href: routeHash({ name: 'hub', path: loaded.session.repo }) }, { label: 'reviews', href: routeHash({ name: 'hub', path: loaded.session.repo }) }]} />
        <RequestsStrip loaded={loaded} />
        <main className={'pr-body' + (tab === 'files' ? ' wide' : '')}>
          <PageHeader loaded={loaded} />
          <DriftBanner />
          <Tabs loaded={loaded} />
          {tab === 'files' && <FilesTab loaded={loaded} />}
          {tab === 'conversation' && <ConversationTab loaded={loaded} />}
          {tab === 'commits' && <CommitsTab loaded={loaded} />}
          {tab === 'spec' && <SpecTab loaded={loaded} />}
          {tab === 'visual' && <VisualTab loaded={loaded} />}
          {tab === 'files' && stale.length > 0 && (
            <div className="unplaced page-level" data-gr="outdated">
              <div className="unplaced-head">Outdated comments — the lines they were written on are gone</div>
              {stale.map((c) => <Thread key={c.id} c={c} showAnchor />)}
            </div>
          )}
        </main>
      </div>
    </CommentsCtx.Provider>
  )
}
