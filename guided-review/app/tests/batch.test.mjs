// `gr batch` applies many writes as one atomic update: the page refreshes once, and
// if any operation is refused nothing at all is applied.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeBridge, makeFixture, sleep, until } from './helpers.mjs'

let b; let fx; let sid; let note; let queued
const S = () => ['--session', String(sid)]
const g = (...args) => b.gr(fx.dir, ...args, ...S())
const state = () => b.json(fx.dir, 'state', ...S()).state
const comment = (id) => state().comments.find((c) => c.id === id)
const changes = (tab) => tab.events.filter((e) => e.channel === 'session:changed').length
async function claimedQuestion(text) {
  const r = await b.rpc('requestCreate', sid, { kind: 'question', text })
  await b.rpc('requestTake', sid)
  return r.id
}

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
  note = b.json(fx.dir, 'comment', '--file', 'src/a.ts', '--line', '2', '--text', 'Changed from 1.', ...S()).id
  queued = (await b.rpc('commentAdd', sid, { anchor: { kind: 'diff', file: 'src/b.ts', line: 2 }, text: 'Why 43?', author: 'user' })).id
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a comment, a reply, a resolution and an answer in one call: all applied, one refresh', async () => {
  const q = await claimedQuestion('What changed in a.ts?')
  const tab = await b.listen(sid)
  await sleep(500)
  const before = changes(tab)
  const res = b.batch(fx.dir, [
    { op: 'comment', file: 'src/c.ts', line: 1, side: 'new', expect: 'const c', text: 'New constant, unused so far.' },
    { op: 'reply', id: note, text: 'Callers comparing against 1 will break.' },
    { op: 'resolve', id: queued, verdict: 'skipped', note: '43 is what the plan names.' },
    { op: 'answer', request: q, text: 'a() returns 2 now.', file: 'src/a.ts', line: 2 }
  ], ...S())
  assert.equal(res.code, 0, res.err)
  const lines = res.out.trim().split('\n')
  assert.match(lines[0], /^comment \S+ on src\/c\.ts:1 — anchored to: "export const c = 3"$/)
  assert.equal(lines[1], `replied to ${note} (src/a.ts:2)`)
  assert.equal(lines[2], `resolved ${queued} (src/b.ts:2) as skipped: 43 is what the plan names.`)
  assert.equal(lines[3], `answered request ${q} (with focus)`)
  assert.equal(lines[4], 'batch: 4 operation(s) applied')

  await until(() => changes(tab) > before)
  await sleep(700)
  assert.equal(changes(tab) - before, 1, 'the page was told to refresh exactly once')
  assert.equal(tab.events.filter((e) => e.channel === 'ui:action').length, 1, 'the answer\'s focus still plays')
  tab.close()

  const st = state()
  assert.deepEqual(st.comments.map((c) => [c.author, c.status]), [['agent', 'note'], ['user', 'resolved'], ['agent', 'note']])
  assert.deepEqual(comment(note).replies.map((r) => [r.author, r.text]), [['agent', 'Callers comparing against 1 will break.']])
  assert.equal(comment(queued).resolution.verdict, 'skipped')
  assert.deepEqual([st.requests[0].status, st.messages.at(-1).text, st.messages.at(-1).requestId], ['done', 'a() returns 2 now.', q])
})

test('if one operation is refused, nothing is applied and the message names it', async () => {
  const before = state()
  const tab = await b.listen(sid)
  await sleep(300)
  const seen = changes(tab)
  const res = b.batch(fx.dir, [
    { op: 'comment', file: 'src/a.ts', line: 7, text: 'Would be stored first.' },
    { op: 'reply', id: note, text: 'Would be stored second.' },
    { op: 'resolve', id: 'c999', verdict: 'addressed', note: 'no such comment' },
    { op: 'comment', summary: true, text: 'Never reached.' }
  ], ...S())
  assert.equal(res.code, 1)
  assert.equal(res.out, '')
  assert.match(res.err, /^gr: operation 3 \(commentUpdate\) failed: no comment c999 — nothing was applied\n$/)
  await sleep(700)
  assert.equal(changes(tab), seen, 'the page was not told to refresh')
  tab.close()
  assert.deepEqual(state(), before, 'the review is exactly as it was')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', `${sid}.json`), 'utf8')).state, before, 'on disk too')

  // an anchor outside the files of the diff is refused by the server the same way
  const anchor = b.batch(fx.dir, [{ op: 'reply', id: note, text: 'x' }, { op: 'comment', file: 'src/nope.ts', line: 1, text: 'y' }], ...S())
  assert.equal(anchor.code, 1); assert.match(anchor.err, /operation 2 \(commentAdd\) failed: src\/nope\.ts is not part of this diff.* — nothing was applied/)
  // a malformed operation is caught before anything is sent
  const shape = b.batch(fx.dir, [{ op: 'reply', id: note, text: 'x' }, { op: 'resolve', id: queued, verdict: 'maybe', note: 'n' }], ...S())
  assert.equal(shape.code, 1); assert.match(shape.err, /operation 2 \(resolve\): needs <commentId> --verdict addressed\|reworked\|skipped .* — nothing was applied/)
  const unknown = b.batch(fx.dir, [{ op: 'approve' }], ...S())
  assert.equal(unknown.code, 1); assert.match(unknown.err, /operation 1: unknown op "approve" — nothing was applied/)
  for (const bad of ['[]', '{"op":"reply"}', 'not json']) {
    const r = b.try(fx.dir, 'batch', '--file', (() => { const f = path.join(b.home, 'bad.json'); fs.writeFileSync(f, bad); return f })(), ...S())
    assert.equal(r.code, 1, bad)
  }
  assert.deepEqual(state(), before)
})

test('a batch that touches a cancelled request stops the session (exit 130) and applies nothing', async () => {
  const q = await claimedQuestion('Cancel me')
  await b.rpc('requestCancel', sid, q)
  const before = state()
  const res = b.batch(fx.dir, [
    { op: 'comment', file: 'src/a.ts', line: 7, text: 'Found while answering.' },
    { op: 'progress', request: q, text: 'half way' },
    { op: 'answer', request: q, text: 'late' }
  ], ...S())
  assert.equal(res.code, 130)
  assert.match(res.err, new RegExp(`^CANCELLED: the reviewer cancelled request ${q} — stop working on it\\n\\(operation 2 of the batch; nothing in the batch was applied\\)`))
  assert.deepEqual(state(), before)
})

test('a whole apply round in one call: walkthrough update, resolutions, viewed mark, focus, done', async () => {
  const c = (await b.rpc('commentAdd', sid, { anchor: { kind: 'file', file: 'src/c.ts' }, text: 'Document c.', author: 'user' })).id
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [c] })
  await b.rpc('requestTake', sid)
  const file = path.join(b.home, 'ops.json')
  fs.writeFileSync(file, JSON.stringify([
    { op: 'annotate', walkthrough: { title: 'Batch walkthrough', summary: 's', sections: [{ id: 'core', name: 'Core', files: ['src/a.ts', 'src/ghost.ts'] }] } },
    { op: 'comment', section: 'core', text: 'Read this section first.' },
    { op: 'progress', request: r.id, text: 'documenting c' },
    { op: 'resolve', id: c, verdict: 'addressed', note: 'Added a doc comment.' },
    { op: 'viewed', file: 'src/c.ts' },
    { op: 'note', text: 'Done with c.', file: 'src/c.ts' },
    { op: 'focus', section: 'core' },
    { op: 'done', request: r.id, text: 'all handled' }
  ]))
  const out = g('batch', '--file', file)
  assert.match(out, /walkthrough stored: 2 section\(s\)\ncorrected against git: section "Core" lists src\/ghost\.ts, which is not in the diff — dropped\n/)
  assert.match(out, /comment \S+ on section core\n/, 'a later operation can use what an earlier one created')
  assert.match(out, /src\/c\.ts: viewed at \w{7}\n/)
  assert.match(out, /no review tab is open, so nobody saw the focus on section core\n/)
  assert.match(out, new RegExp(`request ${r.id} done\\nresolutions:\\n  \\[${c}\\] addressed — Added a doc comment\\.\\nbatch: 8 operation\\(s\\) applied\\n$`))
  const st = state()
  assert.deepEqual([st.walkthrough.title, Object.keys(st.viewedAt), st.requests.at(-1).status], ['Batch walkthrough', ['src/c.ts'], 'done'])
  assert.deepEqual(st.requests.at(-1).progress.map((p) => p.text), ['documenting c', 'all handled'])
  const json = JSON.parse(b.batch(fx.dir, [{ op: 'reopen', id: c }, { op: 'delete-comment', id: c }], '--json', ...S()).out)
  assert.equal(json.applied, 2)
  assert.equal(comment(c), undefined)
})
