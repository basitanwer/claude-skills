import { createContext, Fragment, useContext, useEffect, useMemo, useState } from 'react'
import type { AnchorInput, Comment } from '@shared/types'
import { useStore } from '../store'
import { focusAnchor, focusChanged, focusQuestion } from '../focus'
import { ago, anchorLabel, ASK, askExchanges, askStatus, baseName, focusable, fromEarlier, hasPendingReply, isOpen, plural, short } from '../util'
import { Icon, Md, Menu, MenuItem, usePickLink } from './common'

/** Comments indexed by anchor key (see util.indexComments). */
export const CommentsCtx = createContext<Map<string, Comment[]>>(new Map())
export const useCommentsAt = (key: string): Comment[] => useContext(CommentsCtx).get(key) ?? EMPTY
const EMPTY: Comment[] = []

/** What is being written and not sent yet, kept by where it is written (per review),
 *  outside the components that show it. A diff is drawn anew when its pane changes width
 *  enough to go from split to unified, which a Guide opening beside the code does, and
 *  when changed code is folded in: a comment or a reply being typed in it comes back with it. */
const drafts = new Map<string, { mode: string; text: string }>()
const draftKey = (id: string): string => `${useStore.getState().sessionId ?? 'preview'}:${id}`
/** A thread's state of being written in (`idle`: nothing is), with the text so far. */
function useDraft<M extends string>(id: string, idle: M): { mode: M; text: string; setMode: (m: M) => void; setText: (t: string) => void } {
  const [key] = useState(() => draftKey(id))
  const [mode, setMode] = useState<M>(() => (drafts.get(key)?.mode as M | undefined) ?? idle)
  const [text, setText] = useState(() => drafts.get(key)?.text ?? '')
  useEffect(() => { if (mode === idle) drafts.delete(key); else drafts.set(key, { mode, text }) }, [key, mode, text, idle])
  return { mode, text, setMode, setText }
}

export const STATUS: Record<Comment['status'], { cls: string; text: string; title: string }> = {
  note: { cls: 'note', text: 'Note', title: 'A remark from Claude. It is not waiting on anyone.' },
  queued: { cls: 'pending', text: 'Pending', title: 'Not sent yet. Use Review to send your pending comments to Claude Code.' },
  sent: { cls: 'sent', text: 'With Claude Code', title: 'Handed to Claude Code to address' },
  answered: { cls: 'note', text: 'Answered', title: 'Claude Code replied. Nothing is waiting to be sent; reply to continue, or resolve it from the menu.' },
  resolved: { cls: 'resolved', text: 'Resolved', title: 'An outcome was recorded' },
  outdated: { cls: 'outdated', text: 'Outdated', title: 'The line it was written on no longer exists' }
}

export function Who({ author }: { author: 'user' | 'agent' }) {
  return (
    <>
      <span className={'avatar ' + author} aria-hidden="true">{author === 'agent' ? 'C' : 'Y'}</span>
      <strong className="who">{author === 'agent' ? 'Claude' : 'You'}</strong>
    </>
  )
}

/** One review comment with its replies, in GitHub's review-thread shape. Every thread
 *  is two-way: the reviewer can reply at any time; a reply stays "Pending" until the
 *  review is sent, and Claude's answer arrives in the same thread. */
export function Thread({ c, showAnchor }: { c: Comment; showAnchor?: boolean }) {
  return c.id.startsWith(ASK) ? <AskThread c={c} /> : <CommentThread c={c} showAnchor={showAnchor} />
}

/** A question the reviewer asked Claude Code about this spot, with the answer under it,
 *  and every follow-up asked from here with its answer: one thread per first question.
 *  The same exchanges are in the Conversation; here they sit beside what they are about.
 *  A follow-up is not a pending comment: like the question, it goes to Claude Code at once. */
function AskThread({ c }: { c: Comment }) {
  const root = c.id.slice(ASK.length)
  const messages = useStore((s) => s.loaded?.state.messages)
  const requests = useStore((s) => s.loaded?.state.requests)
  const request = useStore((s) => s.request)
  const cancel = useStore((s) => s.cancelRequest)
  const resolved = useStore((s) => Boolean(s.loaded?.state.resolvedAsks?.includes(root)))
  const resolveAsk = useStore((s) => s.resolveAsk)
  // a resolved thread folds away, as a resolved comment does; the reviewer can look into it
  const [shown, setShown] = useState(false)
  // what is being typed is kept outside this component, so neither a background refresh nor the diff being drawn anew loses it
  const { mode, text, setMode, setText } = useDraft<'view' | 'reply'>(`ask:${root}`, 'view')
  const [busy, setBusy] = useState(false)
  const exchanges = useMemo(() => askExchanges(root, messages ?? [], requests ?? []), [root, messages, requests])
  const last = exchanges.at(-1)
  // one question at a time: while an exchange is with Claude Code, the next waits for its answer
  const waiting = exchanges.some((x) => x.request && isOpen(x.request) && x.answers.length === 0)
  const send = (body: string, follows: string, sent?: () => void): void => {
    if (!body.trim() || busy) return
    setBusy(true)
    // what was typed stays if the server refuses, so the text is not lost
    void request({ kind: 'question', text: body.trim(), follows }).then((r) => { setBusy(false); if (r) sent?.() })
  }
  const submit = (): void => { if (last) send(text, last.id, () => { setText(''); setMode('view') }) }
  if (resolved && !shown && !waiting) {
    const answer = exchanges.flatMap((x) => x.answers).at(-1)
    return (
      <div className="thread user ask folded" data-gr-ask={root} data-gr-ask-status="resolved" data-gr-folded="true">
        <div className="thread-main thread-head">
          <Who author="user" />
          <span className="label resolved" title="You resolved this conversation">Question · resolved</span>
          <span className="clip grow muted">{c.text}{answer ? ` — ${answer.text.replace(/\*\*|__|`/g, '').replace(/^\s*(#{1,6}|>)\s+/gm, '').replace(/\s+/g, ' ').slice(0, 200)}` : ''}</span>
          <button className="link small nowrap" data-gr="show-resolved" onClick={() => setShown(true)}>Show resolved</button>
        </div>
      </div>
    )
  }
  return (
    <div className="thread user ask" data-gr-ask={root} data-gr-ask-status={resolved ? 'resolved' : last ? askStatus(last) : 'unknown'}>
      {exchanges.map((x, i) => {
        const st = askStatus(x)
        return (
          <Fragment key={x.id}>
            <div className={'thread-main' + (i ? ' reply user' : '')} data-gr-ask-question={x.id}>
              <div className="thread-head">
                <Who author="user" />
                {i === 0 && <span className="label note" title="A question to Claude Code, not a review comment: it is answered here and is not part of what you send with your review">Question</span>}
                <span className="muted">{ago(x.at)}</span>
                {i === 0 && resolved && <span className="label resolved" title="You resolved this conversation">Resolved</span>}
                <span className="grow" />
                {i === 0 && resolved && <button className="link small nowrap" onClick={() => setShown(false)}>Hide resolved</button>}
                {i === 0 && <button className="link small nowrap" data-gr="ask-in-conversation" title="Show this question and its answer in the Conversation" onClick={() => focusQuestion(root)}>In Conversation</button>}
              </div>
              <div className="thread-body pre-wrap">{x.text}</div>
            </div>
            {x.answers.map((a) => (
              <div key={a.id} className="thread-main reply agent" data-gr-reply="agent">
                <div className="thread-head"><Who author="agent" /><span className="muted">{ago(a.at)}</span></div>
                <Md text={a.text} className="thread-body" />
              </div>
            ))}
            {(st === 'pending' || st === 'running') && (
              <div className="thread-main reply waiting" data-gr="with-claude">
                <span className="spinner" /><span className="muted">{st === 'pending' ? 'Waiting for Claude Code to pick this up' : 'Claude Code is answering'} — the answer will appear here</span>
                <span className="grow" /><button className="link small" onClick={() => void cancel(x.id)}>Cancel</button>
              </div>
            )}
            {(st === 'failed' || st === 'cancelled') && (
              <div className={'thread-main reply waiting ' + st} data-gr="ask-ended">
                {st === 'failed' ? <span className="ask-reason">Claude Code could not answer: {x.request?.error ?? 'no reason given'}</span> : <span className="muted">Cancelled.</span>}
                {/* the latest exchange only: an earlier one was already asked again, or followed by something else */}
                {x === last && <button className="btn sm nowrap" data-gr="ask-again" disabled={busy} title="Send the same question to Claude Code again, in this thread" onClick={() => { setMode('view'); send(x.text, x.id) }}>Ask again</button>}
              </div>
            )}
          </Fragment>
        )
      })}
      {last && !waiting && (
        <div className="thread-foot">
          {mode === 'view' ? (
            <div className="row gap">
              <input name="gr-field" className="reply-stub" data-gr="ask-follow-up" placeholder="Ask a follow-up…" aria-label="Ask a follow-up" readOnly onFocus={() => setMode('reply')} />
              {resolved
                ? <button className="btn sm nowrap" data-gr="ask-unresolve" title="Open this conversation again" onClick={() => { setShown(false); void resolveAsk(root, false) }}>Unresolve conversation</button>
                : <button className="btn sm nowrap" data-gr="ask-resolve" title="You have your answer: fold this conversation away. Asking a follow-up opens it again." onClick={() => { setShown(false); void resolveAsk(root, true) }}>Resolve conversation</button>}
            </div>
          ) : (
            <>
              <textarea name="gr-text" autoFocus value={text} rows={3} placeholder="Ask a follow-up…" aria-label="Ask a follow-up"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); if (e.key === 'Escape') setMode('view') }}
              />
              <div className="row gap end">
                <span className="muted small grow">Goes to Claude Code now, with this thread.</span>
                <button className="btn sm" onClick={() => setMode('view')}>Cancel</button>
                <button className="btn sm primary" data-gr="ask-send" disabled={!text.trim() || busy} title="Ask Claude Code in this thread (⌘/Ctrl + Enter). It is delivered when Claude Code is listening; the answer appears here and in Conversation." onClick={submit}>Ask Claude Code</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** how much of the line a comment was written on is quoted (a minified line runs to 100,000s of characters) */
const LINE_QUOTE = 400
function CommentThread({ c, showAnchor }: { c: Comment; showAnchor?: boolean }) {
  const updateComment = useStore((s) => s.updateComment)
  const removeComment = useStore((s) => s.removeComment)
  // handed to Claude Code in a request that is not finished yet
  const sentAt = useStore((s) => (s.loaded?.state.requests ?? []).find((r) => isOpen(r) && r.commentIds?.includes(c.id))?.createdAt)
  const withClaude = sentAt !== undefined
  // a finding is about the code as it was when Claude Code found it: once the code has changed, it says so
  const earlier = useStore((s) => Boolean(c.finding) && fromEarlier(c.foundAt, s.loaded))
  const { mode, text, setMode, setText } = useDraft<'view' | 'edit' | 'reply'>(`thread:${c.id}`, 'view')
  const [toggled, setToggled] = useState<boolean | null>(null)
  const target = focusable(c.anchor)
  // in a Guide (the Conversation), the link to its line is a pick
  const link = usePickLink(target)
  const st = STATUS[c.status]
  const mine = c.author === 'user'
  const pendingReply = hasPendingReply(c)
  // the reviewer closes and reopens their own threads; one Claude Code is working on waits
  const canResolve = mine && (c.status === 'queued' || c.status === 'answered') && !withClaude
  const canReopen = mine && c.status === 'resolved' && !withClaude
  // Reopened, a thread Claude Code only replied to is open again as answered. One it
  // recorded an outcome for, or never saw, becomes pending: it can be sent (again).
  const reopenTo = !c.resolution && c.replies.some((r) => r.author === 'agent') ? 'answered' : 'queued'
  // A resolved thread folds away, as on GitHub — unless the conversation went on after
  // it was resolved: a reply waiting to be sent, one being handled, or Claude's answer.
  const lastReply = c.replies.at(-1)
  // Claude already answered in this round; the request may still be open for other threads
  const answered = Boolean(withClaude && lastReply?.author === 'agent' && lastReply.at >= (sentAt ?? ''))
  const moved = pendingReply || withClaude || Boolean(lastReply && c.resolution && lastReply.at > c.resolution.at)
  const live = `${c.replies.length}:${pendingReply}:${withClaude}`
  const [seen, setSeen] = useState(live)
  if (seen !== live) { setSeen(live); if (moved) setToggled(null) }      // new activity re-opens a thread the reviewer folded
  const open = toggled ?? (c.status !== 'resolved' || moved || mode !== 'view')
  const submit = (): void => {
    const body = text.trim()
    if (!body) return
    void updateComment(c.id, mode === 'edit' ? { text: body } : { reply: { author: 'user', text: body } })
    setMode('view')
    setText('')
  }
  const cls = 'thread ' + c.author + ' ' + st.cls + (pendingReply ? ' pending' : '')
  // where the fix is, when the session said so: one chip per range, each a jump to those lines
  const changed = c.resolution?.changed ?? []
  const places = changed.length + (c.resolution?.changedMore ?? 0)
  if (!open) {
    return (
      <div className={cls + ' folded'} data-gr-comment={c.id} data-gr-status={c.status} data-gr-folded="true">
        <div className={'thread-main thread-head' + (places > 0 ? ' has-changes' : '')}>
          <Who author={c.author} />
          <span className={'label ' + st.cls} title={st.title}>{st.text}{c.resolution ? ` · ${c.resolution.verdict}` : ''}</span>
          <span className="clip grow muted">{c.resolution?.note || c.text}</span>
          {places > 0 && <span className="muted small nowrap" data-gr="changed-count" title="Places in the code Claude Code changed for this comment: show the thread to go to them">· {plural(places, 'change')}</span>}
          <button className="link small nowrap" data-gr="show-resolved" onClick={() => setToggled(true)}>Show resolved</button>
        </div>
      </div>
    )
  }
  return (
    <div className={cls} data-gr-comment={c.id} data-gr-status={c.status} data-gr-pending-reply={pendingReply ? 'true' : undefined}>
      <div className="thread-main">
        <div className="thread-head">
          <Who author={c.author} />
          <span className="muted">{ago(c.createdAt)}</span>
          <span className={'label ' + st.cls} title={st.title}>
            {st.text}{c.status === 'resolved' && c.resolution ? ` · ${c.resolution.verdict}` : ''}
          </span>
          {c.finding && <span className="label finding" data-gr="finding" title={c.finding === 'bug' ? 'A defect the bug hunt found by reading the code. Nothing was run to confirm it.' : 'A statement this change made false. The Fact check list in the walkthrough has all of them.'}>{c.finding === 'bug' ? 'Bug' : 'Fact check'}</span>}
          {earlier && <span className="label warn" data-gr="earlier-state" title={`Found at ${short(c.foundAt?.sha)}. The code has changed since, and this was not checked again: it may no longer apply.`}>found at <span className="mono">{short(c.foundAt?.sha)}</span>, an earlier state</span>}
          {showAnchor && (
            target && !c.lineGone && c.status !== 'outdated'
              ? <button className={'link mono small' + (link.picked ? ' picked' : '')} aria-pressed={link.from ? link.picked : undefined} data-gr-pickable={link.from && (target.kind === 'file' || target.kind === 'diff') ? '' : undefined} onClick={() => focusAnchor(target, { from: link.from })}>{anchorLabel(c.anchor)}</button>
              : <span className="mono muted small">{anchorLabel(c.anchor)}</span>
          )}
          <span className="grow" />
          {c.status === 'resolved' && <button className="link small nowrap" onClick={() => setToggled(false)}>Hide resolved</button>}
          {c.status !== 'sent' && (
            <Menu label={<Icon name="kebab" />} className="icon-btn" title="Comment actions" align="right">
              {(close) => (
                <>
                  {mine && <MenuItem onClick={() => { setText(c.text); setMode('edit'); close() }}>Edit</MenuItem>}
                  {mine && (c.status === 'queued' || c.status === 'answered') && <MenuItem title={c.status === 'queued' ? 'Close it yourself, without sending it to Claude Code' : 'Close the thread'} onClick={() => { void updateComment(c.id, { status: 'resolved' }); close() }}>Resolve</MenuItem>}
                  {canReopen && <MenuItem title={reopenTo === 'queued' ? 'Make it pending again' : 'Open the thread again'} onClick={() => { void updateComment(c.id, { status: reopenTo }); close() }}>Reopen</MenuItem>}
                  <MenuItem danger onClick={() => { void removeComment(c.id); close() }}>Delete</MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
        {showAnchor && (c.anchor.kind === 'diff' || c.anchor.kind === 'artifact') && c.anchor.lineContent && (
          <pre className="thread-line" data-gr="comment-line">{c.anchor.lineContent.length > LINE_QUOTE ? c.anchor.lineContent.slice(0, LINE_QUOTE) + '…' : c.anchor.lineContent}</pre>
        )}
        {mode !== 'edit' && <Md text={c.text} className="thread-body" />}
        {c.resolution && (
          <div className={'resolution ' + c.resolution.verdict} data-gr="resolution">
            <Icon name="check" size={14} />
            <span><strong>{c.resolution.verdict}</strong>{c.resolution.note ? ` — ${c.resolution.note}` : ''}</span>
            {c.resolution.commit && <span className="mono muted" title="The commit that addressed it">{c.resolution.commit.slice(0, 7)}</span>}
            <span className="muted">{ago(c.resolution.at)}</span>
            {changed.length > 0 && (
              <span className="changed-list" data-gr="changed">
                <span className="muted small">Changed</span>
                {changed.map((r, i) => {
                  const lines = r.end > r.start ? `${r.start}–${r.end}` : `${r.start}`
                  return <button key={i} className="ref-chip mono link-chip" data-gr="changed-chip" title={`${r.file}:${lines} — show ${r.end > r.start ? 'these lines' : 'this line'} in the Code pane`} onClick={() => void focusChanged(r, link.from)}>{baseName(r.file)}:{lines}</button>
                })}
                {places > changed.length && <span className="muted small" title="The commit changed more places than a resolution keeps">+{places - changed.length} more{c.resolution.commit ? ` in ${c.resolution.commit.slice(0, 7)}` : ''}</span>}
              </span>
            )}
          </div>
        )}
      </div>
      {c.replies.map((r, i) => (
        <div key={i} className={'thread-main reply ' + r.author + (r.pending ? ' pending' : '')} data-gr-reply={r.pending ? 'pending' : r.author}>
          <div className="thread-head">
            <Who author={r.author} /><span className="muted">{ago(r.at)}</span>
            {r.pending && <span className="label pending" title="Not sent yet. It goes to Claude Code when you send your review.">Pending</span>}
          </div>
          <Md text={r.text} className="thread-body" />
        </div>
      ))}
      {withClaude && !answered && (
        <div className="thread-main reply waiting" data-gr="with-claude">
          <span className="spinner" /><span className="muted">With Claude Code — its reply will appear here</span>
        </div>
      )}
      <div className="thread-foot">
        {mode === 'view' ? (
          <div className="row gap">
            <input name="gr-field" className="reply-stub" placeholder="Reply…" aria-label="Reply" readOnly onFocus={() => { setText(''); setMode('reply') }} />
            {canResolve && <button className="btn sm nowrap" data-gr="thread-resolve" title="Close this thread yourself. It folds away; nothing is sent to Claude Code." onClick={() => void updateComment(c.id, { status: 'resolved' })}><Icon name="check" size={14} /> Resolve</button>}
            {canReopen && <button className="btn sm nowrap" data-gr="thread-reopen" title={reopenTo === 'queued' ? 'Open it again as a pending comment, to send to Claude Code' : 'Open the thread again'} onClick={() => void updateComment(c.id, { status: reopenTo })}>Reopen</button>}
          </div>
        ) : (
          <>
            <textarea name="gr-text" autoFocus value={text} rows={3} placeholder={mode === 'reply' ? 'Reply…' : ''}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); if (e.key === 'Escape') setMode('view') }}
            />
            <div className="row gap end">
              {mode === 'reply' && <span className="muted small grow">Stays pending until you send your review.</span>}
              <button className="btn sm" onClick={() => setMode('view')}>Cancel</button>
              <button className="btn sm primary" data-gr="reply-add" disabled={!text.trim()} onClick={submit}>{mode === 'edit' ? 'Update comment' : 'Add reply'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function Composer({ anchor, k }: { anchor: AnchorInput; k: string }) {
  const addComment = useStore((s) => s.addComment)
  const request = useStore((s) => s.request)
  const set = useStore((s) => s.set)
  // (kept while the composer is elsewhere or its diff is drawn anew; dropped when it is sent or cancelled)
  const [key] = useState(() => draftKey(`composer:${k}`))
  const [text, write] = useState(() => drafts.get(key)?.text ?? '')
  const setText = (t: string): void => { write(t); if (t) drafts.set(key, { mode: 'open', text: t }); else drafts.delete(key) }
  const [busy, setBusy] = useState(false)
  const close = (): void => { drafts.delete(key); set({ composer: null }) }
  const add = (): void => {
    if (!text.trim() || busy) return
    setBusy(true)
    // stays open if the server refuses the anchor, so the text is not lost
    void addComment(anchor, text).then((id) => { setBusy(false); if (id) close() })
  }
  const ask = (): void => {
    if (!text.trim() || busy) return
    setBusy(true)
    // the question and its answer show right here (and in Conversation): stay put
    void request({ kind: 'question', text: text.trim(), anchor }).then((r) => { setBusy(false); if (r) close() })
  }
  return (
    <div className="composer" data-gr="composer" data-gr-composer={k}>
      <textarea name="gr-text" autoFocus rows={3} value={text} placeholder="Leave a comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); if (e.key === 'Escape') close() }}
      />
      <div className="row gap end wrap">
        <button className="btn sm" onClick={close}>Cancel</button>
        <button className="btn sm" data-gr="comment-ask" disabled={!text.trim() || busy} onClick={ask} title="Ask Claude Code about this spot. It is delivered when Claude Code is listening; the answer appears here and in Conversation.">Ask Claude Code</button>
        <button className="btn sm primary" data-gr="comment-add" disabled={!text.trim() || busy} onClick={add} title="Add as a pending comment (⌘/Ctrl + Enter). Nothing is sent until you submit your review.">Add comment</button>
      </div>
    </div>
  )
}

/** The threads at one non-line anchor, plus the composer when it is open there. */
export function CommentSlot({ anchor, k }: { anchor: AnchorInput; k: string }) {
  const comments = useCommentsAt(k)
  const open = useStore((s) => s.composer === k)
  if (comments.length === 0 && !open) return null
  return (
    <div className="thread-slot">
      {comments.map((c) => <Thread key={c.id} c={c} />)}
      {open && <Composer anchor={anchor} k={k} />}
    </div>
  )
}

/** A small "comment here" icon button for non-line anchors. */
export function CommentButton({ k, title }: { k: string; title: string }) {
  const set = useStore((s) => s.set)
  return <button className="icon-btn" title={title} aria-label={title} onClick={() => set({ composer: k })}><Icon name="comment" /></button>
}
