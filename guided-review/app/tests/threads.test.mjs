// Comment threads are two-way. A reviewer's reply waits (pending) until they send
// their review; an apply request then delivers new comments and new replies together,
// and Claude Code answers in the same thread. Comparisons that cannot be edited still
// take part in the conversation.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { git, makeBridge, makeFixture } from './helpers.mjs'

let b; let fx; let sid; let note
const S = () => ['--session', String(sid)]
const g = (...args) => b.gr(fx.dir, ...args, ...S())
const gj = (...args) => b.json(fx.dir, ...args, ...S())
const comment = (id) => gj('comments').find((c) => c.id === id)
const request = (id) => gj('state').state.requests.find((r) => r.id === id)
const userReply = (id, text) => b.rpc('commentUpdate', sid, id, { reply: { author: 'user', text } })

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
  note = gj('comment', '--file', 'src/a.ts', '--line', '2', '--text', 'Return value changed from 1 to 2.').id
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a reviewer\'s reply on a note from Claude Code is pending until it is sent', async () => {
  const c = await userReply(note, 'Was that intended?')
  assert.deepEqual(c.replies.map((r) => [r.author, r.text, r.pending]), [['user', 'Was that intended?', true]])
  assert.equal(c.status, 'note', 'replying does not change what the comment is')
  assert.match(g('comments'), /↳ user: Was that intended\?  \(pending\)/)
  assert.match(g('state'), /comments: 1 · 1 pending \(written by the reviewer, not sent to Claude Code yet\)/)
  assert.match(b.gr(fx.dir, 'wait', '--timeout', '1', ...S()), /no requests/, 'a pending reply is not a request')
  await assert.rejects(b.rpc('requestCreate', sid, { kind: 'apply', commentIds: ['nope'] }), /none of those comments is waiting to be sent/)
})

test('sending delivers the reply as new; Claude Code answers in the same thread', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [note] })
  assert.deepEqual([r.commentIds, r.replyIds, r.editable, r.commit], [[note], [note], true, false])
  assert.deepEqual([comment(note).status, comment(note).replies[0].pending], ['note', undefined], 'sent: no longer pending, still a note')
  assert.doesNotMatch(g('state'), /pending \(written/)

  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} apply`))
  assert.match(out, new RegExp(`new reply in this thread:\\n  \\[${note}\\] note · agent · src/a\\.ts:2\\n\\s+Return value changed from 1 to 2\\.\\n\\s+↳ user: Was that intended\\?  ← NEW`))
  assert.match(out, new RegExp(`reply in threads with: gr reply <commentId> --session ${sid} --text`))
  assert.match(out, new RegExp(`then: gr done ${r.id} --session ${sid}`))
  assert.match(out, /do NOT commit/)
  const json = b.json(fx.dir, 'wait', '--timeout', '5', ...S()).requests[0]
  assert.deepEqual([json.id, json.resumed, json.comments[0].because], [r.id, true, 'new reply'], 'asked for again before finishing: resumed')
  assert.deepEqual(json.comments[0].replies, [{ author: 'user', text: 'Was that intended?', new: true }])

  assert.match(g('reply', note, '--text', 'Yes: the spec asks for 2.'), new RegExp(`replied to ${note} \\(src/a\\.ts:2\\)`))
  assert.deepEqual(comment(note).replies.map((x) => [x.author, x.text, x.pending]), [['user', 'Was that intended?', undefined], ['agent', 'Yes: the spec asks for 2.', undefined]])
  const done = g('done', r.id)
  assert.match(done, new RegExp(`\\[${note}\\] replied \\(note\\)`))
  assert.equal(request(r.id).status, 'done')
  assert.equal(comment(note).status, 'note', 'a thread sent for a reply is not put back in the queue')
})

test('a second round marks only the newest reply; a new comment and a reply travel in one request', async () => {
  await userReply(note, 'Then say so in a code comment.')
  const fresh = (await b.rpc('commentAdd', sid, { anchor: { kind: 'diff', file: 'src/b.ts', line: 2 }, text: 'Why 43?', author: 'user' })).id
  assert.match(g('state'), /comments: 2 · 2 pending/)
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [note, fresh], text: 'be brief' })
  assert.deepEqual([r.commentIds, r.replyIds], [[note, fresh], [note]])
  assert.equal(comment(fresh).status, 'sent')

  const out = g('wait', '--timeout', '10')
  assert.match(out, /↳ user: Was that intended\?\n\s+↳ agent: Yes: the spec asks for 2\.\n\s+↳ user: Then say so in a code comment\.  ← NEW/, 'only what came after Claude Code last spoke is new')
  assert.match(out, new RegExp(`new comment:\\n  \\[${fresh}\\] sent · user · src/b\\.ts:2\\n\\s+Why 43\\?`))
  assert.match(out, /steer: be brief/)

  // the session edits for the change request, answers the question, and reports
  fs.appendFileSync(`${fx.dir}/src/a.ts`, '// returns 2: see specs/rate-limit/spec.md\n')
  g('reply', note, '--text', 'Added a comment above the constant.')
  g('resolve', fresh, '--verdict', 'skipped', '--note', '43 is the value the plan names; no change.')
  const done = g('done', r.id)
  assert.match(done, new RegExp(`\\[${note}\\] replied \\(note\\)`))
  assert.match(done, new RegExp(`\\[${fresh}\\] skipped — 43 is the value`))
  assert.equal(comment(note).replies.length, 4)
  assert.equal(git(fx.dir, 'status', '--porcelain'), 'M src/a.ts', 'edited, nothing committed')
  git(fx.dir, 'checkout', '--', 'src/a.ts')
})

test('a reply the reviewer writes while a request is running waits for the next send', async () => {
  await userReply(note, 'One.')
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [note] })
  g('wait', '--timeout', '10')
  await userReply(note, 'Two, written while Claude Code was working.')
  const again = b.json(fx.dir, 'wait', '--timeout', '5', ...S()).requests[0]
  assert.deepEqual(again.comments[0].replies.slice(-1), [{ author: 'user', text: 'One.', new: true }], 'the unsent reply is not delivered early')
  assert.match(g('comments'), /Two, written while Claude Code was working\.  \(pending\)/)
  g('reply', note, '--text', 'Answering one.')
  g('done', r.id)
  assert.match(g('state'), /comments: 2 · 1 pending/)
})

test('a new comment Claude Code only replies to becomes answered, not pending again', async () => {
  const asked = (await b.rpc('commentAdd', sid, { anchor: { kind: 'file', file: 'src/c.ts' }, text: 'Is c used anywhere?', author: 'user' })).id
  const ignored = (await b.rpc('commentAdd', sid, { anchor: { kind: 'file', file: 'src/b.ts' }, text: 'Rename b.', author: 'user' })).id
  const pendingBefore = Number(/(\d+) pending/.exec(g('state'))?.[1] ?? 0)
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [asked, ignored] })
  g('wait', '--timeout', '10')
  g('reply', asked, '--text', 'Not yet: nothing imports it.')
  const done = g('done', r.id)
  assert.match(done, new RegExp(`\\[${asked}\\] replied \\(answered: no longer pending\\)`))
  assert.match(done, new RegExp(`\\[${ignored}\\] NOT handled \\(back to queued\\)`))
  assert.deepEqual([comment(asked).status, comment(ignored).status], ['answered', 'queued'], 'answered leaves the queue; an untouched comment returns to it')
  assert.equal(Number(/(\d+) pending/.exec(g('state'))?.[1] ?? 0), pendingBefore - 1, 'only the untouched comment is pending again')
  await assert.rejects(b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [asked] }), /none of those comments is waiting to be sent/, 'an answered comment is not sent again')

  // the reviewer can carry on in the thread: the reply travels as a reply, the thread stays answered
  await userReply(asked, 'Then remove it.')
  const again = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [asked] })
  assert.deepEqual([again.replyIds, comment(asked).status], [[asked], 'answered'])
  g('wait', '--timeout', '10')
  g('resolve', asked, '--verdict', 'skipped', '--note', 'Kept: the plan adds a caller next.')
  g('resolve', ignored, '--verdict', 'skipped', '--note', 'Out of scope.')
  g('done', again.id)
  assert.equal(comment(asked).status, 'resolved')
  await assert.rejects(b.rpc('commentUpdate', sid, ignored, { status: 'answered' }), /only a comment Claude Code replied to/)
})

test('a request the session never finished can be sent again by the reviewer', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Still there?' })
  await assert.rejects(b.rpc('requestRetry', sid, r.id), /is pending, not running/)
  g('wait', '--timeout', '10')
  assert.ok(request(r.id).startedAt)
  const retried = await b.rpc('requestRetry', sid, r.id)
  assert.deepEqual([retried.status, retried.startedAt, retried.progress.at(-1).text], ['pending', undefined, 'Sent again by the reviewer.'])
  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} question`))
  assert.doesNotMatch(out, /resumed/, 'a retried request is delivered as a fresh one')
  g('answer', r.id, '--text', 'Yes.')
  await assert.rejects(b.rpc('requestRetry', sid, r.id), /is done, not running/)
})

test('a comparison that ends at a fixed commit is not editable, and a commit cannot be asked for', async () => {
  const frozen = b.json(fx.dir, 'review', 'HEAD~1..HEAD').sessionId
  const F = ['--session', String(frozen)]
  const n = b.json(fx.dir, 'comment', '--file', 'src/c.ts', '--line', '1', '--text', 'New constant.', ...F).id
  await b.rpc('commentUpdate', frozen, n, { reply: { author: 'user', text: 'Rename it to count.' } })
  const r = await b.rpc('requestCreate', frozen, { kind: 'apply', commentIds: [n], commit: true })
  assert.deepEqual([r.editable, r.commit, r.replyIds], [false, false, [n]])
  const json = b.json(fx.dir, 'wait', '--timeout', '10', ...F).requests[0]
  assert.deepEqual([json.session, json.editable, json.commit, json.workdir], [frozen, false, false, undefined])
  assert.match(json.do, /this comparison cannot be edited/)
  assert.doesNotMatch(json.do, /do NOT commit|make the edits/)
  const out = b.gr(fx.dir, 'wait', '--timeout', '5', ...F)
  assert.match(out, /\(resumed: claimed earlier and never finished\)/)
  assert.match(out, /this comparison cannot be edited \(it ends at a fixed commit, or its branch is not checked out\)/)
  b.gr(fx.dir, 'reply', n, '--text', 'This review is pinned to a commit; open the branch to have it renamed.', ...F)
  assert.match(b.gr(fx.dir, 'done', r.id, ...F), new RegExp(`\\[${n}\\] replied \\(note\\)`))
})
