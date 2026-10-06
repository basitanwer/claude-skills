import { createContext, useContext, useState } from 'react'
import type { AnchorInput, Comment } from '@shared/types'
import { useStore } from '../store'
import { focusAnchor } from '../focus'
import { ago, anchorLabel, ASK, focusable, hasPendingReply, isOpen } from '../util'
import { Icon, Md, Menu, MenuItem } from './common'

/** Comments indexed by anchor key (see util.indexComments). */
export const CommentsCtx = createContext<Map<string, Comment[]>>(new Map())
export const useCommentsAt = (key: string): Comment[] => useContext(CommentsCtx).get(key) ?? EMPTY
const EMPTY: Comment[] = []

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

/** A question the reviewer asked Claude Code about this spot, with the answer under it.
 *  The same exchange is in the Conversation tab; here it sits beside what it is about. */
function AskThread({ c }: { c: Comment }) {
  const request = useStore((s) => s.loaded?.state.requests.find((r) => r.id === c.id.slice(ASK.length)))
  const cancel = useStore((s) => s.cancelRequest)
  const setTab = useStore((s) => s.setTab)
  const waiting = Boolean(request && isOpen(request)) && c.replies.length === 0
  return (
    <div className="thread user ask" data-gr-ask={request?.id} data-gr-ask-status={c.replies.length ? 'answered' : request?.status ?? 'unknown'}>
      <div className="thread-main">
        <div className="thread-head">
          <Who author="user" />
          <span className="label note" title="A question to Claude Code, not a review comment: it is answered here and is not part of what you send with your review">Question</span>
          <span className="muted">{ago(c.createdAt)}</span>
          <span className="grow" />
          <button className="link small nowrap" title="The same question and answer in the Conversation tab" onClick={() => setTab('conversation')}>In Conversation</button>
        </div>
        <div className="thread-body pre-wrap">{c.text}</div>
      </div>
      {c.replies.map((r, i) => (
        <div key={i} className="thread-main reply agent" data-gr-reply="agent">
          <div className="thread-head"><Who author="agent" /><span className="muted">{ago(r.at)}</span></div>
          <Md text={r.text} className="thread-body" />
        </div>
      ))}
      {waiting && request && (
        <div className="thread-main reply waiting" data-gr="with-claude">
          <span className="spinner" /><span className="muted">{request.status === 'pending' ? 'Waiting for Claude Code to pick this up' : 'Claude Code is answering'} — the answer will appear here</span>
          <span className="grow" /><button className="link small" onClick={() => void cancel(request.id)}>Cancel</button>
        </div>
      )}
      {c.replies.length === 0 && request?.status === 'failed' && <div className="thread-main reply waiting"><span className="muted">Claude Code could not answer: {request.error ?? 'no reason given'}</span></div>}
      {c.replies.length === 0 && request?.status === 'cancelled' && <div className="thread-main reply waiting"><span className="muted">Cancelled.</span></div>}
    </div>
  )
}

function CommentThread({ c, showAnchor }: { c: Comment; showAnchor?: boolean }) {
  const updateComment = useStore((s) => s.updateComment)
  const removeComment = useStore((s) => s.removeComment)
  // handed to Claude Code in a request that is not finished yet
  const sentAt = useStore((s) => (s.loaded?.state.requests ?? []).find((r) => isOpen(r) && r.commentIds?.includes(c.id))?.createdAt)
  const withClaude = sentAt !== undefined
  const [mode, setMode] = useState<'view' | 'edit' | 'reply'>('view')
  const [text, setText] = useState('')
  const [toggled, setToggled] = useState<boolean | null>(null)
  const target = focusable(c.anchor)
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
  if (!open) {
    return (
      <div className={cls + ' folded'} data-gr-comment={c.id} data-gr-status={c.status} data-gr-folded="true">
        <div className="thread-main thread-head">
          <Who author={c.author} />
          <span className={'label ' + st.cls} title={st.title}>{st.text}{c.resolution ? ` · ${c.resolution.verdict}` : ''}</span>
          <span className="clip grow muted">{c.resolution?.note || c.text}</span>
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
          {showAnchor && (
            target && !c.lineGone && c.status !== 'outdated'
              ? <button className="link mono small" onClick={() => focusAnchor(target)}>{anchorLabel(c.anchor)}</button>
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
          <pre className="thread-line" data-gr="comment-line">{c.anchor.lineContent}</pre>
        )}
        {mode !== 'edit' && <Md text={c.text} className="thread-body" />}
        {c.resolution && (
          <div className={'resolution ' + c.resolution.verdict} data-gr="resolution">
            <Icon name="check" size={14} />
            <span><strong>{c.resolution.verdict}</strong>{c.resolution.note ? ` — ${c.resolution.note}` : ''}</span>
            {c.resolution.commit && <span className="mono muted" title="The commit that addressed it">{c.resolution.commit.slice(0, 7)}</span>}
            <span className="muted">{ago(c.resolution.at)}</span>
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
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const close = (): void => set({ composer: null })
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
