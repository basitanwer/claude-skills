// A question asked from a spot opens a thread there, and the thread is a conversation:
// the reviewer follows up in it, and a follow-up reaches the session with everything
// said in the thread before it. A question that failed or was cancelled can be asked
// again in the same thread.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeBridge, makeFixture } from './helpers.mjs'

let b; let fx; let sid; let l; let q; let f1; let f2
const S = () => ['--session', String(sid)]
const ask = (text, extra = {}) => b.rpc('requestCreate', sid, { kind: 'question', text, ...extra })
const state = async () => (await b.rpc('loadSession', sid)).state
const messageOf = async (id) => (await state()).messages.find((m) => m.role === 'user' && m.requestId === id)
const answer = (id, text) => b.gr(fx.dir, 'answer', id, '--text', text, ...S())
const delivered = (id) => l.next((e) => e.type === 'request' && e.id === id)
const how = (id) => `answer with: gr answer ${id} --session ${sid} --text "…" [--file P --line N]`
const LINE = { label: 'src/a.ts:2', line: '  return 2' }

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
  l = b.listener(fx.dir)
  await l.next((e) => e.type === 'ready')
})
after(async () => { await l?.kill(); b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a first question is stored and delivered exactly as before: it is its own thread', async () => {
  q = await ask('What does this line do?', { anchor: { kind: 'diff', file: 'src/a.ts', line: 2 } })
  assert.deepEqual(Object.keys(q).sort(), ['anchor', 'createdAt', 'id', 'kind', 'progress', 'status', 'text'])
  assert.deepEqual(await delivered(q.id), { type: 'request', session: sid, id: q.id, kind: 'question', resumed: false, text: 'What does this line do?', anchor: LINE, do: how(q.id) })
  assert.equal('threadId' in await messageOf(q.id), false)
  answer(q.id, 'It is the new return value.')
})

test('a follow-up joins the thread, takes its anchor, and is delivered with the exchange so far', async () => {
  f1 = await ask('Why 2 and not 3?', { follows: q.id })
  assert.deepEqual([f1.kind, f1.status, f1.follows, f1.threadId], ['question', 'pending', q.id, q.id])
  assert.deepEqual(f1.anchor, q.anchor, 'asked from the thread, so about the same line')
  const m = await messageOf(f1.id)
  assert.deepEqual([m.text, m.threadId, m.anchor], ['Why 2 and not 3?', q.id, q.anchor], 'the stored message says which thread it is in')
  assert.deepEqual(await delivered(f1.id), {
    type: 'request', session: sid, id: f1.id, kind: 'question', resumed: false, text: 'Why 2 and not 3?', anchor: LINE, follows: q.id,
    thread: [{ role: 'user', text: 'What does this line do?' }, { role: 'agent', text: 'It is the new return value.' }],
    do: how(f1.id)
  })
  // the completing command is the one every question has
  answer(f1.id, 'The spec asks for 2.')
  assert.deepEqual((await state()).requests.map((r) => r.status), ['done', 'done'])
})

test('a follow-up to a follow-up is still the first question\'s thread and carries all of it', async () => {
  // something else asked meanwhile, at another spot, is not part of the thread
  const other = await ask('Is b() tested?', { anchor: { kind: 'file', file: 'src/b.ts' } })
  await delivered(other.id)
  answer(other.id, 'No.')
  f2 = await ask('Where does the spec say that?', { follows: f1.id })
  assert.deepEqual([f2.follows, f2.threadId], [f1.id, q.id], 'it follows the follow-up; the thread is the first question\'s')
  assert.deepEqual(f2.anchor, q.anchor)
  assert.equal((await messageOf(f2.id)).threadId, q.id)
  const e = await delivered(f2.id)
  assert.equal(e.follows, f1.id)
  assert.deepEqual(e.thread, [
    { role: 'user', text: 'What does this line do?' }, { role: 'agent', text: 'It is the new return value.' },
    { role: 'user', text: 'Why 2 and not 3?' }, { role: 'agent', text: 'The spec asks for 2.' }
  ])
  answer(f2.id, 'In specs/rate-limit/spec.md.')
})

test('the anchor is the thread\'s unless the follow-up names its own; a thread without one has none', async () => {
  const moved = await ask('And this file?', { follows: f2.id, anchor: { kind: 'file', file: 'src/b.ts' } })
  assert.deepEqual([moved.anchor, moved.threadId], [{ kind: 'file', file: 'src/b.ts' }, q.id], 'its own anchor, the same thread')
  await b.rpc('requestCancel', sid, moved.id)
  // asked in the Conversation box: no spot, and a follow-up invents none
  const general = await ask('What is this change for?')
  const more = await ask('Who asked for it?', { follows: general.id })
  assert.deepEqual([more.anchor, more.threadId, (await messageOf(more.id)).anchor], [undefined, general.id, undefined])
  const e = await delivered(more.id)
  assert.deepEqual([e.anchor, e.follows, e.thread], [undefined, general.id, [{ role: 'user', text: 'What is this change for?' }]], 'the question it follows is not answered yet: it is there on its own')
  for (const r of [general, more]) answer(r.id, 'See the spec.')
})

test('what it follows has to be a question of this review', async () => {
  const w = await b.rpc('requestCreate', sid, { kind: 'walkthrough' })
  const before = await state()
  await assert.rejects(ask('And then?', { follows: 'r999' }), /cannot follow up on r999: this review has no such request/)
  await assert.rejects(ask('And then?', { follows: w.id }), new RegExp(`cannot follow up on ${w.id}: it is a walkthrough request, not a question`))
  const now = await state()
  assert.deepEqual([now.requests.length, now.messages.length], [before.requests.length, before.messages.length], 'a refused follow-up leaves nothing behind')
  await b.rpc('requestCancel', sid, w.id)
})

test('a cancelled question can be asked again in its thread, and so can a failed one', async () => {
  const first = await ask('Is J used anywhere?', { anchor: { kind: 'diff', file: 'src/a.ts', line: 7 } })
  await delivered(first.id)
  await b.rpc('requestCancel', sid, first.id)
  const again = await ask(first.text, { follows: first.id })
  assert.deepEqual([again.text, again.follows, again.threadId, again.anchor], ['Is J used anywhere?', first.id, first.id, first.anchor])
  const e = await delivered(again.id)
  assert.deepEqual([e.follows, e.thread], [first.id, [{ role: 'user', text: 'Is J used anywhere?' }]], 'the cancelled question is in the thread, with no answer')
  b.gr(fx.dir, 'fail', again.id, '--text', 'The search index is not built.', ...S())
  const third = await ask(first.text, { follows: again.id })
  assert.deepEqual([third.follows, third.threadId], [again.id, first.id])
  assert.deepEqual((await delivered(third.id)).thread, [{ role: 'user', text: 'Is J used anywhere?' }, { role: 'user', text: 'Is J used anywhere?' }])
  answer(third.id, 'No, nothing imports it.')
  const mine = (await state()).requests.filter((r) => (r.threadId ?? r.id) === first.id)
  assert.deepEqual(mine.map((r) => [r.status, r.error]), [['cancelled', undefined], ['failed', 'The search index is not built.'], ['done', undefined]], 'what happened to each attempt is kept')
})

test('gr wait prints the thread before the follow-up; a first question prints as it always did', async () => {
  await l.kill(); l = null
  const next = await ask('Is it safe\nto remove J?', { follows: q.id })
  const plain = await ask('Anything else?')
  const out = b.gr(fx.dir, 'wait', '--timeout', '5', ...S())
  // (the listener that was just stopped may have claimed them as it went: a line in
  // brackets then says the request is resumed, which is not what this test is about)
  const block = (id) => out.split('\n\n').find((x) => x.startsWith(`REQUEST ${id} question`)).split('\n').slice(2).filter((x) => !x.startsWith('  ('))
  assert.deepEqual(block(next.id), [
    `  a follow-up to ${q.id}; earlier in this thread:`,
    '    user: What does this line do?', '    agent: It is the new return value.',
    '    user: Why 2 and not 3?', '    agent: The spec asks for 2.',
    '    user: Where does the spec say that?', '    agent: In specs/rate-limit/spec.md.',
    '    user: And this file?',
    '  the reviewer now asks:', '  Is it safe', 'to remove J?', '  about: src/a.ts:2 — "  return 2"', `  ${how(next.id)}`
  ])
  assert.deepEqual(block(plain.id), ['  Anything else?', `  ${how(plain.id)}`])
  // the same two as JSON (`gr wait --json` re-delivers what this session holds)
  const { requests } = b.json(fx.dir, 'wait', '--timeout', '5', ...S())
  const [n, p] = [requests.find((r) => r.id === next.id), requests.find((r) => r.id === plain.id)]
  assert.deepEqual([n.follows, n.thread.length, n.thread.at(-1)], [q.id, 7, { role: 'user', text: 'And this file?' }])
  assert.deepEqual(Object.keys(p), ['type', 'session', 'id', 'kind', 'resumed', 'yours', 'text', 'do'])
  for (const r of [next, plain]) answer(r.id, 'Yes.')
})

test('a Question thread can be resolved and opened again; a follow-up opens it', async () => {
  const resolved = async () => (await state()).resolvedAsks
  assert.deepEqual(await resolved(), [])
  assert.deepEqual((await b.rpc('askResolve', sid, q.id, true)).resolvedAsks, [q.id])
  await b.rpc('askResolve', sid, q.id, true)
  assert.deepEqual(await resolved(), [q.id], 'resolving twice keeps one entry')
  await b.rpc('askResolve', sid, q.id, false)
  assert.deepEqual(await resolved(), [])
  // only a thread's first question names it, and only a question can be resolved
  await assert.rejects(b.rpc('askResolve', sid, f1.id, true), /is a follow-up: a thread is resolved by its first question/)
  await assert.rejects(b.rpc('askResolve', sid, 'r999', true), /no question r999/)

  await b.rpc('askResolve', sid, q.id, true)
  const again = await ask('One more thing?', { follows: q.id })
  assert.deepEqual(await resolved(), [], 'the conversation went on, so the thread is open again')
  await assert.rejects(b.rpc('askResolve', sid, q.id, true), /has not answered in this thread yet/)
  answer(again.id, 'Nothing more.')
  assert.deepEqual((await b.rpc('askResolve', sid, q.id, true)).resolvedAsks, [q.id])
})
