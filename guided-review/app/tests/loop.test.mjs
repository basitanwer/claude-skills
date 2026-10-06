// The complete review loop, end to end: the real server, driven through the gr
// bridge the way a Claude Code session drives it, against a real git repository.
// The browser is simulated with direct RPC calls (`b.rpc`). No model is involved
// anywhere: the test itself plays the session.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commit, git, makeBridge, makeFixture, until, write } from './helpers.mjs'

let b; let fx; let sid
const ids = {}
const commentId = (out) => out.match(/comment (\S+) on/)[1]
const S = () => ['--session', String(sid)]
const g = (...args) => b.gr(fx.dir, ...args, ...S())
const gj = (...args) => b.json(fx.dir, ...args, ...S())
const gt = (...args) => b.try(fx.dir, ...args, ...S())
const state = () => gj('state').state
const comment = (id) => gj('comments').find((c) => c.id === id)
const request = (id) => state().requests.find((r) => r.id === id)
function walkthroughFile(name, body) {
  const file = path.join(b.home, name)
  fs.writeFileSync(file, JSON.stringify(body))
  return file
}

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  write(fx.dir, 'src/dup.ts', ['function first() {', '  return null', '}', 'function second() {', '  return null', '}', ''].join('\n'))
  fx.head = commit(fx.dir, 'add dup')
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('1. open a comparison (the repository path contains spaces)', () => {
  assert.match(fx.dir, / /)
  const info = b.json(fx.dir, 'review', 'main..feature')
  sid = info.sessionId
  assert.equal(info.resumed, false)
  assert.equal(info.repo, fx.dir)
  assert.deepEqual([info.base.kind, info.compare.kind, info.direct], ['branch', 'branch', false])
  assert.equal(info.compare.sha, fx.head)
  assert.deepEqual([info.files, info.commits], [9, 4])
  assert.deepEqual(info.flags.sort(), ['1 binary', '1 deleted', '1 mode-only', '1 renamed', '3 added'])
  assert.match(info.url, /#\/review\?session=\d+$/)
  assert.deepEqual(info.artifacts, [{ role: 'spec', path: 'specs/rate-limit/spec.md' }, { role: 'plan', path: 'specs/rate-limit/plan.md' }], 'spec and plan are discovered by convention')
  const text = b.gr(fx.dir, 'review', 'main..feature')
  assert.match(text, /^Resumed review #\d+: main \(moving branch\) → feature \(moving branch\)/, 'the same comparison is resumed, not duplicated')
  assert.match(text, /next: start "gr listen" as a background Monitor .*fallback.*"gr wait"/)
})

test('2. a walkthrough is reconciled against git, not trusted', () => {
  const out = g('annotate', '--file', walkthroughFile('w1.json', {
    title: 'Return value bump', summary: 'a() now returns 2.',
    sections: [{ id: 'core', name: 'Core change', desc: 'The behaviour change.', what: 'a() returns 2.', files: ['src/a.ts', 'src/invented.ts'] }],
    questions: [{ id: 'q1', text: 'Is 2 the intended value?', options: ['yes', 'no'] }],
    planMap: { acceptance: [{ text: 'criterion one', met: 'partial' }], steps: [{ n: 1, text: 'change a()', sectionId: 'core', status: 'done' }, { n: 2, text: 'add b()', sectionId: 'nowhere', status: 'done' }], deviations: [] }
  }))
  assert.match(out, /walkthrough stored: 2 section\(s\)/)
  assert.match(out, /corrected against git: section "Core change" lists src\/invented\.ts, which is not in the diff — dropped/)
  assert.match(out, /corrected against git: 8 changed file\(s\) were not placed in a section/)
  const st = state()
  assert.equal(st.walkthrough.title, 'Return value bump')
  assert.deepEqual(st.walkthrough.sections.map((s) => s.id), ['core', 'other-changes'])
  assert.deepEqual(st.walkthrough.sections[0].files, ['src/a.ts'], 'the invented file is gone')
  assert.deepEqual(st.walkthrough.sections.flatMap((s) => s.files).sort(),
    ['img.bin', 'noeol.txt', 'run.sh', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/dup.ts', 'src/moved.ts', 'src/old.ts'], 'every changed file is covered')
  assert.equal(st.walkthrough.planMap.steps[1].sectionId, '', 'a plan step pointing at an unknown section is detached')
  assert.equal(st.reviewedAtSha, fx.head)
  assert.equal(st.iterations.length, 1)
  const bad = gt('annotate', '--file', walkthroughFile('bad.json', { summary: 'no title', sections: [] }))
  assert.equal(bad.code, 1); assert.match(bad.err, /needs a "title"/)
  // tracking marks and spec/plan attachments
  assert.match(g('section-reviewed', 'core'), /section core: reviewed/)
  assert.deepEqual(state().reviewedSections, ['core'])
  assert.match(g('artifact', 'remove', 'specs/rate-limit/plan.md'), /detached/)
  assert.match(g('artifact', 'add', 'specs/rate-limit/plan.md', '--role', 'plan'), /attached .* as the plan/)
  const missing = gt('artifact', 'add', 'docs/nope.md', '--role', 'spec')
  assert.equal(missing.code, 1); assert.match(missing.err, /cannot read docs\/nope\.md/)
  assert.deepEqual(gj('artifact', 'list').map((a) => a.path).sort(), ['specs/rate-limit/plan.md', 'specs/rate-limit/spec.md'])
})

test('3. comments are anchored by the server from the real diff; anything else is refused', () => {
  const note = g('comment', '--file', 'src/a.ts', '--line', '2', '--expect', 'return 2', '--text', 'Return value changed from 1 to 2.')
  assert.match(note, /comment \S+ on src\/a\.ts:2 — anchored to: "  return 2"/)
  ids.note = commentId(note)
  ids.noteMoves = commentId(g('comment', '--file', 'src/a.ts', '--line', '4', '--text', 'K is unchanged context.'))
  ids.moves = commentId(g('comment', '--as', 'user', '--file', 'src/a.ts', '--line', '7', '--text', 'Why 20?'))
  ids.stale = commentId(g('comment', '--as', 'user', '--file', 'src/a.ts', '--line', '2', '--text', 'Should this be 3?'))
  ids.removed = commentId(g('comment', '--file', 'src/a.ts', '--side', 'old', '--line', '2', '--text', 'Old behaviour.'))
  ids.section = commentId(g('comment', '--section', 'core', '--text', 'Section note.'))
  ids.spec = commentId(g('comment', '--artifact', 'specs/rate-limit/spec.md', '--line', '5', '--text', 'Not covered by a test.'))
  ids.dup = commentId(g('comment', '--as', 'user', '--file', 'src/dup.ts', '--line', '5', '--text', 'This is the one in second().'))
  ids.ws = commentId(g('comment', '--as', 'user', '--file', 'src/b.ts', '--line', '2', '--text', 'Why 43?'))

  assert.deepEqual(comment(ids.note).anchor, {
    kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@ -1,6 +1,7 @@', lineContent: '  return 2',
    before: ['export function a() {'], after: ['}', 'export const K = 10']
  })
  assert.equal(comment(ids.note).status, 'note', 'an agent remark is a note, never queued')
  assert.equal(comment(ids.moves).status, 'queued')
  assert.equal(comment(ids.removed).anchor.lineContent, '  return 1')
  assert.equal(comment(ids.spec).anchor.lineContent, '- criterion one')

  for (const [args, re] of [
    [['--file', 'src/a.ts', '--line', '400'], /has 7 lines on the new side; line 400 does not exist/],
    [['--file', 'src/a.ts', '--line', '2', '--expect', 'return 99'], /does not contain the expected text/],
    [['--file', 'img.bin', '--line', '1'], /is binary/],
    [['--file', 'specs/rate-limit/spec.md', '--line', '1'], /is not part of this diff/],
    [['--section', 'nope'], /no section nope/],
    [['--artifact', 'specs/rate-limit/spec.md', '--line', '99'], /out of range/]
  ]) {
    const r = gt('comment', ...args, '--text', 'x')
    assert.equal(r.code, 1, args.join(' ')); assert.match(r.err, re)
  }
  assert.equal(gj('comments').length, 9, 'refused comments were not stored')
  assert.match(g('comment', '--file', 'img.bin', '--text', 'Binary changed.'), /on img\.bin/, 'a binary file still takes a file-level comment')

  g('reply', ids.section, '--text', 'More detail.')
  assert.deepEqual(comment(ids.section).replies.map((r) => [r.author, r.text]), [['agent', 'More detail.']])
  g('delete-comment', ids.section)
  assert.equal(gj('comments').length, 9)
})

test('4. a question asked in the UI reaches the session through gr wait and is answered in place', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'question', text: 'What does this line do?', anchor: { kind: 'diff', file: 'src/a.ts', line: 2 } })
  assert.equal(r.status, 'pending')
  const asked = state().messages.at(-1)
  assert.deepEqual([asked.role, asked.requestId, asked.anchor.lineContent], ['user', r.id, '  return 2'])

  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} question`))
  assert.match(out, /What does this line do\?/)
  assert.match(out, /about: src\/a\.ts:2 — "  return 2"/)
  assert.match(out, new RegExp(`review #${sid}: main \\(moving branch\\) → feature \\(moving branch\\)`))
  assert.match(out, new RegExp(`answer with: gr answer ${r.id} --session ${sid} --text`), 'follow-up commands name the review')
  assert.doesNotMatch(out, /resumed/)
  assert.equal(request(r.id).status, 'running', 'a returned request is claimed')
  assert.ok(request(r.id).startedAt)
  // a session that asks again before finishing gets the claimed request back, marked
  assert.match(g('wait', '--timeout', '1'), new RegExp(`REQUEST ${r.id} question\\n  review #${sid}[^\\n]*\\n  \\(resumed: claimed earlier and never finished\\)`))

  g('progress', r.id, 'reading src/a.ts')
  assert.deepEqual(request(r.id).progress.map((p) => p.text), ['reading src/a.ts'])
  assert.match(g('answer', r.id, '--text', 'It is the new return value.', '--file', 'src/a.ts', '--line', '2'), /answered request \S+ \(with focus\)/)
  const st = state()
  const answer = st.messages.at(-1)
  assert.deepEqual([answer.role, answer.requestId, answer.text], ['agent', r.id, 'It is the new return value.'])
  assert.deepEqual(answer.actions, [{ kind: 'focus', target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } }])
  assert.equal(st.requests.find((x) => x.id === r.id).status, 'done')
  assert.match(g('wait', '--timeout', '1'), /no requests/, 'once finished it is not handed out again')
  const again = gt('answer', r.id, '--text', 'twice')
  assert.equal(again.code, 1); assert.match(again.err, /already done/)
  const outside = gt('answer', r.id, '--text', 'x', '--file', 'src/a.ts', '--line', '999')
  assert.equal(outside.code, 1)
  // reviewing and answering changed nothing in the repository
  assert.equal(git(fx.dir, 'status', '--porcelain'), '')
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), fx.head)
})

test('4b. presence: away, then listening while gr wait blocks, then working; a blocked wait is woken by a new request', async () => {
  const other = (await b.rpc('startSession', fx.dir, 'v0', 'feature')).sessionId
  assert.equal((await b.rpc('loadSession', other)).presence, 'away', 'nothing has been heard from a session yet')
  const w = b.start(fx.dir, 'wait', '--session', String(other), '--timeout', '30')
  await until(async () => (await b.rpc('loadSession', other)).presence === 'listening')
  const r = await b.rpc('requestCreate', other, { kind: 'question', text: 'Anything risky here?' })
  const res = await w.done
  assert.equal(res.code, 0)
  assert.match(res.out, new RegExp(`REQUEST ${r.id} question\\n  review #${other}: v0 \\(frozen\\) → feature \\(moving branch\\)\\n  Anything risky here\\?`))
  assert.equal((await b.rpc('loadSession', other)).presence, 'working', 'the session holds a request')

  b.gr(fx.dir, 'answer', r.id, '--session', String(other), '--text', 'Two places.', '--stop', 'src/a.ts:2 | the changed return', '--stop', 'src/b.ts | new module')
  b.gr(fx.dir, 'note', 'Said in the terminal: old.ts was removed.', '--file', 'src/old.ts', '--session', String(other))
  const { messages } = b.json(fx.dir, 'state', '--session', String(other)).state
  const [tourAnswer, note] = messages.slice(-2)
  assert.deepEqual(tourAnswer.actions.map((a) => [a.kind, a.stops.length, a.stops[0].note]), [['tour', 2, 'the changed return']])
  assert.deepEqual([note.role, note.requestId, note.actions], ['agent', undefined, [{ kind: 'focus', target: { kind: 'file', file: 'src/old.ts' } }]])
})

test('4c. a request the reviewer cancels stops the session at its next step (exit 130)', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Cancel me' })
  g('wait', '--timeout', '10')
  await b.rpc('requestCancel', sid, r.id)
  for (const args of [['progress', r.id, 'still going'], ['answer', r.id, '--text', 'late'], ['done', r.id], ['fail', r.id, '--text', 'x']]) {
    const res = gt(...args)
    assert.equal(res.code, 130, args.join(' '))
    assert.match(res.err, new RegExp(`CANCELLED: the reviewer cancelled request ${r.id} — stop working on it`))
  }
  assert.equal(request(r.id).status, 'cancelled')
  const never = await b.rpc('requestCreate', sid, { kind: 'question', text: 'Cancelled before pickup' })
  await b.rpc('requestCancel', sid, never.id)
  assert.match(g('wait', '--timeout', '1'), /no requests/, 'a request cancelled before pickup is never delivered')
})

test('4d. a walkthrough requested in the UI is fulfilled with annotate --request', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'walkthrough', text: 'go deeper on a.ts', update: true })
  await assert.rejects(b.rpc('requestCreate', sid, { kind: 'walkthrough' }), /already waiting/)
  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} walkthrough \\(update\\)`))
  assert.match(out, /steer: go deeper on a\.ts/)
  assert.match(out, new RegExp(`gr annotate --file <json> --request ${r.id}`))
  const stored = g('annotate', '--request', r.id, '--file', walkthroughFile('w2.json', {
    title: 'Return value bump, in depth', summary: 'a() now returns 2; two modules are new.',
    sections: [
      { id: 'core', name: 'Core change', what: 'a() returns 2.', files: ['src/a.ts'] },
      { id: 'modules', name: 'New modules', what: 'b, c and dup are new.', files: ['src/b.ts', 'src/c.ts', 'src/dup.ts'] }
    ],
    questions: [{ id: 'q1', text: 'Is 2 the intended value?', options: ['yes', 'no'] }]
  }))
  assert.match(stored, new RegExp(`walkthrough stored: 3 section\\(s\\) \\(request ${r.id} done\\)`))
  const st = state()
  assert.equal(st.requests.find((x) => x.id === r.id).status, 'done')
  assert.equal(st.iterations.length, 2)
  assert.deepEqual(st.walkthrough.sections.map((s) => s.id), ['core', 'modules', 'other-changes'])
  assert.deepEqual(st.reviewedSections, ['core'], 'a reviewed mark survives when its section still exists')
})

test('4e. answers to the walkthrough\'s open questions arrive as a decisions request', async () => {
  const c = await b.rpc('commentAdd', sid, { anchor: { kind: 'question', questionId: 'q1' }, text: 'yes', author: 'user' })
  const r = await b.rpc('requestCreate', sid, { kind: 'decisions', commentIds: [c.id] })
  assert.equal(comment(c.id).status, 'sent')
  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} decisions`))
  assert.match(out, /question q1: Is 2 the intended value\?\n\s+answer: yes/)
  g('resolve', c.id, '--verdict', 'addressed', '--note', 'Recorded: 2 is intended.')
  const done = g('done', r.id)
  assert.match(done, new RegExp(`\\[${c.id}\\] addressed — Recorded: 2 is intended\\.`))
  assert.equal(request(r.id).status, 'done')
})

test('4f. focus, tours and status lines reach the tab showing this review; targets are validated', async () => {
  const tab = await b.listen(sid)
  assert.match(g('focus', '--file', 'src/a.ts', '--line', '2'), /focused src\/a\.ts:2 in 1 open tab\(s\)/)
  assert.match(g('tour', '--stop', 'src/a.ts:2 | the change', '--stop', 'section:modules | what is new', '--stop', 'summary'), /3-stop tour sent to 1 open tab\(s\): src\/a\.ts:2 → section modules → the summary/)
  assert.match(g('say', 'Reading the callers…'), /shown in 1 tab\(s\)/)
  const actions = await until(() => { const a = tab.events.filter((e) => e.channel === 'ui:action').map((e) => e.msg.action); return a.length === 3 && a })
  assert.deepEqual(actions[0], { kind: 'focus', target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } })
  assert.deepEqual(actions[1].stops.map((s) => [s.target.kind, s.note]), [['diff', 'the change'], ['section', 'what is new'], ['summary', undefined]])
  assert.deepEqual(actions[2], { kind: 'status', text: 'Reading the callers…' })
  const bad = gt('focus', '--file', 'src/a.ts', '--line', '999')
  assert.equal(bad.code, 1); assert.match(bad.err, /does not exist|is not part of this diff/)
  assert.equal(tab.events.filter((e) => e.channel === 'ui:action').length, 3, 'a refused target was not sent')
  tab.close()
  // with no tab on the review, focus opens one at the target instead
  await until(() => /no review tab was open — opened http\S+#\/review\?session=\d+&focus=/.test(gt('focus', '--section', 'core').out))
})

test('5. close and resume: the same review comes back with its state', () => {
  b.stop()
  assert.match(b.gr(fx.dir, 'status'), /not running/)
  const info = b.json(fx.dir, 'review', '--resume')
  assert.deepEqual([info.sessionId, info.resumed, info.hasWalkthrough, info.comments], [sid, true, true, 10])
  assert.equal(state().messages.length > 0, true, 'the conversation survived the restart')
  assert.equal(b.json(fx.dir, 'review', '--resume', 'main..feature').sessionId, sid, 'resume by comparison identity')
  const none = b.try(fx.dir, 'review', '--resume', 'v0..main')
  assert.equal(none.code, 1); assert.match(none.err, /no saved review for/)
  assert.match(b.gr(fx.dir, 'review', '--resume', '--list'), new RegExp(`#${sid}  main \\(moving branch\\) → feature \\(moving branch\\)  Return value bump, in depth`))
  const all = g('requests', '--all')
  assert.match(all, /question · done/); assert.match(all, /question · cancelled/); assert.match(all, /walkthrough · done/)
  assert.match(g('requests'), /no pending or running requests/)
})

test('6. another commit is detected and only its delta is shown', () => {
  assert.match(g('drift'), /no drift/)
  g('viewed', '--file', 'src/b.ts'); g('viewed', '--file', 'src/c.ts')
  write(fx.dir, 'src/a.ts', ['// header one', '// header two', 'export function a() {', '  return 3', '}', 'export const K = 10', 'export const L = 11', 'export const M = 12', 'export const J = 20', ''].join('\n'))
  write(fx.dir, 'src/b.ts', ['export function b() {', '\treturn 43', '}', ''].join('\n'))
  write(fx.dir, 'src/dup.ts', ['// one', '// two', '// three', 'function first() {', '  return null', '}', 'function second() {', '  return null', '}', ''].join('\n'))
  const next = commit(fx.dir, 'return 3, add header')
  const info = b.json(fx.dir, 'review', '--resume', 'main..feature')
  assert.equal(info.newSinceReview, true)
  assert.equal(info.compare.sha, next, 'a branch side follows its tip')
  assert.match(b.gr(fx.dir, 'review', '--resume', 'main..feature'), /NEW SINCE LAST REVIEW: the code changed since the reviewed state \w{7}/)
  const drift = gj('drift')
  assert.deepEqual([drift.moved, drift.baselineKind, drift.baseline], [true, 'reviewed', fx.head])
  assert.deepEqual(drift.commits.map((c) => c.subject), ['return 3, add header'])
  assert.deepEqual(drift.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts', 'src/dup.ts'], 'only the files touched since the review')
  assert.deepEqual(drift.changedSinceViewed, ['src/b.ts'], 'a viewed file that changed is flagged; an unchanged one is not')
  const text = g('drift')
  assert.match(text, /1 new commit\(s\) since the reviewed state/)
  assert.match(text, /\+\s+4\s+return 3/)
  assert.doesNotMatch(text, /src\/c\.ts/)
  assert.match(g('diff', '--file', 'src/a.ts'), /\+\s+4\s+return 3\s+«since-review»/)
  assert.match(g('state'), /viewed files: 2\/9 \(src\/b\.ts — CHANGED since viewed, src\/c\.ts\)/)
  g('viewed', '--file', 'src/b.ts', '--unset')
  assert.deepEqual(gj('drift').changedSinceViewed, [])
})

test('6b. comments follow their line; a comment whose line is gone is never re-attached', () => {
  const moved = comment(ids.moves)
  assert.deepEqual([moved.status, moved.anchor.line, moved.anchor.lineContent], ['queued', 9, 'export const J = 20'], 'followed from line 7 to 9')
  const stale = comment(ids.stale)
  assert.deepEqual([stale.status, stale.anchor.line, stale.anchor.lineContent], ['outdated', 2, '  return 2'], '"return 2" is gone: outdated, anchor kept as written')
  const noteMoved = comment(ids.noteMoves)
  assert.deepEqual([noteMoved.status, noteMoved.anchor.line, noteMoved.lineGone], ['note', 6, undefined], 'notes follow their line too')
  const noteGone = comment(ids.note)
  assert.deepEqual([noteGone.status, noteGone.anchor.line, noteGone.anchor.lineContent, noteGone.lineGone], ['note', 2, '  return 2', true], 'a note whose line is gone is flagged, not moved')
  assert.deepEqual([comment(ids.removed).anchor.line, comment(ids.removed).lineGone], [2, undefined], 'an old-side anchor is unaffected')
  // two identical lines: after the shift the nearest by number is the WRONG one (line 5,
  // in first()); the neighbouring lines identify the right one (line 8, in second())
  assert.deepEqual([comment(ids.dup).anchor.line, comment(ids.dup).status], [8, 'queued'], 'identical lines are told apart by their context')
  // whitespace-only reformat keeps the comment attached, with the line as it now reads
  assert.deepEqual([comment(ids.ws).status, comment(ids.ws).anchor.line, comment(ids.ws).anchor.lineContent], ['queued', 2, '\treturn 43'])
  assert.match(g('comments', '--status', 'outdated'), /stale anchor — the line it was written on is gone: "  return 2"/)
  assert.match(g('comments', '--status', 'note'), new RegExp(`\\[${ids.note}\\] note[^\\[]*stale anchor`))
})

test('7. feedback is applied only on request: the session edits, resolves each comment, nothing is committed', async () => {
  const head = git(fx.dir, 'rev-parse', 'HEAD')
  const extra = commentId(g('comment', '--as', 'user', '--file', 'src/c.ts', '--line', '1', '--text', 'Explain c.'))
  await assert.rejects(b.rpc('requestCreate', sid, { kind: 'apply', commentIds: ['nope'] }), /none of those comments is waiting to be sent/)
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [ids.moves, extra], text: 'keep it small' })
  assert.equal(r.commit, false)
  assert.deepEqual([comment(ids.moves).status, comment(extra).status], ['sent', 'sent'])

  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`REQUEST ${r.id} apply`))
  assert.match(out, /commit: no/)
  assert.match(out, /steer: keep it small/)
  assert.match(out, /do NOT commit/)
  assert.match(out, new RegExp(`\\[${ids.moves}\\] sent · user · src/a\\.ts:9\\n\\s+Why 20\\?`))
  assert.match(out, new RegExp(`\\[${extra}\\] sent · user · src/c\\.ts:1`))
  assert.match(out, new RegExp(`then: gr done ${r.id}`))

  // the session makes the edit with its own tools…
  fs.appendFileSync(path.join(fx.dir, 'src/a.ts'), '// J is the retry budget\n')
  g('progress', r.id, 'edited src/a.ts')
  g('resolve', ids.moves, '--verdict', 'addressed', '--note', 'Documented the constant.')
  // …and reports; the comment it did not handle goes back to the reviewer's queue
  const done = g('done', r.id, '--text', 'one of two handled')
  assert.match(done, new RegExp(`\\[${ids.moves}\\] addressed — Documented the constant\\.`))
  assert.match(done, new RegExp(`\\[${extra}\\] NOT handled \\(back to queued\\)`))
  assert.deepEqual([comment(ids.moves).status, comment(ids.moves).resolution.verdict, comment(extra).status], ['resolved', 'addressed', 'queued'])
  assert.deepEqual(request(r.id).progress.map((p) => p.text), ['edited src/a.ts', 'one of two handled'])
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), head, 'nothing was committed')
  assert.equal(git(fx.dir, 'status', '--porcelain'), 'M src/a.ts', 'the edit is in the working tree, unstaged')
  assert.match(g('diff', '--file', 'src/a.ts'), /\/\/ J is the retry budget\s+«unstaged/, 'uncommitted lines are labelled')

  // the reviewer can ask for a commit; the request says so. A request can also fail.
  const r2 = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [extra], commit: true })
  const out2 = g('wait', '--timeout', '10')
  assert.match(out2, /commit: yes/); assert.match(out2, /pass --sha <commit> to gr resolve/); assert.doesNotMatch(out2, /do NOT commit/)
  assert.match(g('fail', r2.id, '--text', 'needs a decision first'), /marked failed/)
  assert.deepEqual([request(r2.id).status, request(r2.id).error, comment(extra).status], ['failed', 'needs a decision first', 'queued'])
})

test('8. approval is the reviewer\'s act and covers one exact state', () => {
  assert.match(g('state'), /approved: no ·/, 'finishing a walkthrough approved nothing')
  const refused = gt('approve')
  assert.equal(refused.code, 1); assert.match(refused.err, /refused: approval is the human reviewer's decision/)
  assert.match(g('approve', '--confirmed-by-user'), /approved at \w{7} including the current uncommitted changes/)
  assert.match(g('state'), /approved: yes \(this exact state\)/)
  assert.match(g('unapprove'), /approval withdrawn/)
  assert.match(g('state'), /approved: no ·/)
  g('approve', '--confirmed-by-user')

  // a scratch file the walkthrough does not include is excluded, and does not undo it
  write(fx.dir, 'scratch.txt', 'tmp\n')
  assert.match(g('diff', '--stat'), /## scratch\.txt \(added, \+1 −0, untracked, excluded from the review\)/)
  assert.match(g('state'), /approved: yes \(this exact state\)/)

  // an uncommitted edit to reviewed code does
  fs.appendFileSync(path.join(fx.dir, 'src/c.ts'), 'export const later = 1\n')
  assert.match(g('state'), /approved: no — last approved at \w{7}, the code has changed since/)
  const dirty = g('drift')
  assert.match(dirty, /no new commits since the approved state \w{7}, but the working tree has uncommitted changes/)
  assert.match(dirty, /The earlier approval does NOT cover this state\./)
  git(fx.dir, 'checkout', '--', 'src/c.ts')
  assert.match(g('state'), /approved: yes \(this exact state\)/, 'back at the approved state, it reads as approved again')

  // and so does a new commit
  fs.rmSync(path.join(fx.dir, 'scratch.txt'))
  commit(fx.dir, 'keep the edit')
  assert.match(g('state'), /approved: no — last approved at \w{7}, the code has changed since/)
  const drift = g('drift')
  assert.match(drift, /1 new commit\(s\) since the approved state/)
  assert.match(drift, /The earlier approval does NOT cover this state\./)
})

test('9. a fixed commit, a moving branch and a direct comparison are different reviews', async () => {
  const tip = git(fx.dir, 'rev-parse', 'feature'); const mainSha = git(fx.dir, 'rev-parse', 'main')
  const frozen = b.json(fx.dir, 'review', `main..${tip}`)
  assert.notEqual(frozen.sessionId, sid)
  assert.deepEqual([frozen.base.kind, frozen.compare.kind], ['branch', 'commit'])
  const pinned = b.json(fx.dir, 'review', 'main..feature', '--freeze')
  assert.deepEqual([pinned.base.kind, pinned.compare.kind], ['commit', 'commit'], '--freeze pins branch names to their current commits')
  assert.equal(b.json(fx.dir, 'review', `${mainSha}..${tip}`).sessionId, pinned.sessionId)
  assert.notEqual(pinned.sessionId, frozen.sessionId)

  write(fx.dir, 'src/c.ts', 'export const c = 5\n')
  const moved = commit(fx.dir, 'bump c')
  assert.equal(b.json(fx.dir, 'review', '--resume', '--session', String(frozen.sessionId)).compare.sha, tip, 'the frozen review did not move')
  const branch = b.json(fx.dir, 'review', 'main..feature')
  assert.deepEqual([branch.sessionId, branch.compare.sha], [sid, moved], 'the branch review is resumed and follows the tip')
  const direct = b.json(fx.dir, 'review', 'main..feature', '--direct')
  assert.equal(direct.direct, true)
  assert.equal(new Set([sid, frozen.sessionId, pinned.sessionId, direct.sessionId]).size, 4)
  assert.equal(b.json(fx.dir, 'review', 'main..feature', '--direct').sessionId, direct.sessionId)

  // a review that ends at a fixed commit has nowhere to make edits: its comments can
  // still be sent, and the request says so (a commit cannot be asked for)
  const F = ['--session', String(frozen.sessionId)]
  const c = await b.rpc('commentAdd', frozen.sessionId, { anchor: { kind: 'file', file: 'src/a.ts' }, text: 'Rename this.', author: 'user' })
  const r = await b.rpc('requestCreate', frozen.sessionId, { kind: 'apply', commentIds: [c.id], commit: true })
  assert.deepEqual([r.editable, r.commit, r.replyIds], [false, false, []])
  const out = b.gr(fx.dir, 'wait', '--timeout', '10', ...F)
  assert.match(out, new RegExp(`REQUEST ${r.id} apply\\n  review #${frozen.sessionId}: main \\(moving branch\\) → \\w+ \\(frozen\\)`))
  assert.match(out, /commit: no/)
  assert.match(out, /this comparison cannot be edited \(it ends at a fixed commit, or its branch is not checked out\): do not change files/)
  assert.doesNotMatch(out, /edit in:|do NOT commit|asked for the edits to be committed/)
  b.gr(fx.dir, 'reply', c.id, '--text', 'That needs the branch; this review is pinned to a commit.', ...F)
  b.gr(fx.dir, 'resolve', c.id, '--verdict', 'skipped', '--note', 'Cannot edit a fixed commit.', ...F)
  assert.match(b.gr(fx.dir, 'done', r.id, ...F), new RegExp(`\\[${c.id}\\] skipped — Cannot edit a fixed commit\\.`))
  assert.equal(b.json(fx.dir, 'comments', ...F)[0].status, 'resolved')

  assert.equal(b.json(fx.dir, 'sessions').length, 5)
  b.gr(fx.dir, 'archive', String(pinned.sessionId))
  assert.equal(b.json(fx.dir, 'sessions').length, 4)
  assert.equal(b.json(fx.dir, 'sessions', '--include-archived').length, 5)
  b.gr(fx.dir, 'unarchive', String(pinned.sessionId))
  assert.equal(b.json(fx.dir, 'sessions').length, 5)
  for (const cmd of ['generate', 'chat', 'apply', 'permit', 'cancel']) {
    const r = b.try(fx.dir, cmd)
    assert.equal(r.code, 1); assert.match(r.err, /there is no review engine any more: the reviewer's requests arrive through `gr wait`/)
  }
})
