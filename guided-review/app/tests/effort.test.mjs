// Effort levels: `gr review --effort read | check | bugs`. The level is stored with the
// review, raised or lowered later, and carried by a walkthrough request so the session
// knows who does the work. `check` leaves a fact check: rows checked against git like a
// walkthrough, each with a note beside the code when this change made the statement false.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commit, makeBridge, makeFixture, write } from './helpers.mjs'

let b; let fx; let sid; let l
const S = () => ['--session', String(sid)]
const loaded = () => b.rpc('loadSession', sid)
const state = async () => (await loaded()).state
const file = (name, v) => { const f = path.join(b.home, name); fs.writeFileSync(f, JSON.stringify(v)); return f }
const WALK = { title: 'Feature work', summary: 'a() returns 2 now.', sections: [{ id: 'core', name: 'Core', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/old.ts', 'src/moved.ts', 'img.bin', 'run.sh', 'noeol.txt'] }] }
const annotate = (extra, ...args) => b.try(fx.dir, 'annotate', '--file', file('walk.json', { ...WALK, ...extra }), ...args, ...S())
const factcheck = (fc, ...args) => b.try(fx.dir, 'factcheck', '--file', file('facts.json', fc), ...args, ...S())
const row = (st, statement) => st.factCheck.rows.find((r) => r.statement === statement)

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  // the session's listener runs under the session's own id; every other `gr` here runs as "tests"
  l = b.listenerWith({ GUIDED_REVIEW_OWNER: 'main-session' }, fx.dir)
  await l.next((e) => e.type === 'ready')
})
after(async () => { await l?.kill(); b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a review runs at check unless a level is named, and the level is said with what it covers', async () => {
  const bad = b.try(fx.dir, 'review', 'main..feature', '--effort', 'high')
  assert.equal(bad.code, 1)
  assert.match(bad.err, /--effort is one of read, check, bugs/)
  assert.deepEqual(await b.rpc('listSessions', fx.dir), [], 'a refused level creates nothing')

  const out = b.gr(fx.dir, 'review', 'main..feature')
  assert.match(out, /effort check: the walkthrough and a fact check, on Sonnet/)
  assert.match(out, /to do at this level: walkthrough, fact check/)
  assert.match(out, /a Sonnet subagent does that and posts it itself \(do not read the diff or the delta yourself\); its gr calls need: --session \d+ --owner tests --model/)
  const info = b.json(fx.dir, 'review', '--resume')
  sid = info.sessionId
  assert.equal(info.effort, 'check')
  assert.deepEqual(info.effortParts.map((p) => [p.level, p.included, p.mark]), [['read', true, null], ['check', true, null], ['bugs', false, null]])
  assert.equal((await loaded()).session.effort, 'check')
  assert.equal((await b.rpc('listSessions', fx.dir))[0].effort, 'check', 'the review list shows the level')

  // a review started from the page gets the default too
  const other = await b.rpc('startSession', fx.dir, 'v0', 'feature', {})
  assert.equal((await b.rpc('loadSession', other.sessionId)).session.effort, 'check')
  await b.rpc('archiveSession', other.sessionId, true)

  const named = b.json(fx.dir, 'review', 'main..feature', '--new', '--effort', 'read')
  assert.equal(named.effort, 'read')
  await b.rpc('archiveSession', named.sessionId, true)
  b.gr(fx.dir, 'review', '--resume', ...S())
})

test('a walkthrough request says who does the work at the review\'s level', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'walkthrough' })
  const ev = await l.next((e) => e.type === 'request' && e.id === r.id)
  assert.equal(ev.effort, 'check')
  assert.match(ev.do, /effort check: the walkthrough and a fact check, on Sonnet: hand this to a subagent started on Sonnet/)
  assert.match(ev.do, new RegExp(`gr annotate --file <json> --request ${r.id} --session ${sid} --owner main-session --model`), 'the subagent\'s call carries the id of the session that claimed the request')
  assert.match(ev.do, /"factCheck" in the same JSON/)
  assert.match(ev.do, /effort-levels\.md/)

  // posted the way the subagent posts it: its own process. Under its own id it is another
  // session and is turned away; with the claiming session's id it is that session's call
  const alone = annotate({}, '--request', r.id, '--model', 'Sonnet 5.5')
  assert.equal(alone.code, 130)
  assert.match(alone.err, /DISPLACED/)
  const res = annotate({}, '--request', r.id, '--owner', 'main-session', '--model', 'Sonnet 5.5')
  assert.equal(res.code, 0, res.err)
  const st = await state()
  assert.equal(st.requests.find((x) => x.id === r.id).status, 'done')
  assert.equal(st.iterations.at(-1).model, 'Sonnet 5.5')
  assert.deepEqual([st.effortDone.read.model, st.effortDone.read.sha], ['Sonnet 5.5', fx.head])
  assert.equal(st.effortDone.check, undefined, 'a walkthrough without a fact check does not record check')

  const r2 = await b.rpc('requestCreate', sid, { kind: 'walkthrough', update: true })
  const ev2 = await l.next((e) => e.type === 'request' && e.id === r2.id)
  assert.match(ev2.do, /update the walkthrough for what changed since it was written/)
  assert.match(ev2.do, /"update": true/)
  assert.equal(annotate({}, '--request', r2.id, '--owner', 'main-session', '--model', 'Sonnet 5.5').code, 0)
})

test('at read the request asks for the walkthrough only; at bugs the session does everything itself', async () => {
  const lower = b.gr(fx.dir, 'effort', 'read', ...S())
  assert.match(lower, /effort read: the walkthrough only, on Sonnet/)
  assert.match(lower, /note: effort lowered from check to read: later updates run at read; nothing already posted is removed/)
  const r = await b.rpc('requestCreate', sid, { kind: 'walkthrough' })
  const ev = await l.next((e) => e.type === 'request' && e.id === r.id)
  assert.equal(ev.effort, 'read')
  assert.doesNotMatch(ev.do, /factCheck/)
  await b.rpc('requestCancel', sid, r.id)

  const raise = b.gr(fx.dir, 'review', '--resume', ...S(), '--effort', 'bugs')
  assert.match(raise, /effort bugs: the walkthrough, a fact check and a bug hunt, on the session's model/)
  assert.match(raise, /note: effort raised from read to bugs: only what bugs adds is done now; nothing already posted is redone/)
  assert.match(raise, /walkthrough: done at [0-9a-f]{7} · Sonnet 5\.5/)
  assert.match(raise, /to do at this level: fact check, bug hunt/)
  assert.match(raise, /never runs code from the repository under review/)
  const r2 = await b.rpc('requestCreate', sid, { kind: 'walkthrough' })
  const ev2 = await l.next((e) => e.type === 'request' && e.id === r2.id)
  assert.equal(ev2.effort, 'bugs')
  assert.match(ev2.do, /do it yourself, reading only/)
  assert.match(ev2.do, /gr comment --finding bug/)
  assert.match(ev2.do, new RegExp(`gr effort --done bugs --session ${sid}`))
  assert.doesNotMatch(ev2.do, /subagent/)
  await b.rpc('requestCancel', sid, r2.id)

  const same = b.gr(fx.dir, 'review', '--resume', ...S(), '--effort', 'bugs')
  assert.doesNotMatch(same, /raised|lowered/, 'naming the level a review already has changes nothing')
  b.gr(fx.dir, 'effort', 'check', ...S())
})

test('a walkthrough that runs long is stored, and its writer is told which texts to shorten', async () => {
  const short = annotate({}, '--model', 'Sonnet 5.5')
  assert.doesNotMatch(short.out, /too long/)
  const res = annotate({ summary: 'S'.repeat(451), sections: [{ ...WALK.sections[0], what: 'w'.repeat(701), plainNotes: [{ file: 'src/a.ts', note: 'n'.repeat(301) }, { file: 'src/b.ts', note: 'fine' }] }] }, '--model', 'Sonnet 5.5')
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, /too long: the summary is 451 characters; keep it under 450: two or three plain sentences/)
  assert.match(res.out, /too long: the narration of section "Core" is 701 characters; keep it under 700: three to six short bullets in plain words/)
  assert.match(res.out, /too long: the note on src\/a\.ts is 301 characters; keep it under 300/)
  assert.doesNotMatch(res.out, /src\/b\.ts is/)
  assert.match(res.out, /shorten those texts and store the walkthrough again/)
  assert.equal((await state()).walkthrough.summary.length, 451, 'nothing is cut')
  assert.equal(annotate({}, '--model', 'Sonnet 5.5').code, 0)
})

test('a fact check is checked against git, and a statement this change made false gets a note beside the code', async () => {
  // plan.md is a file git has that this change does not touch and that is not attached
  b.gr(fx.dir, 'artifact', 'remove', 'specs/rate-limit/plan.md', ...S())
  const res = annotate({
    factCheck: {
      checked: 12,
      rows: [
        { statement: 'a() returns 1', where: 'specs/rate-limit/spec.md:5', contradicts: 'src/a.ts:2', why: 'It returns 2 now.', group: 'changed' },
        { statement: 'b() returns 7', where: 'specs/rate-limit/plan.md:4', contradicts: { file: 'src/b.ts', line: 2 }, why: 'It returned 42 before this change and returns 43 now.', group: 'already' },
        { statement: 'old.ts exports gone', where: `commit ${fx.firstFeature.slice(0, 8)}`, contradicts: 'src/old.ts:1:old', why: 'The file is removed.', group: 'changed' },
        { statement: 'the plan has two steps', where: 'the pull request description', contradicts: 'specs/rate-limit/plan.md:3', why: 'It lists two; the text says three.', group: 'changed' },
        { statement: 'documented elsewhere', where: 'docs/nope.md:3', contradicts: 'src/a.ts:99', group: 'whenever' },
        { statement: 'a() returns 1', where: 'specs/rate-limit/spec.md:6', contradicts: 'src/a.ts:2', group: 'changed' }
      ]
    }
  }, '--model', 'Sonnet 5.5')
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, /fact check stored: 5 statement\(s\) that do not hold, 2 with a note beside the code/)
  assert.match(res.out, /fact check: row 4 .* is listed as made false by this change, but the line that contradicts it \(specs\/rate-limit\/plan\.md:3\) is not part of the diff: it gets no note beside the code/)
  assert.match(res.out, /fact check: row 5 .* docs\/nope\.md, which git does not have on the compare side — kept as a label only/)
  assert.match(res.out, /fact check: row 5 .* the contradicting line was removed — src\/a\.ts has 7 lines/)
  assert.match(res.out, /fact check: row 5 .* has group "whenever"; it is listed under "was already false"/)
  assert.match(res.out, /fact check: row 6 .* is given twice for the same place — the second was dropped/)

  const st = await state()
  const fc = st.factCheck
  assert.deepEqual([fc.rows.length, fc.checked, fc.model, fc.endSha], [5, 12, 'Sonnet 5.5', fx.head])
  assert.deepEqual([st.effortDone.check.model, st.effortDone.check.sha], ['Sonnet 5.5', fx.head])
  // the places are git's, not the session's
  const a = row(st, 'a() returns 1')
  assert.deepEqual(a.where, { label: 'specs/rate-limit/spec.md:5', file: 'specs/rate-limit/spec.md', line: 5, lineContent: '- criterion one', artifact: true })
  assert.deepEqual(a.contradicts, { file: 'src/a.ts', line: 2, side: 'new', lineContent: '  return 2', inDiff: true })
  assert.deepEqual([a.group, a.foundAt.sha], ['changed', fx.head])
  const plan = row(st, 'b() returns 7')
  assert.deepEqual(plan.where, { label: 'specs/rate-limit/plan.md:4', file: 'specs/rate-limit/plan.md', line: 4, lineContent: '2. add b()' })
  assert.equal(plan.commentId, undefined, 'a statement that was already false gets no note beside the code')
  const gone = row(st, 'old.ts exports gone')
  assert.deepEqual(gone.where, { label: `the message of commit ${fx.firstFeature.slice(0, 7)}`, commit: fx.firstFeature })
  assert.deepEqual([gone.contradicts.side, gone.contradicts.lineContent], ['old', 'export const gone = true'])
  const pr = row(st, 'the plan has two steps')
  assert.deepEqual(pr.where, { label: 'the pull request description' })
  assert.deepEqual([pr.contradicts.inDiff, pr.contradicts.lineContent, pr.commentId], [false, '1. change a()', undefined])
  const nope = row(st, 'documented elsewhere')
  assert.deepEqual([nope.group, nope.where, nope.contradicts], ['already', { label: 'docs/nope.md:3' }, undefined])

  // the notes are comments like any other, written from the rows
  const note = st.comments.find((c) => c.id === a.commentId)
  assert.deepEqual([note.finding, note.author, note.status, note.anchor.file, note.anchor.line, note.anchor.lineContent, note.foundAt.sha], ['fact', 'agent', 'note', 'src/a.ts', 2, '  return 2', fx.head])
  assert.match(note.text, /this change makes a statement false\.\n\n> a\(\) returns 1\n\nIt stands in specs\/rate-limit\/spec\.md:5\. It returns 2 now\./)
  assert.equal(st.comments.filter((c) => c.finding === 'fact').length, 2)

  const shown = b.gr(fx.dir, 'state', ...S())
  assert.match(shown, /fact check: 5 statement\(s\) do not hold \(12 checked\) · at [0-9a-f]{7} · Sonnet 5\.5/)
  assert.match(shown, /made false by this change:\n  \[f\d+\] a\(\) returns 1\n      stands in: specs\/rate-limit\/spec\.md:5\n      contradicted by: src\/a\.ts:2 — " {2}return 2"/)
  assert.match(shown, /was already false:/)
})

test('a fact check that is not one refuses the whole walkthrough, and one with a row that says nothing is not stored as "nothing found"', async () => {
  const before = await state()
  const res = annotate({ title: 'Never stored', factCheck: { rows: 'none' } })
  assert.equal(res.code, 1)
  assert.match(res.err, /a fact check is \{ "rows"/)
  // rows written with the wrong key: stored as they are, this would read "every statement holds"
  const wrong = factcheck({ rows: [{ claim: 'a() returns 1', where: 'src/a.ts:1' }, { statement: 'fine', where: 'src/a.ts:1' }, { text: 'K is 11' }] })
  assert.equal(wrong.code, 1)
  assert.match(wrong.err, /rows 1, 3 have no "statement" .* nothing was stored/)
  const st = await state()
  assert.deepEqual([st.walkthrough.title, st.iterations.length, st.factCheck.rows.length], [before.walkthrough.title, before.iterations.length, 5])
  assert.equal(st.comments.filter((c) => c.finding === 'fact').length, 2, 'and the notes are where they were')
})

test('storing the fact check again keeps the list and the notes in step', async () => {
  const st0 = await state()
  const a0 = row(st0, 'a() returns 1'); const gone0 = row(st0, 'old.ts exports gone')
  // the reviewer replies under one note: that thread is theirs now
  await b.rpc('commentUpdate', sid, gone0.commentId, { reply: { author: 'user', text: 'Is that on purpose?' } })

  const res = factcheck({ rows: [
    { statement: 'a() returns 1', where: 'specs/rate-limit/spec.md:5', contradicts: 'src/a.ts:2', why: 'It returns 2.', group: 'changed' },
    { statement: 'K is 11', where: 'specs/rate-limit/spec.md:6', contradicts: 'src/a.ts:4', why: 'K is 10.', group: 'changed' }
  ] }, '--model', 'Sonnet 5.5')
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, /fact check stored: 2 statement\(s\) that do not hold, 2 with a note beside the code/)
  assert.match(res.out, /this fact check replaced the stored list: 4 earlier row\(s\) are gone .* To add to the list instead, give "update": true/)
  const st = await state()
  const a = row(st, 'a() returns 1')
  assert.deepEqual([a.id, a.commentId], [a0.id, a0.commentId], 'a row given again is the same row with the same note')
  assert.match(st.comments.find((c) => c.id === a.commentId).text, /It returns 2\.$/, 'and its note says what the row says now')
  assert.ok(st.comments.some((c) => c.id === gone0.commentId), 'a note somebody replied to is never deleted')
  assert.equal(st.comments.filter((c) => c.finding === 'fact').length, 3)

  // given again by its id, reworded and on another line: the same row, and its note moves with it
  const moved = factcheck({ update: true, rows: [{ id: a.id, statement: 'a() returns one', where: 'specs/rate-limit/spec.md:5', contradicts: 'src/a.ts:1', why: 'It returns 2.', group: 'changed' }] })
  assert.equal(moved.code, 0, moved.err)
  const stM = await state()
  const aM = row(stM, 'a() returns one')
  assert.deepEqual([aM.id, aM.commentId, aM.contradicts.line], [a.id, a.commentId, 1])
  const noteM = stM.comments.find((c) => c.id === a.commentId)
  assert.deepEqual([noteM.anchor.line, noteM.anchor.lineContent], [1, 'export function a() {'], 'the note sits on the line the row names')
  assert.match(noteM.text, /> a\(\) returns one\n/)
  assert.equal(stM.factCheck.rows.length, 2)

  // the statement whose note the reviewer replied to is found again: that thread is its note, not a second one beside it
  const back = factcheck({ update: true, rows: [{ statement: 'old.ts exports gone', where: `commit ${fx.firstFeature.slice(0, 8)}`, contradicts: 'src/old.ts:1:old', why: 'The file is removed.', group: 'changed' }] })
  assert.equal(back.code, 0, back.err)
  const stB = await state()
  assert.equal(row(stB, 'old.ts exports gone').commentId, gone0.commentId)
  assert.equal(stB.comments.filter((c) => c.finding === 'fact').length, 3)
  // a note that is deleted takes its link with it; the row stays in the list
  b.gr(fx.dir, 'delete-comment', gone0.commentId, ...S())
  assert.equal(row(await state(), 'old.ts exports gone').commentId, undefined)
  assert.equal(factcheck({ rows: [
    { statement: 'a() returns 1', where: 'specs/rate-limit/spec.md:5', contradicts: 'src/a.ts:2', why: 'It returns 2.', group: 'changed' },
    { statement: 'K is 11', where: 'specs/rate-limit/spec.md:6', contradicts: 'src/a.ts:4', why: 'K is 10.', group: 'changed' }
  ] }).code, 0)

  // update: the stored rows stay unless one is given again or retired
  const k = row(await state(), 'K is 11')
  const up = factcheck({ update: true, retire: [k.id, 'f999'], checked: 4, rows: [{ statement: 'L is 12', where: 'specs/rate-limit/spec.md', contradicts: 'src/a.ts:5', why: 'L is 11.', group: 'changed' }] })
  assert.equal(up.code, 0, up.err)
  assert.match(up.out, /"retire" names "f999", which is not a stored row/)
  const st2 = await state()
  assert.deepEqual(st2.factCheck.rows.map((r) => r.statement), ['a() returns 1', 'L is 12'])
  assert.ok(!st2.comments.some((c) => c.id === k.commentId), 'the note of a retired row goes with it')
  assert.equal(st2.factCheck.model, '', 'a model that was not named is not made up')
  assert.match(up.out, /no --model given: the page shows "model not recorded"/, 'and gr says that it is missing')

  // answering a request to UPDATE the walkthrough adds to the list, also when the fact check does not say so
  const r = await b.rpc('requestCreate', sid, { kind: 'walkthrough', update: true })
  await l.next((e) => e.type === 'request' && e.id === r.id)
  const upd = annotate({ factCheck: { rows: [{ statement: 'M is 13', where: 'specs/rate-limit/spec.md', contradicts: 'src/a.ts:6', why: 'M is 12.', group: 'changed' }] } }, '--request', r.id, '--owner', 'main-session', '--model', 'Sonnet 5.5')
  assert.equal(upd.code, 0, upd.err)
  assert.deepEqual((await state()).factCheck.rows.map((x) => x.statement), ['a() returns 1', 'L is 12', 'M is 13'])

  // an empty list is a result: everything checked holds
  const none = factcheck({ rows: [], checked: 30 }, '--model', 'Sonnet 5.5')
  assert.match(none.out, /fact check stored: 0 statement/)
  const st3 = await state()
  assert.deepEqual([st3.factCheck.rows.length, st3.factCheck.checked], [0, 30])
  assert.deepEqual(st3.comments.filter((c) => c.finding === 'fact'), [])
  assert.match(b.gr(fx.dir, 'state', ...S()), /fact check: no statement was found that does not hold \(30 checked\)/)
})

test('a bug finding carries the state it was found at, and the hunt is recorded on its own', async () => {
  b.gr(fx.dir, 'effort', 'bugs', ...S())
  assert.match(b.try(fx.dir, 'comment', '--file', 'src/b.ts', '--line', '2', '--text', 'x', '--finding', 'fact', ...S()).err, /--finding is "bug"/)
  b.gr(fx.dir, 'comment', '--file', 'src/b.ts', '--line', '2', '--expect', 'return 43', '--finding', 'bug', '--text', 'b() overflows for n > 2^31: callers pass a count.', ...S())
  const batch = b.batch(fx.dir, [
    { op: 'comment', file: 'src/c.ts', line: 1, finding: 'bug', text: 'c is never exported from the index.' },
    { op: 'effort-done', level: 'bugs', model: 'Opus 5.5' }
  ], ...S())
  assert.equal(batch.code, 0, batch.err)
  assert.match(batch.out, /bug hunt recorded as done at [0-9a-f]{7} · Opus 5\.5/)
  const st = await state()
  const bugs = st.comments.filter((c) => c.finding === 'bug')
  assert.deepEqual(bugs.map((c) => [c.anchor.file, c.foundAt.sha, c.status]), [['src/b.ts', fx.head, 'note'], ['src/c.ts', fx.head, 'note']])
  assert.deepEqual([st.effortDone.bugs.model, st.effortDone.bugs.sha], ['Opus 5.5', fx.head])
  assert.match(b.gr(fx.dir, 'comments', ...S()), /\] note · bug · agent · src\/b\.ts:2 · at [0-9a-f]{7}/)
  assert.match(b.try(fx.dir, 'effort', '--done', 'check', ...S()).err, /only the bug hunt is recorded on its own/)
  await assert.rejects(b.rpc('effortDone', sid, 'check', {}), /check by a fact check/)

  const parts = b.json(fx.dir, 'effort', ...S()).parts
  assert.deepEqual(parts.map((p) => [p.level, p.included, p.current, p.mark?.model]), [['read', true, true, 'Sonnet 5.5'], ['check', true, true, 'Sonnet 5.5'], ['bugs', true, true, 'Opus 5.5']])
})

test('after the code moves on, what was found earlier stays and says which state it is from', async () => {
  assert.equal(factcheck({ rows: [{ statement: 'J is 21', where: 'specs/rate-limit/spec.md', contradicts: 'src/a.ts:7', why: 'J is 20.', group: 'changed' }] }, '--model', 'Sonnet 5.5').code, 0)
  write(fx.dir, 'src/c.ts', 'export const c = 4\n')
  write(fx.dir, 'src/a.ts', ['// a', '// b', 'export function a() {', '  return 2', '}', 'export const K = 10', 'export const L = 11', 'export const M = 12', 'export const J = 20', ''].join('\n'))
  const next = commit(fx.dir, 'c is 4')
  // the note followed its line, and the row names the same line as its note
  const moved = await state()
  const j = row(moved, 'J is 21')
  assert.deepEqual([moved.comments.find((c) => c.id === j.commentId).anchor.line, j.contradicts.line, j.contradicts.lineContent, j.foundAt.sha], [9, 9, 'export const J = 20', fx.head])
  assert.match(b.gr(fx.dir, 'state', ...S()), /contradicted by: src\/a\.ts:9 — "export const J = 20"[^]*found at [0-9a-f]{7}, an earlier state of the code/)
  const st = await state()
  assert.equal(st.comments.filter((c) => c.finding === 'bug').length, 2, 'nothing posted is removed')
  const ld = await loaded()
  assert.notEqual(st.effortDone.bugs.signature, ld.signature)
  const out = b.gr(fx.dir, 'effort', 'read', ...S())
  assert.match(out, /walkthrough: done at [0-9a-f]{7}, an earlier state of the code · Sonnet 5\.5/)
  assert.match(out, /bug hunt: done at [0-9a-f]{7}, an earlier state of the code · Opus 5\.5 \(not part of read: it stays as it is, and later updates at read leave it alone\)/)
  assert.doesNotMatch(out, /to do at this level/)
  assert.match(out, /to update for what changed since \(gr drift has the delta\): walkthrough\n {2}a Sonnet subagent does that/, 'an update is the subagent\'s too: the session is told so, with the flags')

  // an update at the lower level: a new walkthrough, and the fact check and the findings are left alone
  assert.equal(annotate({ summary: 'c is 4 now.' }, '--model', 'Sonnet 5.5').code, 0)
  const st2 = await state()
  assert.equal(st2.effortDone.read.sha, next)
  assert.equal(st2.effortDone.check.sha, fx.head)
  assert.equal(st2.factCheck.endSha, fx.head)
  assert.equal(st2.comments.filter((c) => c.finding === 'bug').length, 2)
})

test('a review from before effort levels has no level recorded until it is resumed, and its walkthrough is not owed again', async () => {
  await l.kill(); l = null
  b.stop()
  const f = path.join(b.home, 'sessions', `${sid}.json`)
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'))
  delete saved.effort; delete saved.state.effortDone
  fs.writeFileSync(f, JSON.stringify(saved))
  const ld = await b.json(fx.dir, 'state', ...S())
  assert.equal((await loaded()).session.effort, undefined)
  assert.equal((await b.rpc('listSessions', fx.dir)).find((x) => x.id === sid).effort, undefined, 'no level is shown for it')
  assert.deepEqual(ld.effortParts.map((p) => p.mark?.model), ['', undefined, undefined], 'its walkthrough is there, and no model is claimed for it')
  const out = b.gr(fx.dir, 'review', '--resume', ...S())
  assert.match(out, /note: this review had no effort level recorded: it runs at check, the default, from now on/)
  assert.match(out, /walkthrough: done at [0-9a-f]{7} · model not recorded/)
  assert.match(out, /to do at this level: fact check\n/, 'only what the level adds is owed, never the walkthrough again')
  assert.ok(b.json(fx.dir, 'review', '--resume', ...S()).notes.every((n) => typeof n === 'string'))
  assert.equal((await loaded()).session.effort, 'check')
})
