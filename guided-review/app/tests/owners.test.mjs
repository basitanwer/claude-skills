// A claimed request belongs to the Claude Code session that claimed it. Another session
// on the same repository leaves it alone while its owner is alive and takes it over
// when the owner is gone; the page says "away" once nobody is behind a request; and one
// session cannot stop the shared server from under the others.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeBridge, makeFixture, OWNERLESS, sleep, until } from './helpers.mjs'

let b; let fx; let sid; let first; let second; let r
const presence = async () => (await b.rpc('loadSession', sid)).presence
const request = async (id) => (await b.rpc('loadSession', sid)).state.requests.find((x) => x.id === id)
const got = (l, id) => l.lines.filter((e) => e.type === 'request' && e.id === id)

before(async () => {
  // a session that is not connected counts as alive for one second after its last call
  b = await makeBridge({ GUIDED_REVIEW_OWNER_GRACE_SECONDS: '1' }); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
})
after(async () => { await first?.kill(); await second?.kill(); b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a second session does not receive what the first one is working on', async () => {
  first = b.listener(fx.dir, '--owner', 'session-one')
  await first.next((e) => e.type === 'ready')
  r = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Who has this?' })
  const e = await first.next((x) => x.type === 'request' && x.id === r.id)
  assert.deepEqual([e.resumed, e.yours, e.retried], [false, undefined, undefined])
  assert.equal((await request(r.id)).owner, 'session-one')

  second = b.listener(fx.dir, '--owner', 'session-two')
  await second.next((x) => x.type === 'ready')
  await sleep(1500)
  assert.deepEqual(got(second, r.id), [], 'it is claimed by a session that is still connected')
  assert.equal(await presence(), 'working')
})

test('when its owner is gone, the request is handed to a session that is still there', async () => {
  await first.kill(); first = null
  const e = await second.next((x) => x.type === 'request' && x.id === r.id, 20_000)
  assert.deepEqual([e.resumed, e.yours], [true, false], 'taken over, and marked as somebody else\'s unfinished work')
  assert.equal((await request(r.id)).owner, 'session-two')
  assert.equal(await presence(), 'working')
})

test('the same session starting its listener again gets its own request back, marked as its own', async () => {
  await second.kill()
  second = b.listener(fx.dir, '--owner', 'session-two')
  const e = await second.next((x) => x.type === 'request' && x.id === r.id)
  assert.deepEqual([e.resumed, e.yours], [true, true])
})

test('"Send again" clears the owner and says so when the request is delivered', async () => {
  const from = second.lines.length
  const retried = await b.rpc('requestRetry', sid, r.id)
  assert.deepEqual([retried.status, retried.owner, retried.wasWith], ['pending', undefined, 'session-two'])
  const e = await second.next((x) => x.type === 'request' && x.id === r.id, 10_000, from)
  assert.deepEqual([e.resumed, e.retried], [false, true])
  assert.equal((await request(r.id)).owner, 'session-two')
})

test('one session cannot stop the server while others are connected', async () => {
  const refused = b.try(fx.dir, 'stop')
  assert.equal(refused.code, 1)
  assert.match(refused.err, /not stopped: 1 listening Claude Code session\(s\) connected to this server.*gr stop --force/)
  assert.ok((await b.rpc('info')).pid, 'still running')
})

test('with nobody behind a claimed request the page says away, and reading the review does not change that', async () => {
  await second.kill(); second = null
  await until(async () => (await presence()) === 'away', 20_000)
  assert.equal((await request(r.id)).status, 'running', 'still claimed, by a session that is gone')
  b.gr(fx.dir, 'state', '--session', String(sid))
  b.gr(fx.dir, 'comment', '--session', String(sid), '--file', 'src/a.ts', '--line', '2', '--text', 'a note')
  assert.equal(await presence(), 'away', 'a session reading or commenting is not a session listening')
  // a session that attaches now picks the abandoned request up
  first = b.listener(fx.dir, '--owner', 'session-three')
  const e = await first.next((x) => x.type === 'request' && x.id === r.id)
  assert.deepEqual([e.resumed, e.yours], [true, false])
  // the session it was taken from is told when it reports on it, and cannot finish it
  const late = b.try(fx.dir, 'answer', r.id, '--session', String(sid), '--owner', 'session-two', '--text', 'Me.')
  assert.equal(late.code, 130)
  assert.match(late.err, new RegExp(`^DISPLACED: another Claude Code session now holds request ${r.id} — stop working on it`))
  const batch = b.try(fx.dir, 'batch', '-', '--session', String(sid), '--owner', 'session-two')
  assert.equal(batch.code, 1, 'an empty stdin is a usage error, not a displaced one')
  b.gr(fx.dir, 'answer', r.id, '--session', String(sid), '--owner', 'session-three', '--text', 'I do.')
  assert.equal((await request(r.id)).status, 'done')
})

test('"Send again" goes back to the session that had it when that session is listening', async () => {
  // session-three holds a new request; session-four is listening too
  second = b.listener(fx.dir, '--owner', 'session-four')
  await second.next((x) => x.type === 'ready')
  const q = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Mine?' })
  const holder = await Promise.race([first.next((x) => x.type === 'request' && x.id === q.id).then(() => first), second.next((x) => x.type === 'request' && x.id === q.id).then(() => second)])
  const other = holder === first ? second : first
  for (let i = 0; i < 4; i++) {
    const from = holder.lines.length
    await b.rpc('requestRetry', sid, q.id)
    const e = await holder.next((x) => x.type === 'request' && x.id === q.id, 10_000, from)
    assert.equal(e.retried, true)
  }
  await sleep(500)
  assert.deepEqual(got(other, q.id), [], 'never to the other session')
  b.gr(fx.dir, 'answer', q.id, '--session', String(sid), '--owner', holder === first ? 'session-three' : 'session-four', '--text', 'Yours.')
})

test('a request whose session goes away is handed over even while the review stays busy', async () => {
  await first?.kill(); await second?.kill(); first = second = null
  await sleep(500)        // a claim one of them had under way when it was stopped has landed
  // session-x is connected and holds one request (a listener that is there but idle)
  const x = await b.listen(sid, `bridge=1&listen=1&repo=${encodeURIComponent(fx.dir)}&owner=session-x`)
  const one = await b.rpc('requestCreate', sid, { kind: 'question', text: 'One' })
  assert.deepEqual((await b.rpc('requestTakeAll', fx.dir, false, 'session-x')).map((i) => i.request.id), [one.id])
  // session-y is listening too and holds another request on the same review
  second = b.listener(fx.dir, '--owner', 'session-y')
  await second.next((e) => e.type === 'ready')
  const two = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Two' })
  await second.next((e) => e.type === 'request' && e.id === two.id)
  assert.deepEqual(got(second, one.id), [], 'session-x is connected: its request stays with it')
  assert.equal(await presence(), 'working')
  // session-x goes: the review is still "working" (session-y holds a request), so no
  // change of presence announces it, and session-y is handed the request all the same
  x.close()
  const e = await second.next((ev) => ev.type === 'request' && ev.id === one.id, 30_000)
  assert.deepEqual([e.resumed, e.yours], [true, false])
  assert.equal((await request(two.id)).status, 'running')
  b.batch(fx.dir, [{ op: 'answer', request: one.id, text: 'A.' }, { op: 'answer', request: two.id, text: 'B.' }], '--session', String(sid), '--owner', 'session-y')
  assert.deepEqual([(await request(one.id)).status, (await request(two.id)).status], ['done', 'done'])
})

test('a session without an id: its request is left alone while it is there, and handed over when it is gone', async () => {
  await first?.kill(); await second?.kill(); first = second = null
  await sleep(500)
  const anon = b.listenerWith(OWNERLESS, fx.dir)
  await anon.next((x) => x.type === 'ready')
  const q = await b.rpc('requestCreate', sid, { kind: 'question', text: 'No owner' })
  const e = await anon.next((x) => x.type === 'request' && x.id === q.id)
  assert.equal((await request(q.id)).owner, undefined)
  assert.equal(e.yours, undefined)
  second = b.listener(fx.dir, '--owner', 'session-five')
  await second.next((x) => x.type === 'ready')
  await sleep(1500)
  assert.deepEqual(got(second, q.id), [], 'claimed moments ago by a session that is still there')
  await anon.kill()
  const taken = await second.next((x) => x.type === 'request' && x.id === q.id, 30_000)
  assert.deepEqual([taken.resumed, taken.yours], [true, false])
  assert.equal((await request(q.id)).owner, 'session-five')
  b.gr(fx.dir, 'answer', q.id, '--session', String(sid), '--owner', 'session-five', '--text', 'Now it has.')
})

test('restarting the server does not hand a live session\'s request to another', async () => {
  await first?.kill(); await second?.kill(); first = second = null
  await sleep(500)
  const q = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Across a restart' })
  assert.match(b.gr(fx.dir, 'wait', '--session', String(sid), '--owner', 'session-w', '--timeout', '5'), new RegExp(`REQUEST ${q.id} question`))
  b.stop()
  // the first call after the restart comes from another session, at once
  assert.match(b.gr(fx.dir, 'wait', '--session', String(sid), '--owner', 'session-z', '--timeout', '1'), /no requests/, 'nothing is known about session-w yet: it keeps its request')
  await until(async () => (await b.rpc('info').catch(() => null))?.pid)     // this process still has a connection to the old server
  assert.equal((await request(q.id)).owner, 'session-w')
  b.gr(fx.dir, 'answer', q.id, '--session', String(sid), '--owner', 'session-w', '--text', 'Still mine.')
})
