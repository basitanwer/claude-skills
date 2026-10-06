// `gr listen` is the persistent listener a Claude Code Monitor runs: one JSON line per
// event, for every review of the repository, for as long as it lives. It re-delivers
// what a previous session left unfinished and survives the server going away.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { commit, makeBridge, makeFixture, sleep, until, write } from './helpers.mjs'

let b; let fx; let A; let B; let l
const requests = (from = 0) => l.lines.slice(from).filter((e) => e.type === 'request')
const presence = async (id) => (await b.rpc('loadSession', id)).presence

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  A = b.json(fx.dir, 'review', 'main..feature').sessionId
  B = b.json(fx.dir, 'review', 'v0..feature').sessionId
})
after(async () => { await l?.kill(); b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('it announces itself, and both reviews of the repository show Claude Code as listening', async () => {
  assert.deepEqual([await presence(A), await presence(B)].map((p) => p === 'listening'), [false, false])
  l = b.listener(fx.dir)
  const ready = await l.next((e) => e.type === 'ready')
  assert.equal(l.lines[0], ready, 'ready is the first line')
  assert.equal(ready.repo, fx.dir)
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/#\/repo\?path=/)
  assert.deepEqual([...ready.reviews].sort(), [A, B].sort())
  await until(async () => (await presence(A)) === 'listening' && (await presence(B)) === 'listening')
})

test('one line per request, from either review, with the exact commands that complete it', async () => {
  const q = await b.rpc('requestCreate', A, { kind: 'question', text: 'What does this line do?', anchor: { kind: 'diff', file: 'src/a.ts', line: 2 } })
  const w = await b.rpc('requestCreate', B, { kind: 'walkthrough', text: 'short please' })
  const [qe, we] = [await l.next((e) => e.type === 'request' && e.id === q.id && e.session === A), await l.next((e) => e.type === 'request' && e.id === w.id && e.session === B)]
  assert.deepEqual(qe, {
    type: 'request', session: A, id: q.id, kind: 'question', resumed: false, text: 'What does this line do?',
    anchor: { label: 'src/a.ts:2', line: '  return 2' }, do: `answer with: gr answer ${q.id} --session ${A} --text "…" [--file P --line N]`
  })
  assert.deepEqual([we.kind, we.update, we.text, we.resumed], ['walkthrough', false, 'short please', false])
  assert.equal(we.do, `write the walkthrough, then: gr annotate --file <json> --request ${w.id} --session ${B}`)
  assert.equal(requests().length, 2, 'each request is printed once')
  assert.deepEqual((await b.rpc('loadSession', A)).state.requests.map((r) => r.status), ['running'], 'printed means claimed')
  // completing one with the command from `do` works as printed
  b.gr(fx.dir, 'answer', q.id, '--session', String(A), '--text', 'It is the new return value.')
  assert.equal((await b.rpc('loadSession', A)).state.requests[0].status, 'done')
})

test('an apply request carries the threads, says which replies are new, and how to finish', async () => {
  const note = b.json(fx.dir, 'comment', '--file', 'src/a.ts', '--line', '2', '--text', 'Changed from 1.', '--session', String(A)).id
  await b.rpc('commentUpdate', A, note, { reply: { author: 'user', text: 'On purpose?' } })
  const queued = (await b.rpc('commentAdd', A, { anchor: { kind: 'file', file: 'src/b.ts' }, text: 'Needs a test.', author: 'user' })).id
  const from = l.lines.length
  const r = await b.rpc('requestCreate', A, { kind: 'apply', commentIds: [note, queued] })
  const e = await l.next((x) => x.type === 'request' && x.id === r.id, 10_000, from)
  assert.deepEqual([e.session, e.kind, e.commit, e.editable, e.workdir], [A, 'apply', false, true, fx.dir])
  assert.deepEqual(e.comments, [
    { id: note, status: 'note', author: 'agent', where: 'src/a.ts:2', line: '  return 2', because: 'new reply', text: 'Changed from 1.', replies: [{ author: 'user', text: 'On purpose?', new: true }] },
    { id: queued, status: 'sent', author: 'user', where: 'src/b.ts', because: 'new comment', text: 'Needs a test.', replies: [] }
  ])
  assert.match(e.do, new RegExp(`gr reply <commentId> --session ${A} .*gr resolve <commentId> --session ${A} .*then: gr done ${r.id} --session ${A} · do NOT commit`))
  b.gr(fx.dir, 'reply', note, '--text', 'Yes.', '--session', String(A))
  b.gr(fx.dir, 'resolve', queued, '--verdict', 'skipped', '--note', 'Out of scope.', '--session', String(A))
  b.gr(fx.dir, 'done', r.id, '--session', String(A))
})

test('a request the reviewer cancels after it was claimed is announced', async () => {
  const from = l.lines.length
  const r = await b.rpc('requestCreate', A, { kind: 'question', text: 'Never mind' })
  await l.next((e) => e.type === 'request' && e.id === r.id, 10_000, from)
  await b.rpc('requestCancel', A, r.id)
  assert.deepEqual(await l.next((e) => e.type === 'cancelled', 10_000, from), { type: 'cancelled', session: A, id: r.id })
  // one cancelled before anybody claimed it is simply never delivered
  const quiet = await b.rpc('requestCreate', A, { kind: 'question', text: 'Too quick' })
  await b.rpc('requestCancel', A, quiet.id)
  await sleep(800)
  assert.equal(l.lines.slice(from).some((e) => e.id === quiet.id), false)
})

test('a new listener is handed what the previous session claimed and never finished', async () => {
  await l.kill()
  await until(async () => (await presence(B)) !== 'listening')
  assert.deepEqual(l.bad, [], 'every line it printed was one JSON object')
  l = b.listener(fx.dir)
  const again = await l.next((e) => e.type === 'request')
  assert.equal(l.lines[0].type, 'ready')
  assert.deepEqual([again.session, again.kind, again.resumed, again.text], [B, 'walkthrough', true, 'short please'], 'the walkthrough request on review B was still running')
  await sleep(500)
  assert.equal(requests().length, 1, 'finished and cancelled requests are not replayed')
})

test('it survives the server stopping: it reconnects, and later requests still arrive, once', async () => {
  const pid = (await b.rpc('info')).pid
  const from = l.lines.length
  b.stop()
  const err = await l.next((e) => e.type === 'error', 10_000, from)
  assert.match(err.message, /reconnecting/)
  // any gr call (or the listener itself) brings the server back, on the same data
  assert.match(b.gr(fx.dir, 'comments', '--session', String(A)), /Changed from 1\./)
  await until(async () => (await b.rpc('info').catch(() => null))?.pid)
  assert.notEqual((await b.rpc('info')).pid, pid)
  await until(async () => (await presence(A)) === 'listening', 15_000)
  const r = await b.rpc('requestCreate', A, { kind: 'question', text: 'Still listening?' })
  const e = await l.next((x) => x.type === 'request' && x.id === r.id, 15_000, from)
  assert.deepEqual([e.session, e.resumed], [A, false])
  await sleep(500)
  assert.deepEqual(requests(from).map((x) => x.id), [r.id], 'the request it already held (review B) is not printed again after the reconnect')
  assert.equal(l.lines.slice(from).filter((x) => x.type === 'error').length, 1, 'one error line per outage')
  assert.match(l.stderr(), /reconnected/)
  assert.equal(l.child.exitCode, null, 'still running')
  b.gr(fx.dir, 'answer', r.id, '--session', String(A), '--text', 'Yes.')
})

test('--on-change adds a line when the code of a review changes, with no tab open', async () => {
  await l.kill()
  b.gr(fx.dir, 'annotate', '--session', String(A), '--file', (() => { const f = `${b.home}/w.json`; fs.writeFileSync(f, JSON.stringify({ title: 'T', summary: '', sections: [{ name: 'All', files: ['src/a.ts'] }] })); return f })())
  l = b.listener(fx.dir, '--on-change')
  await l.next((e) => e.type === 'ready')
  await sleep(2500) // the watcher takes its first fingerprint
  write(fx.dir, 'src/c.ts', 'export const c = 30\n'); commit(fx.dir, 'c is 30')
  const a = await l.next((e) => e.type === 'changed' && e.session === A)
  const v = await l.next((e) => e.type === 'changed' && e.session === B)
  assert.deepEqual([a.commits, a.files, a.dirty, a.since], [1, 1, false, 'reviewed'])
  assert.deepEqual([v.dirty, v.since], [false, 'start of the comparison'], 'a review with no walkthrough has no baseline to count from')
  assert.deepEqual(l.bad, [])
})
