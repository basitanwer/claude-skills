import { createContext, useContext, useState } from 'react'
import type { AnchorInput, Comment } from '@shared/types'
import { useStore } from '../store'
import { focusAnchor } from '../focus'
import { ago, anchorLabel, focusable, hasPendingReply, isOpen } from '../util'
import { Icon, Md, Menu, MenuItem } from './common'

/** Comments indexed by anchor key (see util.indexComments). */
export const CommentsCtx = createContext<Map<string, Comment[]>>(new Map())
export const useCommentsAt = (key: string): Comment[] => useContext(CommentsCtx).get(key) ?? EMPTY
const EMPTY: Comment[] = []

export const STATUS: Record<Comment['status'], { cls: string; text: string; title: string }> = {
  note: { cls: 'note', text: 'Note', title: 'A remark from Claude. It is not waiting on anyone.' },
  queued: { cls: 'pending', text: 'Pending', title: 'Not sent yet. Use Review to send your pending comments to Claude Code.' },
  sent: { cls: 'sent', text: 'With Claude Code', title: 'Handed to Claude Code to address' },
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
                  {mine && c.status === 'queued' && <MenuItem title="Close it yourself, without sending it to Claude Code" onClick={() => { void updateComment(c.id, { status: 'resolved' }); close() }}>Resolve</MenuItem>}
                  {mine && c.status === 'resolved' && <MenuItem title="Make it pending again" onClick={() => { void updateComment(c.id, { status: 'queued' }); close() }}>Reopen</MenuItem>}
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
          <input name="gr-field" className="reply-stub" placeholder="Reply…" aria-label="Reply" readOnly onFocus={() => { setText(''); setMode('reply') }} />
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
  const setTab = useStore((s) => s.setTab)
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
    void request({ kind: 'question', text: text.trim(), anchor }).then((r) => { setBusy(false); if (r) { close(); setTab('conversation') } })
  }
  return (
    <div className="composer" data-gr="composer" data-gr-composer={k}>
      <textarea name="gr-text" autoFocus rows={3} value={text} placeholder="Leave a comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add(); if (e.key === 'Escape') close() }}
      />
      <div className="row gap end wrap">
        <button className="btn sm" onClick={close}>Cancel</button>
        <button className="btn sm" data-gr="comment-ask" disabled={!text.trim() || busy} onClick={ask} title="Ask Claude Code about this spot. It is delivered when Claude Code is listening; the answer arrives in Conversation.">Ask Claude Code</button>
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
