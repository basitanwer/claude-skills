import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import type {
  AnchorInput, Artifact, Comment, FactRow, FileDiff, FocusTarget, LoadedReview, Message, PlanMap, RefSide, ReviewRequest, Section, TourStop, UiAction
} from '@shared/types'
import { useStore, SHEET_BELOW, STACK_BELOW, TREE_BESIDE_GUIDE, treeWidthLimits, type Filters } from '../store'
import { focusAnchor, focusQuestion, followFiles, holdCodePlace, holdPlaces, liftHolds, liftPick, lowerPick, openSection, showIfOut, showPick, showSectionHeader, startTour, unparkCodePlace, type Lift } from '../focus'
import {
  ago, anchorKey, anchorLabel, askThreads, baseName, cssq, driftText, EFFORT, narrowingOf, EFFORT_LEVELS, effortTitle, elapsed, focusable, fromEarlier, hasPendingReply, indexComments, isOpen, isUnclaimed, pendingLabel,
  pendingThreads, plural, requestTitle, routeHash, secStyle, short, SIDE_KIND,
  PANES_SETTLED, pickKey, sinceActive, stuckReason, stuckText, symLabel, targetLabel, type CodePick, type DiffMode, type Guide, type Narrowing
} from '../util'
import { AwayHint, CopyButton, DiffStat, FileIcon, GuideCtx, Icon, Md, Menu, MenuItem, PresenceDot, ThemeToggle, currentTheme, setTheme, usePickLink } from '../components/common'
import { CommentButton, CommentSlot, CommentsCtx, Composer, STATUS, Thread, Who, useCommentsAt } from '../components/comments'
import { FileBox, hoveredLine } from '../components/diff'
import { VisualTab } from '../components/visual'
import { MdDoc, isMarkdown } from '../components/mdfile'
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
/** How the Guide pane and the Code pane share the window: side by side; stacked, the Guide
 *  on top and the code below it (a window under 1100px); or, at phone width (under 760px),
 *  the Guide with the code as a sheet that rises over its lower two thirds after a pick. */
type Layout = 'side' | 'stack' | 'sheet'
function useLayout(): Layout {
  const beside = useWide(STACK_BELOW)
  const stacked = useWide(SHEET_BELOW)
  return beside ? 'side' : stacked ? 'stack' : 'sheet'
}
/** How wide a pane is, as the widest of `steps` it reaches (0: none of them): what fits in
 *  a pane is decided by the pane's own width, since beside the other pane it has only a
 *  part of the window. Read when the pane is first drawn and whenever its size changes;
 *  the caller is drawn again only when a step is crossed. While the divider is being
 *  dragged the reading waits for its release, so the content of a pane is not laid out
 *  anew at every step of the drag. A pane that is hidden keeps its last width. */
function usePaneWidth(ref: RefObject<HTMLElement | null>, steps: readonly number[]): number {
  const stepOf = (w: number): number => steps.reduce((at, s) => (w >= s ? s : at), 0)
  const [step, setStep] = useState(() => stepOf(window.innerWidth))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => { const w = el.getBoundingClientRect().width; if (w > 0) setStep(stepOf(w)) }
    read()
    const ro = new ResizeObserver(() => { if (!el.closest('[data-dragging]')) read() })
    ro.observe(el)
    window.addEventListener(PANES_SETTLED, read)
    return () => { ro.disconnect(); window.removeEventListener(PANES_SETTLED, read) }
  }, [ref])       // eslint-disable-line react-hooks/exhaustive-deps
  return step
}
/** Whether a key press is the reviewer typing, or a shortcut of the browser's: the caret is
 *  in a text field (a tick box or a button is not one), or Ctrl, Alt or Cmd is held. The
 *  workspace's keys leave such a press alone. */
function typingKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true
  const el = e.target as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true
  return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test((el as HTMLInputElement).type)
}
/** Class names for a pane narrower than each of these widths (" lt760 lt1000"): the
 *  styles for a narrow pane hang on them, where they used to hang on the window's width. */
const below = (width: number, marks: number[]): string => marks.filter((m) => width < m).map((m) => ` lt${m}`).join('')
/** For a scroller that is hidden at times (a Guide while another is on show, a pane folded
 *  away): a box that is not drawn forgets how far it was scrolled in some browsers, so the
 *  position is noted while it is on show and put back when it returns. */
function useKeptScroll<T extends HTMLElement>(shown: boolean): { ref: RefObject<T | null>; onScroll: () => void; y: RefObject<number> } {
  const ref = useRef<T>(null)
  const y = useRef(0)
  useLayoutEffect(() => { if (shown && ref.current && ref.current.scrollTop !== y.current) ref.current.scrollTop = y.current }, [shown])
  return { ref, y, onScroll: () => { if (shown && ref.current) y.current = ref.current.scrollTop } }
}

// ── the top bar ───────────────────────────────────────────────
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

/** What the top bar holds back until it is asked for: the whole title with its comments,
 *  the comparison, the size of the change, the effort line and the commits (a click on one
 *  shows only that commit's changes in the Code pane). It stays in the page while it is
 *  closed, so that what the session and the browser checks look for in it (the effort
 *  level, the thread on the title) is always there to be found. An address of the Commits
 *  tab there once was opens it. */
function Details({ loaded, title }: { loaded: LoadedReview; title: string }) {
  const saved = useStore((s) => s.sessionId != null)
  const composing = useStore((s) => s.composer === 'title')
  const threads = useCommentsAt('title')
  const open = useStore((s) => s.detailsOpen)
  const setOpen = (detailsOpen: boolean): void => useStore.getState().set({ detailsOpen })
  const box = useRef<HTMLDivElement>(null)
  const { pair } = loaded.session
  const files = loaded.files.filter((f) => !f.excluded)
  // the commits made since the walkthrough was written, or since the approval, are marked off from the ones before
  const since = loaded.since
  const cut = since?.moved ? loaded.commits.findIndex((c) => c.sha === since.sha) : -1
  // a comment on the title is written, and read, in here
  useEffect(() => { if (composing) setOpen(true) }, [composing])       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('input, textarea'))) setOpen(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key) }
  }, [open])       // eslint-disable-line react-hooks/exhaustive-deps
  const showCommit = (sha: string): void => { setOpen(false); useStore.getState().revealCode(); void useStore.getState().setView({ commit: sha }) }
  return (
    <div className="menu" ref={box}>
      <button className="btn sm" aria-haspopup="true" aria-expanded={open} aria-controls="gr-details" data-gr="details" title="The comparison, the commits, the effort and the size of this change" onClick={() => setOpen(!open)}>
        Details{threads.length > 0 && <span className="counter" title={`${plural(threads.length, 'comment')} on the title`}>{threads.length}</span>}<Icon name="chevDown" size={12} />
      </button>
      <div className="menu-pop left details-pop" id="gr-details" hidden={!open} role="group" aria-label="About this review" data-gr="details-pop">
        <div className="details-body">
          <div className="pr-title-row">
            <h2>{title}{saved && <span className="pr-num"> #{loaded.sessionId}</span>}</h2>
            <CommentButton k="title" title="Comment on the title" />
          </div>
          <CommentSlot anchor={{ kind: 'title' }} k="title" />
          <div className="pr-compare">
            Comparing <RefChip side={pair.base} /> ← <RefChip side={pair.compare} sha={loaded.headSha} />
            <CopyButton text={pair.compare.kind === 'commit' ? pair.compare.anchorSha : pair.compare.symbol} title="Copy the compare ref" />
            {loaded.session.direct && <span className="label" title="The two endpoints are compared as they are, not from their merge-base">endpoints</span>}
            {loaded.dirty && <span className="label warn" title="The working tree has uncommitted changes; they are part of this review">uncommitted changes</span>}
          </div>
          <div className="details-size" data-gr="diff-totals">
            <span>{plural(files.length, 'file')} changed</span>
            <DiffStat add={files.reduce((a, f) => a + f.add, 0)} del={files.reduce((a, f) => a + f.del, 0)} />
          </div>
          <EffortLine loaded={loaded} />
        </div>
        <div className="pop-head">{loaded.commits.length ? plural(loaded.commits.length, 'commit') : 'No commits'}</div>
        {loaded.commits.map((c, i) => (
          <Fragment key={c.sha}>
            {i === cut && cut > 0 && <div className="list-divider">↑ New since the {since?.kind === 'approved' ? 'approved state' : 'walkthrough'}</div>}
            <button className="menu-item commit-item" data-gr-commit={c.sha} data-gr-details-commit={c.sha} aria-current={loaded.view?.commit === c.sha ? 'true' : undefined} title="Show only this commit's changes in the Code pane" onClick={() => showCommit(c.sha)}>
              <span className="menu-check">{loaded.view?.commit === c.sha ? <Icon name="check" size={14} /> : null}</span>
              <span className="grow"><span className="clip strong">{c.subject}</span><span className="muted small"><span className="mono">{short(c.sha)}</span> · {c.author} · {ago(c.date)}</span></span>
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** The top bar: the one slim bar that is always in view. The title (cut short; whole on
 *  hover and in Details), the state of the review, what Details opens, Claude Code's
 *  presence, the comments, Review and the theme. */
function ReviewBar({ loaded }: { loaded: LoadedReview }) {
  const saved = useStore((s) => s.sessionId != null)
  const { pair } = loaded.session
  const st = reviewState(loaded, saved)
  const title = loaded.state.walkthrough?.title || `${symLabel(pair.compare.symbol)} against ${symLabel(pair.base.symbol)}`
  const hub = routeHash({ name: 'hub', path: loaded.session.repo })
  return (
    <header className="topbar slim" data-gr="top-bar">
      <a className="brand" href="#/" title="All repositories"><span className="brand-mark" aria-hidden="true" /></a>
      <nav className="crumbs" aria-label="Breadcrumb">
        <a className="strong" href={hub} title={`${loaded.session.repo} — its reviews`}>{baseName(loaded.session.repo)}</a>
        <span className="crumb-more"><span className="muted crumb-sep">/</span><a href={hub}>reviews</a></span>
        <span className="muted crumb-sep">/</span>
      </nav>
      <h1 className="bar-title" data-gr="title" title={`${title}${saved ? ` #${loaded.sessionId}` : ''}`}><span className="clip">{title}</span>{saved && <span className="pr-num"> #{loaded.sessionId}</span>}</h1>
      <span className={'state ' + st.cls} data-gr="state" data-gr-state={st.cls} title={st.text}><Icon name={st.cls === 'approved' ? 'check' : 'pr'} size={14} />{st.text}</span>
      <Details loaded={loaded} title={title} />
      <span className="grow" />
      <PresenceDot presence={loaded.presence} />
      <CommentsMenu loaded={loaded} />
      <ReviewMenu loaded={loaded} />
      <ThemeToggle />
    </header>
  )
}

/** What has to be said across the whole workspace: a side of the comparison that no
 *  longer resolves, code that changed since the page loaded it. */
function Banners({ loaded }: { loaded: LoadedReview }) {
  const saved = useStore((s) => s.sessionId != null)
  const retarget = useStore((s) => s.retarget)
  const [ref, setRef] = useState('')
  return (
    <div className="ws-banners">
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
      <DriftBanner />
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

/** What Claude Code has been asked and has not finished: one compact row each, under the top bar whatever is on show. */
function RequestsStrip({ loaded }: { loaded: LoadedReview }) {
  useTick(loaded.state.requests.some(isOpen) ? 1000 : 30_000)
  const dismissed = useStore((s) => s.dismissed)
  const { cancelRequest, dismissRequest, retryRequest, showGuide } = useStore.getState()
  const away = loaded.presence === 'away'
  const rows = loaded.state.requests.filter((r) => isOpen(r) || (r.status === 'failed' && !dismissed.includes(r.id) && Date.now() - Date.parse(r.finishedAt ?? r.createdAt) < 600_000))
  if (rows.length === 0) return null
  return (
    <div className="req-strip" data-gr="requests">
      {rows.map((r) => {
        const stuck = stuckReason(r, away)
        const why = stuck && stuckText(r, stuck)
        return (
          <div key={r.id} className={'req-row ' + r.status} data-gr-request={r.id} data-gr-request-kind={r.kind} data-gr-request-status={r.status}>
            {isOpen(r) ? <span className="spinner" /> : <Icon name="x" size={14} />}
            <button className="link strong" onClick={() => showGuide(r.kind === 'visualize' ? 'visual' : 'conversation')}>{requestTitle(r)}</button>
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

// ── the Guide row ─────────────────────────────────────────────
const generalComment = (c: Comment): boolean => ['summary', 'title', 'section', 'plan-step', 'acceptance', 'deviation'].includes(c.anchor.kind)

/** The row that names the Guides and switches between them: Walkthrough, Visualize,
 *  Conversation, Spec & plan. It sits on top of
 *  the Guide pane; while that pane is closed it sits on top of the Code pane, where it is
 *  the way to open one. Clicking the name of the Guide on show closes the Guide pane.
 *  `layout`: how the two panes share the window. */
function GuideRow({ loaded, layout }: { loaded: LoadedReview; layout: Layout }) {
  const guide = useStore((s) => s.guide)
  const front = useStore((s) => s.front)
  const guideWide = useStore((s) => s.guideWide)
  const codeWide = useStore((s) => s.codeWide)
  const wsOnly = useStore((s) => s.wsOnly)
  const { showGuide, set } = useStore.getState()
  const files = [...loaded.files, ...wsOnly.filter((f) => !loaded.files.some((x) => x.path === f.path))].filter((f) => !f.excluded)
  const conv = loaded.state.messages.length + loaded.state.comments.filter(generalComment).length
  const hasSpec = loaded.artifacts.length > 0 || Boolean(loaded.state.walkthrough?.planMap)
  const items: { id: Guide; label: string; icon: string; n: number }[] = [
    { id: 'walkthrough', label: 'Walkthrough', icon: 'list', n: loaded.state.walkthrough?.sections.length ?? 0 },
    { id: 'visual', label: 'Visualize', icon: 'graph', n: loaded.state.visual?.views.length ?? 0 },
    { id: 'conversation', label: 'Conversation', icon: 'comment', n: conv },
    ...(hasSpec ? [{ id: 'spec' as Guide, label: 'Spec & plan', icon: 'book', n: loaded.artifacts.length }] : [])
  ]
  // where the panes are stacked the code can have the whole height, the Guide folded away behind it: its name brings it back
  const stacked = layout === 'stack'
  const behind = stacked && codeWide
  const widen = (): void => { const hold = holdPlaces(); set({ guideWide: !guideWide, codeWide: false }); hold.settle() }
  const whole = stacked ? 'height' : 'width'
  return (
    <div className="tabs-row guide-row" data-gr="guide-row">
      <nav className="tabs" role="tablist" aria-label="Guides">
        {items.map((t) => {
          const on = guide === t.id
          return (
            <button
              key={t.id} role="tab" aria-selected={on} aria-label={`${t.label}, ${t.n}`} className={'tab' + (on ? ' on' : '')} data-gr-tab={t.id}
              title={on ? (behind ? `Back to ${t.label}` : `${t.label} — click again to close the Guide pane`) : `${t.label}, beside the code`}
              onClick={() => showGuide(on && !behind ? null : t.id)}
            >
              <Icon name={t.icon} /><span className="tab-label">{t.label}</span><span className="counter">{t.n}</span>
            </button>
          )
        })}
      </nav>
      <span className="grow" />
      {guide == null && <DiffStat add={files.reduce((a, f) => a + f.add, 0)} del={files.reduce((a, f) => a + f.del, 0)} />}
      {/* the way to the code, or back to both panes: on a phone-width window the code is a sheet, raised from here while nothing is picked;
          a pane that has the whole height of a stacked window names the one to bring back */}
      {guide != null && (layout === 'sheet'
        ? front !== 'code' && <button className="btn sm" data-gr="guide-to-code" title="Show the code, in a sheet over the lower part of this (the Guide stays as it is)" onClick={() => set({ front: 'code' })}><Icon name="file" size={14} />Code</button>
        : behind
          ? <button className="btn sm" data-gr="guide-back" title="Show the Guide above the code again" onClick={() => showGuide(guide)}><Icon name={items.find((t) => t.id === guide)?.icon ?? 'list'} size={14} />Guide</button>
          : stacked && guideWide
            ? <button className="btn sm" aria-pressed data-gr="guide-wide" title="Show the code below this again" onClick={widen}><Icon name="file" size={14} />Code</button>
            : (
              <button className="icon-btn" aria-pressed={guideWide} data-gr="guide-wide" title={guideWide ? 'Show the code beside this again' : `Give this the whole ${whole} (the code comes back with a jump to it)`} aria-label={guideWide ? 'Show the Code pane again' : `Give the Guide pane the whole ${whole}`} onClick={widen}>
                <Icon name={guideWide ? 'columns' : 'expand'} />
              </button>
            ))}
      {guide != null && <button className="icon-btn" data-gr="guide-close" data-gr-tab="files" title="Close the Guide pane: the code alone" aria-label="Close the Guide pane" onClick={() => showGuide(null)}><Icon name="x" /></button>}
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

/** A comment chosen in the top bar's menu. One on code is a pick of its file and line: the
 *  Code pane is narrowed to that file and taken to the line, in one step of the trail, so
 *  Back returns to what was on show. With the Guide pane closed there is no narrowing: the
 *  step is made all the same, and the code goes to the line among all the files. One on the
 *  summary or on a section shows it in the Walkthrough, as any jump there does. */
function showComment(t: FocusTarget): void {
  if (t.kind !== 'file' && t.kind !== 'diff') { focusAnchor(t); return }
  const st = useStore.getState()
  const pick: CodePick = t.kind === 'file' ? { file: t.file } : { file: t.file, side: t.side, line: t.line }
  if (st.guide == null) { st.pickCode(pick); focusAnchor(t) }
  // (a file that is not part of the comparison cannot be a pick: it is shown as before)
  else if (!showPick(pick)) focusAnchor(t)
}

function CommentsMenu({ loaded }: { loaded: LoadedReview }) {
  const showGuide = useStore((s) => s.showGuide)
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
                  <button key={c.id} className="pop-item col" onClick={() => { close(); if (t) showComment(t); else showGuide(c.anchor.kind === 'artifact' ? 'spec' : 'conversation') }}>
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

// ── the Code pane (Files changed) ─────────────────────────────
/** What the tree panel takes of the workspace beside its own width: its padding (px). */
const TREE_PAD = 26
/** The widths of the Code pane at which what it holds changes: a file's header on one line
 *  (520), the narrow layout of a diff (760), a Markdown file's header on one line (1200). */
const CODE_STEPS = [520, 760, 1200] as const
/** Beside a Guide a diff is split by the room its own column has: never split under 700px,
 *  split unless the reviewer chose otherwise from 900px. */
const FILES_STEPS = [700, 900] as const
/** Drag (or arrow keys) to resize the tree panel; double-click resets it. The panel is on
 *  the right and the handle on its left edge: dragging left makes it wider. */
function ResizeHandle({ width, onChange }: { width: number; onChange: (px: number | null) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const down = (e: RPointerEvent<HTMLDivElement>): void => { drag.current = { x: e.clientX, w: width }; try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* a pointer the browser does not know */ } }
  const move = (e: RPointerEvent<HTMLDivElement>): void => { if (drag.current) onChange(drag.current.w - (e.clientX - drag.current.x)) }
  const up = (): void => { drag.current = null }
  const key = (e: RKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onChange(width + (e.key === 'ArrowLeft' ? 20 : -20)) }
    else if (e.key === 'Home') onChange(null)
  }
  return (
    <div
      className="resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize the tree panel" tabIndex={0} data-gr="tree-resize"
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
 *  says so of the file under the top of the Code pane. When the mark lands on a row of the
 *  file tree, the tree scrolls itself just enough to show it — never the code, which a
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
/** The files of the pick, for the tree to mark. */
const PickedCtx = createContext<Set<string>>(new Set())
function TreeFile({ file, depth, comments, showDir, nested }: { file: FileDiff; depth: number; comments: number; showDir?: boolean; nested?: boolean }) {
  const sec = useContext(SectionsCtx).get(file.path)
  const picked = useContext(PickedCtx).has(file.path)
  const { ref, here } = useHere<HTMLButtonElement>((f) => f === file.path)
  // a click in the tree leaves the narrowing: all the files, at this one (and a tree that was opened over the code gives way to it)
  const go = (): void => { useStore.getState().set({ treeOver: false }); focusAnchor({ kind: 'file', file: file.path }, { top: true, all: true }) }
  return (
    <button ref={ref} className={'tree-row leaf' + (sec ? ' in-sec' : '') + (here ? ' here' : '') + (picked ? ' picked' : '')} aria-current={here ? 'true' : undefined} style={{ paddingLeft: `${8 + depth * TREE_STEP}px`, ...(sec ? secStyle(sec.no) : {}) }} title={`${file.path} (${file.status})${sec ? ` · ${sec.section.name}` : ''}${picked ? ' · part of the pick' : ''}`} data-gr-tree-file={file.path} data-gr-status={file.status} data-gr-picked={picked ? 'true' : undefined} onClick={go}>
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
  const picks = useContext(PickedCtx)
  const picked = !open && [...picks].some((f) => f.startsWith(node.path + '/'))
  return (
    <>
      <button ref={ref} className={'tree-row dir' + (here ? ' here' : '') + (picked ? ' picked' : '')} aria-current={here ? 'true' : undefined} style={{ paddingLeft: `${8 + depth * TREE_STEP}px` }} aria-expanded={open} title={node.path} data-gr-dir={node.path} onClick={() => toggle(node.path)}>
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
  // while the Walkthrough is on show the section's thread is written and read there: one place for it, not two
  const inGuide = useStore((s) => s.guide === 'walkthrough')
  return (
    <div className="sec-head" style={secStyle(no)} data-gr-section={section.id} data-gr-reviewed={reviewed ? 'true' : 'false'}>
      <div className="sec-title-row">
        <span className="sec-dot" />
        <h3>{section.name}</h3>
        <span className="muted small">{plural(files.length, 'file')}</span>
        <span className="grow" />
        {inGuide ? <button className="link small" title="Open this section in the Walkthrough" onClick={() => openSection(section.id)}>In the Walkthrough</button> : <CommentButton k={k} title="Comment on this section" />}
        <label className={'viewed-box' + (reviewed ? ' on' : '')}><input type="checkbox" name="gr-field" checked={reviewed} onChange={() => void toggle(section.id)} data-gr="section-reviewed" /> Reviewed</label>
      </div>
      {section.desc && <div className="sec-desc">{section.desc}</div>}
      {section.what && <Md text={section.what} />}
      <Diagram section={section} />
      {!inGuide && <CommentSlot anchor={{ kind: 'section', sectionId: section.id }} k={k} />}
    </div>
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

/** The files of the change as the Code pane and the tree panel both need them: what is
 *  left by the filters and the "changes" view, the tree of them, each file's section. */
function useFiles(loaded: LoadedReview) {
  const mode = useStore((s) => s.diffMode)
  const filters = useStore((s) => s.filters)
  const query = useStore((s) => s.fileQuery)
  const treeView = useStore((s) => s.treeView)
  const wsOnly = useStore((s) => s.wsOnly)
  const commitView = loaded.view?.commit
  const wt = loaded.state.walkthrough
  const showSince = sinceActive(loaded)
  const anyViewed = Object.keys(loaded.state.viewedAt).length > 0
  const eff: DiffMode = commitView || (mode === 'since' && !showSince) || (mode === 'viewed' && !anyViewed) ? 'all' : mode
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
  /** files in the groups and the order they are shown in: by section, or as the tree or the list has them */
  const group = (files: FileDiff[], of: DirNode = buildTree(files)): { section: Section | null; files: FileDiff[] }[] => (bySection
    ? [
        ...(wt?.sections ?? []).map((s) => ({ section: s, files: s.files.map((p) => files.find((f) => f.path === p)).filter((f): f is FileDiff => Boolean(f)) })),
        { section: null, files: files.filter((f) => !sectionOf.has(f.path)) }
      ].filter((g) => g.files.length > 0)
    : [{ section: null, files: treeView === 'tree' ? treeOrder(of) : files }])
  return { wt, eff, commitView, showSince, anyViewed, counts, sectionOf, sections, sectionNo, wsPaths, kept, excluded, visible, tree, bySection, treeView, group, groups: group(visible, tree) }
}

/** Where the tree panel is. It is the bird's-eye view of the change, on the far right:
 *  a column of its own wherever it has room (always while the code has the window to
 *  itself; beside a Guide on a wide window, or when the reviewer pinned it), and otherwise
 *  folded, to be opened over the files when it is asked for. */
function useTreePlace(): { room: boolean; column: boolean; over: boolean; all: boolean; canPin: boolean } {
  const guide = useStore((s) => s.guide != null)
  const panelOpen = useStore((s) => s.panelOpen)
  const pinned = useStore((s) => s.treePinned)
  const treeOver = useStore((s) => s.treeOver)
  const medium = useWide(SHEET_BELOW)
  const beside = useWide(STACK_BELOW)
  const big = useWide(TREE_BESIDE_GUIDE)
  // (the same rule as the store's `treeHasRoom`: no column beside panes that are stacked, pinned or not)
  const room = medium && (!guide || (beside && (big || pinned)))
  const column = panelOpen && room
  // `all`: with no column of its own it lies over the whole workspace (stacked panes, or
  // the Guide and the sheet), not over the files only
  return { room, column, over: treeOver && !column, all: guide && !beside, canPin: guide && beside && !big }
}

/** the last "open the tree at this folder" that the tree panel carried out */
let shownAt = 0
/** The tree panel: the changed files as a tree (or a list, or grouped by walkthrough
 *  section), with the filter. It marks the file under the reviewer's eyes and the files of
 *  the pick. A click on a file shows it among all the files. `over`: it has no column of
 *  its own and lies over the files (under the Code pane's toolbar and path bar, which stay
 *  in reach; over both panes where they are stacked, and over the Guide and the sheet)
 *  until a file is clicked in it, a pick is made, Esc, or a click elsewhere. */
function TreePanel({ loaded, over }: { loaded: LoadedReview; over: boolean }) {
  const F = useFiles(loaded)
  const filters = useStore((s) => s.filters)
  const query = useStore((s) => s.fileQuery)
  const treeWidth = useStore((s) => s.treeWidth)
  const closedDirs = useStore((s) => s.closedDirs)
  const treeAt = useStore((s) => s.treeAt)
  const pinned = useStore((s) => s.treePinned)
  const reviewed = useStore((s) => s.reviewedSections)
  const pick = useStore((s) => s.pick)
  const place = useTreePlace()
  const { set, setFilters, setTreeWidth, setTreePinned } = useStore.getState()
  const picked = useMemo(() => new Set(narrowingOf(pick, loaded)?.files ?? []), [pick, loaded])
  const closed = useMemo(() => new Set(closedDirs), [closedDirs])
  const toggleDir = (p: string): void => set({ closedDirs: closed.has(p) ? closedDirs.filter((x) => x !== p) : [...closedDirs, p] })
  const box = useRef<HTMLElement>(null)
  /** Resize the column. Beside a Guide the tree is made wider at the code's cost only: it
   *  stops growing where the Code pane is at its least width, so the Guide (a diagram is
   *  laid out for its width) is not squeezed by it. Narrower is always possible. */
  const resize = (px: number | null): void => {
    const frame = box.current?.parentElement
    const beside = frame?.querySelector<HTMLElement>(':scope > [data-gr-pane="guide"]:not([hidden])')
    if (!frame || !beside) { setTreeWidth(px); return }
    const most = Math.max(treeWidth, frame.clientWidth - beside.offsetWidth - PANE_MIN.bar - PANE_MIN.code - TREE_PAD)
    const want = px ?? treeWidthLimits.def
    setTreeWidth(px == null && want <= most ? null : Math.min(want, most))
  }
  // Opened at a folder (from the path bar): unfold down to it, bring its row into view and
  // flash it. A chain of folders with one child each is one row: the row that holds the
  // folder stands for it. Where there are no folder rows (a list, or grouped by section),
  // the first file under it does.
  const at = treeAt?.seq
  useEffect(() => {
    const asked = useStore.getState().treeAt
    // (the panel is drawn anew each time it is shown: a folder it was opened at before is not shown off again)
    if (!asked || asked.seq === shownAt) return
    shownAt = asked.seq
    const dir = asked.dir
    const chain: string[] = []
    for (let node = F.tree; ;) {
      const next = node.dirs.find((d) => d.path === dir || d.path.startsWith(dir + '/') || dir.startsWith(d.path + '/'))
      if (!next) break
      chain.push(next.path)
      if (!dir.startsWith(next.path + '/')) break
      node = next
    }
    const folded = useStore.getState().closedDirs
    if (chain.some((x) => folded.includes(x))) set({ closedDirs: folded.filter((x) => !chain.includes(x)) })
    const t = window.setTimeout(() => {
      const list = box.current?.querySelector<HTMLElement>('.tree')
      const row = (chain.length ? list?.querySelector<HTMLElement>(`[data-gr-dir="${cssq(chain[chain.length - 1])}"]`) : null) ?? list?.querySelector<HTMLElement>(`[data-gr-tree-file^="${cssq(dir)}/"]`)
      if (!list || !row) return
      list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 8
      row.classList.remove('gr-flash')
      void row.offsetWidth
      row.classList.add('gr-flash')
      window.setTimeout(() => row.classList.remove('gr-flash'), 1000)
    }, 60)
    return () => window.clearTimeout(t)
  }, [at])       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!over) return
    const shut = (): void => set({ treeOver: false })
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') shut() }
    // (the toggle and the path bar open and close it themselves)
    const off = (e: MouseEvent): void => { if (e.target instanceof Element && !box.current?.contains(e.target) && !e.target.closest('[data-gr="tree-toggle"], [data-gr="path-bar"], .menu-pop')) shut() }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', off)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', off) }
  }, [over, set])
  return (
    <PickedCtx.Provider value={picked}>
    <SectionsCtx.Provider value={F.bySection ? NO_SECTIONS : F.sections}>
      <aside className={'tree-panel' + (over ? ' over' : '')} ref={box} style={{ '--tree-w': `${treeWidth}px` } as React.CSSProperties} aria-label="Files" data-gr="files-view" data-gr-files-view={F.bySection ? 'sections' : F.treeView} data-gr-tree={over ? 'over' : 'column'}>
        {!over && <ResizeHandle width={treeWidth} onChange={resize} />}
        <div className="tree-filter">
          <span className="filter-input"><Icon name="search" size={14} /><input id="gr-file-filter" name="gr-field" value={query} placeholder="Filter files…" aria-label="Filter files" onChange={(e) => set({ fileQuery: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape' && !over) { if (query) set({ fileQuery: '' }); else e.currentTarget.blur() } }} /></span>
          <Menu label={<Icon name="filter" />} className="btn sm icon" align="right" hook="file-filters" title="Filter options">
            {(close) => (
              <>
                {(['hideViewed', 'onlyCommented', 'bySection', 'showExcluded'] as (keyof Filters)[]).map((k) => (
                  <MenuItem key={k} checked={filters[k]} disabled={(k === 'bySection' && !F.wt) || (k === 'showExcluded' && F.excluded.length === 0)} onClick={() => { setFilters({ [k]: !filters[k] }); close() }}>
                    {k === 'hideViewed' ? 'Hide viewed files' : k === 'onlyCommented' ? 'Only files with comments' : k === 'bySection' ? 'Group by walkthrough section' : `Show untracked files left out${F.excluded.length ? ` (${F.excluded.length})` : ''}`}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
          {(place.canPin || over) && (
            <button className={'btn sm icon' + (pinned && !over ? ' selected' : '')} aria-pressed={pinned && !over} data-gr="tree-pin" title={pinned && !over ? 'Unpin: the tree folds away while a Guide is open on a window this size' : 'Pin: keep the tree as a column beside the code'} aria-label={pinned && !over ? 'Unpin the tree panel' : 'Pin the tree panel'} disabled={over && !place.canPin} onClick={() => setTreePinned(!(pinned && !over))}>
              <Icon name="pin" />
            </button>
          )}
          {over && <button className="icon-btn" title="Close (Esc)" aria-label="Close the tree" data-gr="tree-close" onClick={() => set({ treeOver: false })}><Icon name="x" /></button>}
        </div>
        <div className="tree">
          {F.visible.length === 0 && <div className="pop-note">No files match.</div>}
          {F.bySection
            ? F.groups.map((g) => (
                <div key={g.section?.id ?? '-'} style={g.section ? secStyle(F.sectionNo(g.section)) : undefined}>
                  <button className="tree-row dir sec" title={g.section?.desc} data-gr-tree-section={g.section?.id} data-gr-reviewed={g.section && reviewed.includes(g.section.id) ? 'true' : 'false'} onClick={() => { if (g.section) showSectionHeader(g.section.id) }}>
                    {g.section && <span className="sec-dot" />}<span className="tree-name">{g.section?.name ?? 'Not in the walkthrough'}</span>
                    {g.section && reviewed.includes(g.section.id) && <span className="sec-tick" role="img" aria-label="Reviewed" title="You marked this section reviewed"><Icon name="check" size={12} /></span>}
                    <span className="muted small">{g.files.length}</span>
                  </button>
                  {g.files.map((f) => <TreeFile key={f.path} file={f} depth={1} comments={F.counts.get(f.path) ?? 0} showDir />)}
                </div>
              ))
            : F.treeView === 'tree'
              ? <>{F.tree.dirs.map((d) => <TreeDir key={d.path} node={d} depth={0} closed={closed} toggle={toggleDir} counts={F.counts} />)}{F.tree.files.map((f) => <TreeFile key={f.path} file={f} depth={0} comments={F.counts.get(f.path) ?? 0} nested />)}</>
              : F.visible.map((f) => <TreeFile key={f.path} file={f} depth={0} comments={F.counts.get(f.path) ?? 0} showDir />)}
        </div>
      </aside>
    </SectionsCtx.Provider>
    </PickedCtx.Provider>
  )
}

/** The path bar: where the file under the reviewer's eyes lives, folder by folder, in its
 *  walkthrough section's colour. It follows the Code pane as it scrolls, so "where am I"
 *  can be read while the tree is folded away; a click on a folder opens the tree at it. */
function PathBar({ sections, onDir }: { sections: SectionMap; onDir: (dir: string) => void }) {
  const file = useStore((s) => s.currentFile)
  if (!file) return <nav className="path-bar" aria-label="Where this file is" data-gr="path-bar" />
  const parts = file.split('/')
  const name = parts.pop() ?? file
  const dirs = parts.map((d, i) => ({ name: d, path: parts.slice(0, i + 1).join('/') }))
  // a long path keeps its ends: its first folder and its last two
  const shown: ({ name: string; path: string; title?: string })[] = dirs.length > 4
    ? [dirs[0], { name: '…', path: dirs[dirs.length - 3].path, title: dirs.slice(1, -2).map((d) => d.name).join(' / ') }, ...dirs.slice(-2)]
    : dirs
  const sec = sections.get(file)
  return (
    <nav className={'path-bar' + (sec ? ' in-sec' : '')} style={sec ? secStyle(sec.no) : undefined} aria-label="Where this file is" data-gr="path-bar" data-gr-path={file} title={sec ? `${file} · ${sec.section.name}` : file}>
      {sec && <span className="sec-dot" />}
      {shown.map((d) => (
        <Fragment key={d.name + d.path}>
          <button className="path-dir" data-gr-path-dir={d.path} title={`${d.title ? `${d.title} — ` : ''}Open the tree at ${d.path}/`} onClick={() => onDir(d.path)}>{d.name}</button>
          <span className="path-sep" aria-hidden="true">/</span>
        </Fragment>
      ))}
      <span className="path-file" data-gr-path-file={file}><FileIcon path={file} size={14} />{name}</span>
    </nav>
  )
}

/** What the Code pane is showing beside a Guide, in words, with the way to the rest: the
 *  pick's code only ("Show all files"), the list of changed files while nothing is picked,
 *  or all the files (and the way back to the pick, or to the list). */
function NarrowChip({ show, to, count, hidden, onClear }: {
  show: 'all' | 'pick' | 'list'; to: Narrowing | null; count: number
  /** a filter leaves the pick's own file out of "all the files": it is lifted on the way there */
  hidden: boolean; onClear: () => void
}) {
  const { showAllFiles } = useStore.getState()
  // (the files that were hidden come in above the line being read: it is held where it is)
  const all = (): void => { const hold = holdCodePlace(); if (hidden) onClear(); showAllFiles(true); hold.settle() }
  return (
    <span className="narrowing" data-gr="narrowing" data-gr-narrowing={show}>
      {show === 'pick' && to && <><span className="muted">Showing</span><strong className="clip">{to.label}</strong><button className="link" data-gr="show-all" title="Leave the pick: all the changed files, at this one. The pick stays outlined in the Guide." onClick={all}>Show all files</button></>}
      {show === 'list' && <><span className="muted">{plural(count, 'changed file')}: pick one, or something in the Guide</span><button className="link" data-gr="show-all" onClick={all}>Show all files</button></>}
      {show === 'all' && <><strong>All files</strong>{to
        ? <button className="link clip" data-gr="show-pick" title="Back to the pick's code only" onClick={() => showPick(useStore.getState().pick)}>Only {to.label}</button>
        : <button className="link" data-gr="show-list" title="Back to the list of changed files" onClick={() => showAllFiles(false)}>List the files</button>}</>}
    </span>
  )
}

/** The changed files as a list: what the Code pane shows beside a Guide while nothing is
 *  picked. A click on one shows that file (a pick, so Back returns to the list). */
function FileList({ files, counts }: { files: FileDiff[]; counts: Map<string, number> }) {
  return (
    <div className="list-box file-list" data-gr="file-list">
      {files.length === 0 && <div className="pop-note">No files match.</div>}
      {files.map((f) => (
        <button key={f.path} className="list-row file-row" data-gr-list-file={f.path} data-gr-viewed={f.viewed === 'viewed' ? 'true' : f.viewed === 'changed' ? 'changed' : 'false'} title={`Show ${f.path}`} onClick={() => showPick({ file: f.path })}>
          <FileIcon path={f.path} />
          <span className="grow file-row-name"><span className={'strong' + (f.status === 'deleted' ? ' gone' : '')}>{baseName(f.path)}</span>{f.path.includes('/') && <span className="muted small mono"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}</span>
          {STATUS_MARK[f.status] && <span className={'tree-status st-' + f.status}>{STATUS_MARK[f.status]}</span>}
          {(counts.get(f.path) ?? 0) > 0 && <span className="tree-dot" title={plural(counts.get(f.path) ?? 0, 'comment')}>{counts.get(f.path)}</span>}
          <DiffStat add={f.add} del={f.del} />
          <span className="file-row-viewed" title={f.viewed === 'viewed' ? 'Viewed' : f.viewed === 'changed' ? 'Changed since last view' : 'Not viewed yet'}>{f.viewed === 'viewed' ? <Icon name="check" size={14} className="tree-viewed" /> : f.viewed === 'changed' ? <span className="tree-changed" /> : null}</span>
        </button>
      ))}
    </div>
  )
}

/** What the Code pane holds: the diff. On top its toolbar, then the path bar with what is
 *  being shown; under them the files. The column of files is the Code pane's scroller:
 *  every jump to code moves it, and nothing else.
 *  Beside a Guide the pane is narrowed: to the pick's code, or, while nothing is picked, to
 *  the list of changed files; "Show all files", a click in the tree or a jump elsewhere
 *  leaves the narrowing. With the Guide pane closed it shows all the files. A file's diff
 *  is drawn the first time it is on show and then kept, hidden while the narrowing leaves
 *  it out: a pick that returns to it finds it as it was, and nothing is highlighted twice.
 *  `shown`: the pane is on screen (it is kept, hidden, while the Guide has the whole width). */
function FilesTab({ loaded, shown }: { loaded: LoadedReview; shown: boolean }) {
  const F = useFiles(loaded)
  const { wt, eff, commitView, bySection, sectionOf, sections, sectionNo, kept, excluded, visible } = F
  const mode = useStore((s) => s.diffMode)
  const filters = useStore((s) => s.filters)
  const query = useStore((s) => s.fileQuery)
  const panelOpen = useStore((s) => s.panelOpen)
  const treeOver = useStore((s) => s.treeOver)
  const guideBeside = useStore((s) => s.guide != null)
  const codeWide = useStore((s) => s.codeWide)
  const layout = useLayout()
  const pick = useStore((s) => s.pick)
  const showAll = useStore((s) => s.showAll)
  const diffView = useStore((s) => s.diffView)
  const treeView = useStore((s) => s.treeView)
  const view = useStore((s) => s.view)
  const { set, setDiffView, setTreeView, setView } = useStore.getState()
  const shownCommit = commitView ? loaded.commits.find((c) => c.sha === commitView) : undefined
  const place = useTreePlace()
  // With the Guide pane closed the code and the tree have the window, and what fits is
  // decided by the window, as it was. Beside a Guide it is decided by the pane's own width.
  const win = { roomy: useWide(900), wide: useWide(1100) }
  const root = useRef<HTMLDivElement>(null)
  const width = usePaneWidth(root, CODE_STEPS)
  const scroll = useKeptScroll<HTMLDivElement>(shown)
  // back on show, perhaps at another width than it was folded away with: on the line it showed, not at the same offset
  useLayoutEffect(() => { if (shown) unparkCodePlace(scroll.y.current) }, [shown])       // eslint-disable-line react-hooks/exhaustive-deps
  // how wide the column of files itself is (the pane less an open section)
  const column = usePaneWidth(scroll.ref, FILES_STEPS)
  const [, bump] = useState(0)
  const since = loaded.since
  useEffect(() => { if (eff !== mode) set({ diffMode: eff }) }, [eff, mode, set])

  const reviewed = useStore((s) => s.reviewedSections)
  const toggleTree = (): void => {
    const hold = holdPlaces()
    if (place.room) set({ panelOpen: !panelOpen, treeOver: false })
    else set({ treeOver: !treeOver })
    hold.settle()
  }
  /** the tree, on show: its column where it has room, else over the files */
  const openTree = (): void => {
    const hold = holdPlaces()
    useStore.getState().openTree()
    hold.settle()
  }
  // `t`: the tree, with the caret in its filter. The Code pane comes back first if it was
  // folded away (not where the tree lies over the whole workspace: it needs no Code pane to lie over).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 't' || typingKey(e)) return
      e.preventDefault()
      if (!place.all) useStore.getState().revealCode()
      openTree()
      window.setTimeout(() => document.getElementById('gr-file-filter')?.focus({ preventScroll: true }), 60)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
  const treeShown = place.column || place.over
  // The filter is the tree's: its text goes when the tree is hidden (switched off, closed,
  // or folded for want of room), so the files are never filtered by text that is not on
  // show. (The files that come back come in round the line being read: it is held.)
  useLayoutEffect(() => {
    if (treeShown || !useStore.getState().fileQuery) return
    const hold = holdCodePlace()
    set({ fileQuery: '' })
    hold.settle()
  }, [treeShown, set])
  // (under a Guide, on a stacked window, the diff is unified, however wide the pane is)
  const canSplit = guideBeside ? layout === 'side' && column >= 700 : win.roomy
  const split = canSplit && (diffView ?? ((guideBeside ? column >= 900 : win.wide) ? 'split' : 'unified')) === 'split'

  // What the pane shows: all the files; the pick's only; or the list of changed files.
  // (A commit view is another diff: it is shown whole.)
  const to = useMemo(() => (guideBeside ? narrowingOf(pick, loaded) : null), [guideBeside, pick, loaded])
  const show: 'all' | 'pick' | 'list' = !guideBeside || showAll || commitView ? 'all' : to ? 'pick' : 'list'
  const only = useMemo(() => new Set(show === 'pick' ? to?.files ?? [] : []), [show, to])
  const inAll = useMemo(() => new Set(visible.map((f) => f.path)), [visible])       // eslint-disable-line react-hooks/exhaustive-deps
  const on = (f: FileDiff): boolean => (show === 'all' ? inAll.has(f.path) : show === 'pick' && only.has(f.path))
  // Every file of the change has its place in one list, whatever the filters and the
  // narrowing leave out just now: a file that goes out of sight and comes back is the same
  // box, in the same place.
  const groups = useMemo(() => F.group(kept), [loaded.files, F.wsPaths, bySection, treeView, wt])       // eslint-disable-line react-hooks/exhaustive-deps
  // a file's box is drawn the first time the file is on show, and kept from then on
  const drawn = useRef(new Set<string>())
  for (const g of groups) for (const f of g.files) if (on(f)) drawn.current.add(f.path)
  const viewed = kept.filter((f) => f.viewed === 'viewed').length
  // the list of reviewed ids can hold sections of an earlier walkthrough: count this one's
  const secCount = wt?.sections.length ?? 0
  const secDone = (wt?.sections ?? []).filter((s) => reviewed.includes(s.id)).length
  const secNext = wt?.sections.find((s) => !reviewed.includes(s.id)) ?? wt?.sections[0]
  // the file under the top of the pane, for the path bar, the tree and the open section of the Walkthrough
  // to mark: followed anew when other boxes are on show, or the same ones in another order
  // or under other groups, which no scroll or resize tells
  const list = useRef<HTMLDivElement>(null)
  const order = groups.flatMap((g) => g.files.filter(on).map((f) => f.path)).join('\n')
  useEffect(() => (list.current ? followFiles(list.current) : undefined), [order, bySection, filters.showExcluded])
  // (the list of files has no file under the reviewer's eyes)
  useEffect(() => { if (show === 'list') useStore.setState({ currentFile: null }) }, [show])
  /** the filters that leave files out, off (the "changes" view stays as it is) */
  const clearFilters = (): void => { const hold = holdCodePlace(); set({ fileQuery: '' }); if (filters.hideViewed || filters.onlyCommented) useStore.getState().setFilters({ hideViewed: false, onlyCommented: false }); hold.settle() }
  const modeLabel = shownCommit ? `${short(shownCommit.sha)} ${shownCommit.subject}` : commitView ? short(commitView) : eff === 'all' ? 'All changes' : eff === 'since' ? (since?.kind === 'approved' ? 'Since approved' : 'Since reviewed') : 'Since viewed'
  const pickMode = (m: DiffMode, close: () => void): void => { set({ diffMode: m }); if (commitView) void setView({ commit: undefined }); close() }
  const dirty = loaded.dirty && loaded.files.some((f) => f.uncommitted)
  const stale = loaded.state.comments.filter((c) => c.status === 'outdated' && c.anchor.kind === 'diff')

  return (
    <div className={'files-tab' + below(width, [520, 760, 1200])} ref={root}>
      <div className="files-toolbar">
        <Menu label={<><Icon name="commit" /><span className="mode-label">{modeLabel}</span><Icon name="chevDown" size={12} /></>} className="btn sm mode-btn" hook="diff-mode" title="Which changes to show">
          {(close) => (
            <div className="commit-menu">
              <MenuItem checked={!commitView && eff === 'all'} onClick={() => pickMode('all', close)}>Show all changes <span className="muted small">{plural(loaded.commits.length, 'commit')}</span></MenuItem>
              {F.showSince && since && <MenuItem checked={!commitView && eff === 'since'} title={`Since ${short(since.sha)}`} onClick={() => pickMode('since', close)}>{since.kind === 'approved' ? 'Since approved' : 'Since reviewed'} <span className="mono muted small">{short(since.sha)}</span></MenuItem>}
              {F.anyViewed && <MenuItem checked={!commitView && eff === 'viewed'} onClick={() => pickMode('viewed', close)}>Since viewed</MenuItem>}
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
        {/* the way into the Walkthrough while the Guide pane is closed; with a Guide open the Walkthrough has its own count */}
        {secNext && !guideBeside && (
          <button
            className={'btn sm sec-progress' + (secDone === secCount ? ' done' : '')} style={secStyle(sectionNo(secNext))} data-gr="sections-progress" data-gr-reviewed={secDone} data-gr-sections={secCount}
            title={`Guided review: go through the walkthrough section by section, marking each Reviewed.\n${secDone === secCount ? `All ${plural(secCount, 'section')} reviewed — opens the first one` : `Opens the first section you have not reviewed, “${secNext.name}”,`} in the Walkthrough and shows its files, at the first one not yet viewed.`}
            onClick={() => openSection(secNext.id)}
          >
            {secDone === secCount ? <Icon name="check" size={14} /> : <span className="sec-dot" />}<span><strong>{secDone}</strong> / {plural(secCount, 'section')}</span>
          </button>
        )}
        <Menu label={<Icon name="gear" />} className="btn sm icon" align="right" hook="view-settings" title="View settings">
          {(close) => (
            <>
              <div className="pop-head">Diff view</div>
              <MenuItem checked={split} disabled={!canSplit} title={canSplit || !guideBeside ? undefined : layout === 'side' ? 'Not enough room beside the Guide — drag the divider, or close the Guide pane, to split the diff' : 'Under a Guide the diff is unified — close the Guide pane to split it'} onClick={() => { const hold = holdCodePlace(); setDiffView('split'); hold.settle(); close() }}>Split</MenuItem>
              <MenuItem checked={!split} onClick={() => { if (canSplit) { const hold = holdCodePlace(); setDiffView('unified'); hold.settle() } close() }}>Unified</MenuItem>
              <label className="menu-item" title="Leave out changes that only alter whitespace"><span className="menu-check"><input type="checkbox" name="gr-field" data-gr="hide-whitespace" checked={Boolean(view.ignoreWhitespace)} onChange={(e) => { void setView({ ignoreWhitespace: e.target.checked }); close() }} /></span>Hide whitespace</label>
              <div className="pop-head">Tree panel</div>
              <MenuItem checked={treeView === 'tree'} onClick={() => { setTreeView('tree'); close() }}>Tree</MenuItem>
              <MenuItem checked={treeView === 'list'} onClick={() => { setTreeView('list'); close() }}>List</MenuItem>
              <div className="pop-head">Theme</div>
              <MenuItem checked={currentTheme() === 'light'} onClick={() => { setTheme('light'); bump((n) => n + 1); close() }}>Light</MenuItem>
              <MenuItem checked={currentTheme() === 'dark'} onClick={() => { setTheme('dark'); bump((n) => n + 1); close() }}>Dark</MenuItem>
            </>
          )}
        </Menu>
        {guideBeside && layout === 'stack' && (
          <button className={'btn sm icon' + (codeWide ? ' selected' : '')} aria-pressed={codeWide} data-gr="code-wide" title={codeWide ? 'Show the Guide above the code again' : 'Give the code the whole height (the Guide comes back from its row)'} aria-label={codeWide ? 'Show the Guide pane again' : 'Give the Code pane the whole height'} onClick={() => set({ codeWide: !codeWide, guideWide: false })}>
            <Icon name={codeWide ? 'columns' : 'expand'} />
          </button>
        )}
        <button className="btn sm icon tree-toggle" title={treeShown ? 'Hide the tree panel' : place.room ? 'Show the tree panel' : 'Show the tree panel, over the files'} aria-label="Toggle the tree panel" aria-pressed={treeShown} data-gr="tree-toggle" onClick={toggleTree}><Icon name="sidebar" /></button>
      </div>
      <div className="code-where" data-gr="code-where">
        <PathBar sections={sections} onDir={(dir) => useStore.getState().revealDir(dir)} />
        {show === 'all' && !commitView && visible.length < kept.length && (
          <span className="narrowing" data-gr="filter-note">
            <span className="muted">Filtered: {visible.length} of {plural(kept.length, 'file')}</span>
            {(query || filters.hideViewed || filters.onlyCommented) && <button className="link" data-gr="filter-clear" title="Clear the tree's filter, and show viewed files and files without comments again" onClick={clearFilters}>Clear</button>}
          </span>
        )}
        {guideBeside && !commitView && <NarrowChip show={show} to={to} count={visible.length} hidden={to ? to.files.some((f) => !inAll.has(f)) : false} onClear={clearFilters} />}
      </div>

      {commitView && (
        <div className="flash-banner info" data-gr="commit-view">
          <span className="grow">Showing changes from commit <span className="ref-chip mono">{short(commitView)}</span> only — comments and review apply to the whole comparison.</span>
          <button className="btn sm" onClick={() => void setView({ commit: undefined })}>Show all changes</button>
        </div>
      )}
      <div className="files-layout">
        <div className="code-scroll" data-gr-scroll="code" data-gr-show={show} tabIndex={-1} ref={scroll.ref} onScroll={scroll.onScroll}>
        {show === 'list' && <FileList files={F.groups.flatMap((g) => g.files)} counts={F.counts} />}
        <div className="files-list" ref={list} hidden={show === 'list'}>
          {show === 'all' && kept.length === 0 && <div className="blankslate"><h3>No changes</h3><p className="muted">The two sides of this comparison are identical.</p></div>}
          {show === 'all' && kept.length > 0 && visible.length === 0 && <div className="blankslate"><h3>No files match</h3><p className="muted">Change the filter or the “{modeLabel}” view.</p></div>}
          {show === 'pick' && to?.files.length === 0 && <div className="blankslate"><h3>No code to show</h3><p className="muted">None of the files of {to.label.replace(/ \(.*$/, '')} are part of this comparison any more.</p></div>}
          {groups.map((g) => (
            <div key={g.section?.id ?? '-'} className={'file-group' + (bySection && g.section ? ' sec' : '')} style={bySection && g.section ? secStyle(sectionNo(g.section)) : undefined} hidden={!g.files.some(on)}>
              {bySection && (g.section
                ? <SectionHeader section={g.section} files={g.files} no={sectionNo(g.section)} />
                : <div className="sec-head plain" id="gr-loose"><h3>Not in the walkthrough</h3><span className="muted small">{plural(g.files.length, 'file')}</span></div>)}
              {g.files.map((f) => (drawn.current.has(f.path) ? <FileBox key={f.path} file={f} split={split} hidden={!on(f)} order={show === 'pick' && to?.ordered ? to.files.indexOf(f.path) : undefined} whitespaceOnly={F.wsPaths.has(f.path)} section={sectionOf.get(f.path)} sectionNo={sections.get(f.path)?.no} grouped={bySection} note={sectionOf.get(f.path)?.plainNotes?.[f.path]} /> : null))}
            </div>
          ))}
          {show === 'all' && filters.showExcluded && excluded.length > 0 && (
            <div className="file-group" id="gr-excluded">
              <div className="sec-head plain"><h3>Untracked, left out of the review</h3><span className="muted small">{plural(excluded.length, 'file')}</span></div>
              {excluded.map((f) => <FileBox key={f.path} file={f} split={split} />)}
            </div>
          )}
        </div>
        {show === 'all' && stale.length > 0 && (
          <div className="unplaced page-level" data-gr="outdated">
            <div className="unplaced-head">Outdated comments — the lines they were written on are gone</div>
            {stale.map((c) => <Thread key={c.id} c={c} showAnchor />)}
          </div>
        )}
        </div>
        {place.over && !place.all && <TreePanel loaded={loaded} over />}
      </div>
    </div>
  )
}

/** A link to code, as a chip. In a Guide it is a pick: the Code pane is narrowed to it, and the chip is marked while it is the pick. */
function CodeChip({ target, children, title, hook, disabled }: { target: FocusTarget | null; children: ReactNode; title?: string; hook?: string; disabled?: boolean }) {
  const link = usePickLink(target)
  const code = target != null && (target.kind === 'file' || target.kind === 'diff')
  return <button className={'ref-chip mono link-chip' + (link.picked ? ' picked' : '')} data-gr={hook} title={title} disabled={disabled || !target} aria-pressed={link.from ? link.picked : undefined} data-gr-pickable={link.from && link.from !== 'walkthrough' && code && !disabled ? '' : undefined} onClick={() => target && focusAnchor(target, { from: link.from })}>{children}</button>
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
  if (action.kind === 'focus') return <CodeChip target={action.target} hook="chat-focus" title="Show this in the Code pane">{targetLabel(action.target)}</CodeChip>
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

/** The review's effort level with what it covers, and each part of the review as it was
 *  last done: on which model, and for which state of the code. It opens from the top bar
 *  (Details), whatever the reviewer is reading. Everything it has to say is in its text,
 *  not in a tooltip. */
function EffortLine({ loaded }: { loaded: LoadedReview }) {
  const level = loaded.session.effort
  const done = loaded.state.effortDone ?? {}
  const wt = Boolean(loaded.state.walkthrough)
  const upTo = level ? EFFORT_LEVELS.indexOf(level) : -1
  // the parts this level includes, and any that are there although the level does not include them
  const parts = EFFORT_LEVELS.filter((l, i) => i <= upTo || done[l] || (l === 'read' && wt))
  if (!level && !parts.length) return null
  return (
    <div className="effort-line small" data-gr="effort" data-gr-level={level}>
      <span className="muted">Effort</span>
      {level ? <><span className="label effort" title={effortTitle(level)}>{level}</span><span className="muted">{EFFORT[level].sum}</span></> : <span className="muted">no level recorded (a review from before effort levels)</span>}
      {parts.map((l, i) => {
        const m = l === 'read' && !wt ? undefined : done[l]
        // (a walkthrough the code has moved past says so itself, in the banner above it)
        const old = l !== 'read' && fromEarlier(m, loaded)
        const extra = Boolean(level) && i > upTo
        return (
          <span key={l} className={'effort-part' + (m ? '' : ' todo') + (old || extra ? ' old' : '')} data-gr-part={l} title={m ? `Done ${ago(m.at)} at ${short(m.sha)}.` : undefined}>
            <strong>{EFFORT[l].part}</strong> · {m ? (m.model || 'model not recorded') : l === 'read' && wt ? 'model not recorded' : 'not done yet'}
            {old && <> · at <span className="mono">{short(m?.sha)}</span>, an earlier state</>}
            {extra && <> · not updated at {level}</>}
          </span>
        )
      })}
    </div>
  )
}

/** One statement that does not hold: what it says, where it stands, and the line of code
 *  that contradicts it, each a jump when the page can go there. */
function FactItem({ row, loaded, listAt }: { row: FactRow; loaded: LoadedReview; listAt: string }) {
  const { set, showGuide } = useStore.getState()
  const w = row.where
  // the note beside the code follows its line as the code moves, and the row with it
  const note = row.commentId ? loaded.state.comments.find((c) => c.id === row.commentId) : undefined
  const at: FocusTarget | null = note ? (note.lineGone || note.status === 'outdated' ? null : focusable(note.anchor))
    : row.contradicts?.inDiff ? { kind: 'diff', file: row.contradicts.file, side: row.contradicts.side, line: row.contradicts.line } : null
  const line = at?.kind === 'diff' ? at.line : row.contradicts?.line
  const stands: FocusTarget | null = w.inDiff && w.file ? (w.line ? { kind: 'diff', file: w.file, side: 'new', line: w.line } : { kind: 'file', file: w.file }) : null
  // a row an update kept from an earlier run; when the whole list is from an earlier state, its head says so
  const old = fromEarlier(row.foundAt, loaded) && row.foundAt.signature !== listAt
  return (
    <li className="fact-row" data-gr-fact={row.id} data-gr-group={row.group}>
      <Md text={row.statement} className="fact-statement" />
      <div className="fact-meta small">
        <span className="muted">stands in</span>
        {stands ? <CodeChip target={stands} hook="fact-where" title="Show it in the Code pane">{w.label}</CodeChip>
          : w.artifact && w.file ? <button className="ref-chip mono link-chip" data-gr="fact-where" title="Open the document in Spec & plan" onClick={() => { set({ docPath: w.file ?? null }); showGuide('spec') }}>{w.label}</button>
            : <span className={w.file || w.commit ? 'mono' : ''} data-gr="fact-where">{w.label}{w.file && <span className="muted"> (not part of this change)</span>}</span>}
        {row.contradicts && (
          <>
            <span className="muted">contradicted by</span>
            {at ? <CodeChip target={at} hook="fact-line" title="Show the line in the Code pane">{row.contradicts.file}:{line}{row.contradicts.side === 'old' ? ' (old)' : ''}</CodeChip>
              : <span className="mono" data-gr="fact-line">{row.contradicts.file}:{line}<span className="muted">{row.contradicts.inDiff ? ' (that line is no longer in the code)' : ' (not part of this change)'}</span></span>}
          </>
        )}
        {old && <span className="label warn" data-gr="earlier-state">found at <span className="mono">{short(row.foundAt.sha)}</span>, an earlier state: not checked again since</span>}
      </div>
      {row.why && <Md text={row.why} className="fact-why" />}
    </li>
  )
}
/** The fact check: the complete record of the statements that do not hold. What this
 *  change made false comes first and is always open; what was false before it can be long
 *  on a repository with neglected docs, so it is folded. */
function FactList({ loaded }: { loaded: LoadedReview }) {
  const fc = loaded.state.factCheck
  const all = useStore((s) => s.factsOpen)
  if (!fc) return null
  const changed = fc.rows.filter((r) => r.group === 'changed')
  const already = fc.rows.filter((r) => r.group === 'already')
  const old = fromEarlier({ sha: fc.endSha, signature: fc.signature }, loaded)
  return (
    <div className="fact-box" data-gr="fact-check" id="gr-facts">
      <div className="fact-head">
        <strong>Fact check</strong>
        <span>{fc.rows.length ? `${plural(fc.rows.length, 'statement')} ${fc.rows.length === 1 ? 'does' : 'do'} not hold` : 'no statement was found that does not hold'}</span>
        <span className="small">{fc.checked != null ? `${fc.checked} checked` : 'how many were checked was not recorded'} · by {fc.model || 'a model that was not recorded'}</span>
        {old && <span className="label warn" data-gr="earlier-state">checked at <span className="mono">{short(fc.endSha)}</span>, an earlier state: the code has changed since</span>}
      </div>
      {changed.length > 0 && (
        <>
          <div className="fact-group">Made false by this change<span className="counter">{changed.length}</span></div>
          <ul className="fact-list">{changed.map((r) => <FactItem key={r.id} row={r} loaded={loaded} listAt={fc.signature} />)}</ul>
        </>
      )}
      {already.length > 0 && (
        <>
          <div className="fact-group">
            Was already false<span className="counter">{already.length}</span>
            <button className="link small" data-gr="fact-already" aria-expanded={all} aria-controls="gr-facts-already" aria-label={`${all ? 'Hide' : 'Show'} the ${plural(already.length, 'statement')} that ${already.length === 1 ? 'was' : 'were'} already false`} onClick={() => useStore.getState().set({ factsOpen: !all })}>{all ? 'Hide' : 'Show'}</button>
          </div>
          {all && <ul className="fact-list" id="gr-facts-already">{already.map((r) => <FactItem key={r.id} row={r} loaded={loaded} listAt={fc.signature} />)}</ul>}
        </>
      )}
    </div>
  )
}

/** Two presses of "Reviewed, next" closer together than this are a double click: the second is dropped. */
const DOUBLE_CLICK = 300

/** The Walkthrough Guide: what Claude Code says this change is, as one list. On top the
 *  summary, with the effort line and the fact check; then every section as a row, in its
 *  colour, with its files and its Reviewed tick. A section is opened in place, under its
 *  row, and the one that was open closes: the open section is this Guide's pick, and the
 *  Code pane is narrowed to its files. "Reviewed, next" ticks it and opens the next one
 *  not yet reviewed, so the whole walkthrough can be gone through from here. */
function WalkthroughGuide({ loaded }: { loaded: LoadedReview }) {
  const wt = loaded.state.walkthrough
  const reviewed = useStore((s) => s.reviewedSections)
  const openId = useStore((s) => { const p = s.picks.walkthrough; return p && 'section' in p ? p.section : null })
  const pickedFile = useStore((s) => { const p = s.picks.walkthrough; return p && 'section' in p ? p.file ?? null : null })
  const here = useStore((s) => s.currentFile)
  const { request, showGuide, toggleSectionReviewed, set } = useStore.getState()
  const [steer, setSteer] = useState('')
  const pressed = useRef(0)
  const list = useRef<HTMLDivElement>(null)
  const asking = loaded.state.requests.some((r) => r.kind === 'walkthrough' && isOpen(r))
  const it = loaded.state.iterations.at(-1)
  const ask = (update: boolean): void => { void request({ kind: 'walkthrough', text: steer.trim() || undefined, update }).then((r) => { if (r) setSteer('') }) }
  // a section opened from elsewhere (its chip on a file, a link, the session) is brought into view
  useEffect(() => {
    if (!openId) return
    const frame = window.requestAnimationFrame(() => { const row = list.current?.querySelector(`[data-gr-section="${cssq(openId)}"] .sec-item-head`); if (row) showIfOut(row) })
    return () => window.cancelAnimationFrame(frame)
  }, [openId])
  if (!wt) {
    return (
      <div className="walk" data-gr="walkthrough">
        <div className="walk-by muted small"><span className="avatar agent sm" aria-hidden="true">C</span> Claude has not written a walkthrough yet</div>
        <div data-gr="summary" className="muted">The diff in the Code pane comes straight from git.</div>
        <div className="row gap wrap ask-row">
          <input name="gr-field" className="grow" value={steer} placeholder="What should it focus on? (optional)" onChange={(e) => setSteer(e.target.value)} aria-label="Steer" />
          <button className="btn sm primary" data-gr="generate" disabled={asking || Boolean(loaded.refMissing)} onClick={() => ask(false)}>Ask Claude Code for a walkthrough</button>
        </div>
        <AwayHint />
        <EffortLine loaded={loaded} />
        <FactList loaded={loaded} />
        <CommentSlot anchor={{ kind: 'summary' }} k="summary" />
      </div>
    )
  }
  const sections = wt.sections
  const done = sections.filter((s) => reviewed.includes(s.id)).length
  const allDone = done === sections.length
  const topOf = (row: Element): number => { const sc = row.closest('[data-gr-scroll]'); return sc ? row.getBoundingClientRect().top - sc.getBoundingClientRect().top : 0 }
  /** Where a row about to be opened is put: where it is, or, from the foot of the pane, as far
   *  up as leaves room under it for the start of its text and its actions. */
  const roomBelow = (row: Element): number => { const sc = row.closest('[data-gr-scroll]'); return sc ? Math.min(topOf(row), Math.max(8, sc.clientHeight - 120)) : 0 }
  /** Open a section in place (null: close the open one, which leaves the pick), keeping the
   *  row `id` at `top` px below the top of the pane: the section that was open above it
   *  closes, and the row would move under the reviewer's pointer otherwise. */
  const open = (id: string | null, keep: string, top: number, file?: string): void => {
    if (id == null) useStore.getState().clearPick('walkthrough')
    else openSection(id, { file })
    const put = (): void => {
      const row = list.current?.querySelector(`[data-gr-section="${cssq(keep)}"]`)
      const sc = row?.closest('[data-gr-scroll]')
      if (row && sc) sc.scrollBy({ top: topOf(row) - top })
    }
    window.requestAnimationFrame(put)
    window.setTimeout(put, 120)       // once more, after late layout
  }
  // The second click of a double click on "Reviewed, next" lands on whatever the next section
  // put under the pointer (with the Guide at whole width the Code pane comes back and the
  // Guide is laid out anew): it is dropped, wherever in the Walkthrough it lands.
  const second = (e: { preventDefault(): void; stopPropagation(): void }): void => { if (Date.now() - pressed.current < DOUBLE_CLICK) { e.preventDefault(); e.stopPropagation() } }
  return (
    <div className="walk" data-gr="walkthrough" onClickCapture={second}>
      {loaded.walkthroughStale && (
        <div className="flash-banner warn" data-gr="stale">
          <span className="grow">The code changed since this walkthrough.</span>
          <button className="btn sm" data-gr="update" disabled={asking} onClick={() => ask(true)}>Ask Claude Code to update it</button>
        </div>
      )}
      <div className="walk-by muted small"><span className="avatar agent sm" aria-hidden="true">C</span> Claude wrote the walkthrough{loaded.state.effortDone?.read ? ` on ${loaded.state.effortDone.read.model || 'a model that was not recorded'}` : ''}{it?.at ? ` · ${ago(it.at)}` : ''}</div>
      <div data-gr="summary" className="summary-wrap"><Md text={wt.summary || '_No summary._'} /><CommentButton k="summary" title="Comment on the summary" /></div>
      <CommentSlot anchor={{ kind: 'summary' }} k="summary" />
      <EffortLine loaded={loaded} />
      <FactList loaded={loaded} />
      <div className="walk-count">
        <span className="side-title">{plural(sections.length, 'section')}</span>
        <span className={'sec-progress small' + (allDone ? ' done' : '')} data-gr="sections-count" data-gr-reviewed={done} data-gr-sections={sections.length}>{allDone && <Icon name="check" size={14} />}<strong>{done}</strong> / {sections.length} reviewed</span>
      </div>
      <div className="sec-list" ref={list}>
        {sections.map((s, no) => {
          const isOpen = s.id === openId
          const ticked = reviewed.includes(s.id)
          const k = anchorKey({ kind: 'section', sectionId: s.id })
          // the next section still to review: after this one, then round to the earliest (the list
          // of reviewed ids can hold sections of an earlier walkthrough, so it is never counted)
          const next = [...sections.slice(no + 1), ...sections.slice(0, no)].find((x) => !reviewed.includes(x.id))
          const reviewedNext = (row: Element | null): void => {
            // the second click of a double click would tick the section just arrived at, unread.
            // Counted from the press: the tick's save can wait behind the reloads the tick before
            // it set off (one for every tab on the review), and must not hold the next press off
            const now = Date.now()
            if (now - pressed.current < DOUBLE_CLICK) return
            pressed.current = now
            // the next row opens where this one's head was, when that was in view; else at the top of the pane
            const head = row ? topOf(row) : 8
            const sc = row?.closest('[data-gr-scroll]')
            const at = sc && head >= 0 && head < sc.clientHeight - 120 ? head : 8
            const go = (): void => { if (next) open(next.id, next.id, at) }
            // never a toggle: on a section already ticked it only moves on
            if (ticked) return go()
            // a saved review has the tick in its list at once, and the next section opens with
            // it; a review not saved yet is saved first (they may move on by hand meanwhile)
            const saved = useStore.getState().sessionId != null
            const tick = toggleSectionReviewed(s.id)
            if (saved) return go()
            void tick.then(() => { const p = useStore.getState().picks.walkthrough; if (p && 'section' in p && p.section === s.id) go() })
          }
          return (
            <div key={s.id} className={'sec-item' + (isOpen ? ' open' : '')} style={secStyle(no)} data-gr-section={s.id} data-gr-reviewed={ticked ? 'true' : 'false'} data-gr-open={isOpen ? 'true' : undefined}>
              <div className="sec-item-head">
                <button className="sec-toggle" aria-expanded={isOpen} data-gr-pickable="" title={isOpen ? 'Close this section (the code shows all files again)' : 'Open this section: the code shows its files'} onClick={(e) => { const row = e.currentTarget.closest('.sec-item'); open(isOpen ? null : s.id, s.id, row ? (isOpen ? topOf(row) : roomBelow(row)) : 0) }}>
                  <Icon name={isOpen ? 'chevDown' : 'chevRight'} size={12} /><span className="sec-dot" /><strong>{s.name}</strong>{s.desc && <span className="muted"> — {s.desc}</span>}
                </button>
                <span className="muted small nowrap">{plural(s.files.length, 'file')}</span>
                {ticked && <span className="sec-tick" role="img" aria-label="Reviewed" title="You marked this section reviewed" data-gr="section-tick"><Icon name="check" size={14} /></span>}
              </div>
              {isOpen && (
                <div className="sec-item-body" data-gr="section-panel" data-gr-section-panel={s.id} data-gr-reviewed={ticked ? 'true' : 'false'}>
                  {s.what && <Md text={s.what} />}
                  <Diagram section={s} />
                  <div className="sec-panel-files">
                    {s.files.map((path) => {
                      const f = loaded.files.find((x) => x.path === path)
                      return (
                        <button key={path} className={'tree-row leaf' + (path === here ? ' here' : '') + (path === pickedFile ? ' picked' : '') + (f ? '' : ' gone')} disabled={!f} aria-current={path === here ? 'true' : undefined} title={f ? `Show ${path}` : `${path} — no longer part of this comparison`} data-gr-panel-file={path} onClick={() => openSection(s.id, { file: path })}>
                          <FileIcon path={path} /><span className="tree-name">{baseName(path)}{path.includes('/') && <span className="muted small"> {path.slice(0, path.lastIndexOf('/'))}</span>}</span>
                          {f?.viewed === 'viewed' && <Icon name="check" size={12} className="tree-viewed" />}
                          {f && <DiffStat add={f.add} del={f.del} />}
                        </button>
                      )
                    })}
                  </div>
                  <div className="row gap wrap sec-actions" data-gr="section-actions">
                    {allDone
                      ? <span className="sec-all-done" data-gr="sections-done"><Icon name="check" size={14} />{sections.length === 1 ? 'The section is reviewed' : `All ${sections.length} sections reviewed`}</span>
                      : (
                        <button className="btn sm primary" data-gr="section-reviewed-next" title={ticked ? `Go to the next section you have not reviewed: “${next?.name}”` : next ? `Mark this section reviewed and open the next one you have not reviewed: “${next.name}”` : 'Mark this section reviewed — it is the last one left'} onClick={(e) => reviewedNext(e.currentTarget.closest('.sec-item'))}>
                          <Icon name={ticked ? 'arrowDown' : 'check'} size={14} />{ticked ? 'Next unreviewed' : next ? 'Reviewed, next' : 'Reviewed, finish'}
                        </button>
                      )}
                    <label className={'viewed-box' + (ticked ? ' on' : '')}><input type="checkbox" name="gr-field" checked={ticked} onChange={() => void toggleSectionReviewed(s.id)} data-gr="section-reviewed" /> Reviewed</label>
                    <button className="btn sm" data-gr="section-comment" onClick={() => set({ composer: k })}><Icon name="comment" size={14} /> Comment</button>
                  </div>
                  <CommentSlot anchor={{ kind: 'section', sectionId: s.id }} k={k} />
                </div>
              )}
            </div>
          )
        })}
      </div>
      {wt.planMap && planSummary(wt.planMap) && <div className="plan-line"><Icon name="book" size={14} /><span><button className="link" onClick={() => showGuide('spec')}>Spec check</button>: {planSummary(wt.planMap)}</span></div>}
      <div className="desc-foot muted small">
        Walkthrough #{it?.n ?? 1} · written at <span className="mono">{short(loaded.state.reviewedAtSha)}</span>
        <span className="grow" />
        <input name="gr-field" value={steer} placeholder="Steer (optional)" onChange={(e) => setSteer(e.target.value)} aria-label="Steer" />
        <button className="btn sm" data-gr="generate" disabled={asking} onClick={() => ask(false)}>Ask for a fresh walkthrough</button>
      </div>
    </div>
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
          {m.anchor && <CodeChip target={t}>{anchorLabel(m.anchor)}</CodeChip>}
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
  const { request, addComment, showGuide } = useStore.getState()
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
    ...st.iterations.slice(1).map((it) => ({ at: it.at, key: 'i' + it.n, node: <Event icon="book" at={it.at}>Claude wrote walkthrough #{it.n} at <span className="mono">{short(it.endSha)}</span>{it.model ? ` on ${it.model}` : ''}</Event> }))
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
            {loaded.artifacts.map((a) => <button key={a.path} className="link block" data-gr-artifact={a.path} title={a.path} onClick={() => { useStore.getState().set({ docPath: a.path }); showGuide('spec') }}>{a.title}</button>)}
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
  // a spec or a plan is read as the document it is; its source lines are one click away
  const [source, setSource] = useState(false)
  const rendered = Boolean(art) && isMarkdown(art?.path ?? '') && !source
  const index = useContext(CommentsCtx)
  // the threads on its lines that still read what they were written on (the others are listed under it)
  const threads = useMemo(() => {
    const out = new Map<number, Comment[]>()
    if (!art) return out
    for (const [k, list] of index) {
      if (!k.startsWith(`artifact:${art.path}:`)) continue
      for (const c of list) {
        if (c.anchor.kind !== 'artifact' || c.anchor.path !== art.path || c.lineGone) continue
        const now = art.lines[c.anchor.line - 1]
        if (now !== undefined && (!c.anchor.lineContent || c.anchor.lineContent === now)) out.set(c.anchor.line, [...(out.get(c.anchor.line) ?? []), c])
      }
    }
    return out
  }, [index, art])
  const { keyOf, anchorOf } = useMemo(() => ({
    keyOf: (n: number): string => `artifact:${art?.path}:${n}`,
    anchorOf: (n: number): AnchorInput => ({ kind: 'artifact', path: art?.path ?? '', line: n, expect: art?.lines[n - 1] })
  }), [art])
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
              {isMarkdown(art.path) && (
                <span className="seg" role="group" aria-label="How this document is shown">
                  <button className={'seg-btn' + (rendered ? ' on' : '')} aria-pressed={rendered} data-gr="md-rendered" title="Read it as a formatted document" onClick={() => setSource(false)}>Rendered</button>
                  <button className={'seg-btn' + (rendered ? '' : ' on')} aria-pressed={!rendered} data-gr="md-source" title="Its source, line by line" onClick={() => setSource(true)}>Source</button>
                </span>
              )}
              <span className="grow" />
              <label className={'viewed-box' + (approvedAt ? ' on' : '')} title={approvedAt ? `Approved at ${short(approvedAt)}` : `Approve this ${art.role}`}>
                <input type="checkbox" name="gr-field" checked={Boolean(approvedAt)} onChange={() => void toggleArtifactApproval(art.path)} data-gr="approve-artifact" /> Approved{approvedAt ? ` at ${short(approvedAt)}` : ''}
              </label>
            </div>
            <div className="file-body">
              {rendered
                ? <MdDoc key={art.path} lines={art.lines} keyOf={keyOf} anchorOf={anchorOf} threads={threads} />
                : <div className="diff unified doc">{art.lines.map((text, i) => <DocLine key={i} path={art.path} n={i + 1} text={text} />)}</div>}
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

// ── the workspace ─────────────────────────────────────────────
/** How much of the workspace's width a Guide starts with, in percent: a diagram needs more room than text. */
const GUIDE_START: Record<Guide, number> = { walkthrough: 40, visual: 56, conversation: 40, spec: 40 }
/** The window width from which the Guide's share is reckoned of what the tree panel would
 *  leave, whether the tree is on show or folded: showing it then takes room from the code
 *  only, and a diagram is not laid out anew for it. */
const TREE_RESERVED = 1500
/** Neither pane is made narrower than this beside the other (px); `bar` is the divider between them. */
const PANE_MIN = { guide: 320, code: 420, bar: 6 }
/** Stacked, the Guide starts with this share of the height (percent), and neither pane is made shorter than this (px). */
const STACK_START = 50
const STACK_MIN = { guide: 140, code: 200 }
/** the widths at which what a Guide holds is laid out for a narrower pane */
const GUIDE_STEPS = [520, 760, 1000, 1200] as const

/** One Guide in the Guide pane. It is mounted the first time it is shown and kept from then
 *  on: hidden while another Guide is on show, so it comes back as it was left, with its
 *  scroll position, its open parts, its pick and whatever was being written in it. */
function GuideBody({ id, shown, children }: { id: Guide; shown: boolean; children: ReactNode }) {
  const scroll = useKeptScroll<HTMLDivElement>(shown)
  // First drawn with the pick in it (an address that names one was opened): the link that
  // is the pick is brought into view. Never later: a Guide stays where the reviewer left it.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { const el = scroll.ref.current?.querySelector('.picked'); if (el) showIfOut(el) })
    return () => window.cancelAnimationFrame(frame)
  }, [])       // eslint-disable-line react-hooks/exhaustive-deps
  // (what is drawn in here knows it is in a Guide: a jump to code from it is a pick)
  return <div className="guide-scroll" role="tabpanel" data-gr-scroll={id} data-gr-guide={id} hidden={!shown} tabIndex={-1} ref={scroll.ref} onScroll={scroll.onScroll}><GuideCtx.Provider value={id}>{children}</GuideCtx.Provider></div>
}

/** The divider between the Guide pane and the Code pane: drag it (or use the arrow keys)
 *  to give one of them more of the window; double-click puts it back where the Guide
 *  starts. While it is dragged the panes follow at once, and the code stays on the line it
 *  showed; what has to be laid out anew for the new width (a diagram, split or unified)
 *  waits until it is released. `pct`: the Guide pane's share of the room;
 *  `tree`: how much of the workspace is not theirs to share (the tree panel at its usual
 *  width); `treeNow`: what the tree panel takes as it is, which the code's least width is kept clear of.
 *  `stacked`: the panes are one above the other: it lies between them and is dragged up
 *  and down, and `pct` is the Guide pane's share of the height. */
function PaneDivider({ frame, pct, tree, treeNow, stacked, onChange }: { frame: RefObject<HTMLElement | null>; pct: number; tree: number; treeNow: number; stacked: boolean; onChange: (pct: number | null) => void }) {
  const drag = useRef<{ hold: ReturnType<typeof holdPlaces>; pct: number; tick: number } | null>(null)
  /** the share a divider at `x` (at that height, where the panes are stacked) gives the Guide pane, within what each pane needs */
  const shareAt = (x: number): number => {
    const r = frame.current?.getBoundingClientRect()
    if (stacked) {
      if (!r?.height) return pct
      const px = Math.min(r.height - STACK_MIN.code - PANE_MIN.bar, Math.max(STACK_MIN.guide, x - r.top))
      return Math.round((px / r.height) * 1000) / 10
    }
    if (!r?.width) return pct
    const room = r.width - tree
    const px = Math.min(r.width - treeNow - PANE_MIN.code - PANE_MIN.bar, Math.max(PANE_MIN.guide, x - r.left))
    return room > 0 ? Math.round((px / room) * 1000) / 10 : pct
  }
  const down = (e: RPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* a pointer the browser does not know: the drag still follows it while it is over the divider */ }
    drag.current = { hold: holdPlaces(), pct, tick: 0 }
    if (frame.current) frame.current.dataset.dragging = ''
  }
  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    d.pct = shareAt(stacked ? e.clientY : e.clientX)
    // straight onto the frame: nothing is drawn again by React at each step of the drag
    frame.current?.style.setProperty(stacked ? '--stack-h' : '--guide-w', String(d.pct))
    d.tick ||= window.requestAnimationFrame(() => { d.tick = 0; d.hold.now() })
  }
  const up = (): void => {
    const d = drag.current
    if (!d) return
    drag.current = null
    delete frame.current?.dataset.dragging
    onChange(d.pct)
    window.dispatchEvent(new window.Event(PANES_SETTLED))     // (`Event` here is the timeline's)
    d.hold.settle()
  }
  const step = (by: number | null, at: number): void => { const hold = holdPlaces(); onChange(by == null ? null : shareAt(at + by)); hold.settle() }
  const key = (e: RKeyboardEvent<HTMLDivElement>): void => {
    const [less, more] = stacked ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
    if (e.key === less || e.key === more) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); step(e.key === less ? -24 : 24, stacked ? r.top : r.left) }
    else if (e.key === 'Home') step(null, 0)
  }
  return (
    <div
      className="pane-divider" role="separator" aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-label="Resize the Guide pane and the Code pane" tabIndex={0} data-gr="pane-divider"
      aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
      title="Drag to resize · double-click to reset" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => step(null, 0)} onKeyDown={key}
    />
  )
}

/** The top of the sheet the code is in on a phone-width window: a handle (a click on it,
 *  or pulling it down, lowers the sheet) and a close control. The Guide under the sheet is
 *  given back where it was. */
function SheetBar({ pane }: { pane: RefObject<HTMLElement | null> }) {
  const drag = useRef<{ y: number; by: number } | null>(null)
  const pulled = useRef(false)       // (the click that ends a pull is not a click on the handle)
  const close = (): void => useStore.getState().set({ front: 'guide' })
  const pull = (by: number): void => { if (pane.current) pane.current.style.transform = by > 0 ? `translateY(${by}px)` : '' }
  const down = (e: RPointerEvent<HTMLButtonElement>): void => { drag.current = { y: e.clientY, by: 0 }; try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* a pointer the browser does not know */ } }
  const move = (e: RPointerEvent<HTMLButtonElement>): void => { const d = drag.current; if (d) { d.by = e.clientY - d.y; pull(d.by) } }
  const up = (): void => { const d = drag.current; drag.current = null; pull(0); pulled.current = Boolean(d && Math.abs(d.by) > 4); if (d && d.by > 72) close() }
  return (
    <div className="sheet-bar" data-gr="sheet-bar">
      <button className="sheet-handle" data-gr="sheet-handle" title="Lower the code: the Guide, where it was" aria-label="Lower the code sheet" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onClick={() => { if (!pulled.current) close(); pulled.current = false }}><span aria-hidden="true" /></button>
      <button className="icon-btn" data-gr="sheet-close" title="Close the code: the Guide, where it was (Esc)" aria-label="Close the code sheet" onClick={close}><Icon name="x" /></button>
    </div>
  )
}

/** The workspace: the Guide pane on the left, the Code pane beside it and the tree panel
 *  on the far right, each scrolling by itself, with a divider between Guide and code. The
 *  Guide pane can be closed (code and tree, as "Files changed" was) or given the whole
 *  width. A jump to code moves the Code pane and nothing else.
 *  On a window under 1100px the two are stacked: the Guide on top, the code below it, the
 *  divider between them dragged up and down, and either can have the whole height. Under
 *  760px the Guide has the workspace and the code is a sheet: a pick raises it over the
 *  lower two thirds, and closing it gives the Guide back where it was. */
function Workspace({ loaded }: { loaded: LoadedReview }) {
  const guide = useStore((s) => s.guide)
  const guideWide = useStore((s) => s.guideWide)
  const codeWide = useStore((s) => s.codeWide)
  const front = useStore((s) => s.front)
  const layout = useLayout()
  const side = layout === 'side'
  const stacked = layout === 'stack' && guide != null
  const sheet = layout === 'sheet' && guide != null
  const frame = useRef<HTMLElement>(null)
  const codePane = useRef<HTMLElement>(null)
  const pane = useRef<HTMLElement>(null)
  const guideWidth = usePaneWidth(pane, GUIDE_STEPS)
  // Guides are mounted when first shown, and kept
  const [seen, setSeen] = useState<Guide[]>(guide ? [guide] : [])
  if (guide && !seen.includes(guide)) setSeen([...seen, guide])
  // where the reviewer dragged the divider to with this Guide on show, as the Guide pane's
  // share of the room (kept for all reviews); until then each Guide starts at its own width
  const widths = useStore((s) => s.guideWidths)
  const reserved = useWide(TREE_RESERVED)
  const pinned = useStore((s) => s.treePinned)
  const place = useTreePlace()
  const treeWidth = useStore((s) => s.treeWidth)
  const stackSplit = useStore((s) => s.stackSplit)
  const guideShown = guide != null && !(stacked && codeWide)
  const codeShown = guide == null || (sheet ? front === 'code' : !guideWide)
  const both = guideShown && codeShown
  const sheetUp = sheet && codeShown
  // The sheet leaves the Guide the upper third: the Guide is scrolled by the least that
  // keeps the pick in view there (now, and once it is laid out: a section opening in
  // place), and put back when the sheet goes down, by as much as it was scrolled for all
  // the picks made while the sheet was up; not if the reviewer has scrolled it meanwhile.
  const picked = useStore((s) => pickKey(s.pick))
  const lift = useRef<Lift | null>(null)
  const parked = useRef(new Map<HTMLElement, Lift>())
  useLayoutEffect(() => {
    let was = lift.current
    // a Guide left while it was lifted (another Guide chosen, the pane closed) cannot be put
    // back while it is hidden: that waits until it is on show again
    if (was && was.sc.getClientRects().length === 0) { parked.current.set(was.sc, was); was = null }
    const here = guide ? document.querySelector<HTMLElement>(`[data-gr-scroll="${guide}"]`) : null
    if (!was && here) { was = parked.current.get(here) ?? null; parked.current.delete(here) }
    const sc = sheetUp ? here : null
    if (!sc) { lift.current = null; if (was) lowerPick(was); return }
    const from = was && was.sc === sc && liftHolds(was) ? { by: was.by, y: was.y } : { by: 0, y: sc.scrollTop }
    const keep = (): void => { lift.current = liftPick(sc, lift.current, from) }
    const frame = window.requestAnimationFrame(keep)
    const timers = [120, 320].map((ms) => window.setTimeout(keep, ms))
    return () => { window.cancelAnimationFrame(frame); timers.forEach((t) => window.clearTimeout(t)) }
  }, [sheetUp, picked, guide])
  // The room Guide and code share is what the tree panel leaves, wherever the tree has a
  // column to be in, whether it is switched on just now or not: hiding the tree gives its
  // room to the code, and the Guide (a diagram laid out for its width) stays as it is.
  // (Its share is taken of what the tree leaves at its usual width: resizing the tree
  // trades room with the code, as hiding it does. Only the least the code is left with
  // counts the tree as wide as it is.)
  const tree = side && both && (reserved || pinned) ? treeWidthLimits.def + TREE_PAD : 0
  const treeNow = side && both && place.column ? treeWidth + TREE_PAD : 0
  const pct = (guide && widths[guide]) ?? GUIDE_START[guide ?? 'conversation']
  const row = <GuideRow loaded={loaded} layout={layout} />
  // `both`: the two panes share the room, with the divider between them (side by side, or stacked);
  // `sheet`: the code is a sheet over the Guide, `up` while it is raised
  const cls = 'workspace' + (both && !sheet ? ' both' : '') + (stacked ? ' stack' : '') + (sheet ? ' sheet' + (sheetUp ? ' up' : '') : '')
  return (
    <main className={cls} ref={frame} style={{ '--guide-w': pct, '--stack-h': stackSplit ?? STACK_START, '--tree-room': `${tree}px`, '--tree-now': `${treeNow}px` } as React.CSSProperties} data-gr="workspace" data-gr-layout={guide == null ? undefined : layout}>
      <section className={'guide-pane' + below(guideWidth, [520, 760, 1000, 1200])} ref={pane} hidden={!guideShown} aria-label="Guide" data-gr-pane="guide">
        {guideShown && row}
        {seen.map((g) => (
          <GuideBody key={g} id={g} shown={guideShown && g === guide}>
            {g === 'walkthrough' ? <WalkthroughGuide loaded={loaded} /> : g === 'conversation' ? <ConversationTab loaded={loaded} /> : g === 'spec' ? <SpecTab loaded={loaded} /> : <VisualTab loaded={loaded} />}
          </GuideBody>
        ))}
      </section>
      {both && !sheet && (stacked
        ? <PaneDivider frame={frame} stacked pct={stackSplit ?? STACK_START} tree={0} treeNow={0} onChange={(v) => useStore.getState().setStackSplit(v)} />
        : <PaneDivider frame={frame} stacked={false} pct={pct} tree={tree} treeNow={treeNow} onChange={(v) => { if (guide) useStore.getState().setGuideWidth(guide, v) }} />)}
      <section className="code-pane" ref={codePane} hidden={!codeShown} aria-label="Code" data-gr-pane="code">
        {sheet && <SheetBar pane={codePane} />}
        {!guideShown && row}
        <FilesTab loaded={loaded} shown={codeShown} />
      </section>
      {codeShown && place.column && <TreePanel loaded={loaded} over={false} />}
      {place.over && place.all && <TreePanel loaded={loaded} over />}
    </main>
  )
}

/** The boxes of a diagram in reading order: row by row from the top, each row from the left.
 *  Boxes whose tops are within a few pixels of each other are one row. */
function readingOrder(els: HTMLElement[]): HTMLElement[] {
  const at = els.map((el) => { const r = (el.querySelector('.viz-box') ?? el).getBoundingClientRect(); return { el, top: r.top, left: r.left, row: 0 } }).sort((a, b) => a.top - b.top)
  let row = 0
  let rowTop = -Infinity
  for (const x of at) { if (x.top - rowTop > 16) { row++; rowTop = x.top } x.row = row }
  return at.sort((a, b) => a.row - b.row || a.left - b.left).map((x) => x.el)
}

// ── page ──────────────────────────────────────────────────────
export function Review() {
  const loaded = useStore((s) => s.loaded)
  const loading = useStore((s) => s.loading)
  const guide = useStore((s) => s.guide)
  // comments, plus the questions asked from a spot, which show at that spot too
  const index = useMemo(() => indexComments([...(loaded?.state.comments ?? []), ...askThreads(loaded?.state.messages ?? [])]), [loaded?.state.comments, loaded?.state.messages])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typingKey(e)) return
      const st = useStore.getState()
      if (e.key === 'c' && hoveredLine()) {
        e.preventDefault()
        st.set({ composer: hoveredLine() })
      } else if (e.key === 'w') {
        // the keys move to the other pane: its scroller takes the focus, so the arrow keys,
        // Page Down and Space scroll it. From nowhere they go to the Guide, when one is open.
        e.preventDefault()
        const inGuide = document.activeElement?.closest('[data-gr-pane="guide"]') != null
        const toCode = st.guide == null || inGuide
        if (toCode) st.revealCode()
        else st.showGuide(st.guide)       // (it comes back on show where the code had the whole height; the sheet over it goes down)
        window.setTimeout(() => document.querySelector<HTMLElement>(toCode ? '[data-gr-scroll="code"]' : `[data-gr-scroll="${st.guide}"]`)?.focus({ preventScroll: true }), 40)
      } else if ((e.key === 'j' || e.key === 'k') && st.guide) {
        // the next (j) or the previous (k) thing to pick in the Guide on show: a box of the
        // diagram with code, in reading order; a section; a link to code in a thread
        const sc = document.querySelector<HTMLElement>(`[data-gr-scroll="${st.guide}"]`)
        const drawn = [...(sc?.querySelectorAll<HTMLElement>('[data-gr-pickable]') ?? [])].filter((el) => el.getClientRects().length > 0)
        if (!drawn.length) return
        e.preventDefault()
        // (A diagram's boxes are read row by row. Their own rectangles say where they are:
        // the pick's ring makes its group a little larger, and must not change the order.)
        const els = st.guide === 'visual' ? readingOrder(drawn) : drawn
        const picked = els.map((el, i) => (el.matches('[data-gr-pick], .picked, [aria-expanded="true"]') ? i : -1)).filter((i) => i >= 0)
        const from = e.key === 'j' ? (picked.length ? picked[picked.length - 1] : -1) : (picked.length ? picked[0] : els.length)
        const next = els[from + (e.key === 'j' ? 1 : -1)]
        if (!next) return
        next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        // (a pick made with the keys is brought into view: there is no pointer on it)
        window.setTimeout(() => showIfOut(next), 160)
      } else if (e.key === 'Escape') {
        // what is open closes first: a comment being written, the tree over the files, a menu
        // or a card (which close themselves); with nothing open, the Guide's pick is cleared
        if (st.composer) st.set({ composer: null })
        else if (st.treeOver) st.set({ treeOver: false })
        else if (document.querySelector('.menu-pop:not([hidden]), [data-gr="visual-card"]') || !st.guide) return
        // (the sheet with the code, on a phone-width window: it goes down, and the pick stays)
        else if (st.front === 'code' && window.innerWidth < SHEET_BELOW) { e.preventDefault(); st.set({ front: 'guide' }) }
        else if (st.picks[st.guide]) { e.preventDefault(); st.clearPick(st.guide) }
        // (this Guide has no pick of its own, but the code is narrowed to another's: all the files again; that pick stays where it was made)
        else if (!st.showAll && st.pick) { const hold = holdCodePlace(); st.showAllFiles(true); hold.settle() }
      }
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
  // `data-gr-tab`: the Guide on show, or `files` while the Guide pane is closed (what the tab was called)
  return (
    <CommentsCtx.Provider value={index}>
      <div className="page review" data-gr-screen="review" data-gr-session={loaded.sessionId || undefined} data-gr-tab={guide ?? 'files'}>
        <ReviewBar loaded={loaded} />
        <RequestsStrip loaded={loaded} />
        <Banners loaded={loaded} />
        <Workspace loaded={loaded} />
      </div>
    </CommentsCtx.Provider>
  )
}
