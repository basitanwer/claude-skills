// A resolution can say where the fix is: `gr resolve --changed "path:start-end"` names
// the lines the session changed for a comment. The server checks them against git the
// way it checks an anchor and copies the first line's text itself; with `--sha` alone
// the ranges are the lines that commit added.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commit, git, makeBridge, makeFixture, write } from './helpers.mjs'

let b; let fx; let sid
const S = () => ['--session', String(sid)]
const g = (...args) => b.gr(fx.dir, ...args, ...S())
const gj = (...args) => b.json(fx.dir, ...args, ...S())
const state = () => gj('state').state
const comment = (id) => state().comments.find((c) => c.id === id)
/** A reviewer's comment on a file (a file anchor does not move when lines are edited). */
const ask = async (file = 'src/a.ts', text = 'Please fix.') => (await b.rpc('commentAdd', sid, { anchor: { kind: 'file', file }, text, author: 'user' })).id
const resolve = (id, ...args) => b.try(fx.dir, 'resolve', id, '--verdict', 'addressed', '--note', 'Fixed.', ...args, ...S())
const A = ['export function a() {', '  return 2', '}', 'export const K = 10', 'export const L = 11', 'export const M = 12', 'export const J = 20']
const lines = (list) => list.join('\n') + '\n'

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a single line and a range are stored with the first line\'s text, copied from git', async () => {
  const c = await ask()
  const res = resolve(c, '--changed', 'src/a.ts:2', '--changed', 'src/a.ts:4-6')
  assert.equal(res.code, 0, res.err)
  assert.equal(res.out, `resolved ${c} (src/a.ts) as addressed: Fixed.\n  changed: src/a.ts:2, src/a.ts:4-6\n`)
  const r = comment(c).resolution
  assert.deepEqual(Object.keys(r), ['verdict', 'note', 'changed', 'at'])
  assert.deepEqual(r.changed, [
    { file: 'src/a.ts', start: 2, end: 2, lineContent: '  return 2' },
    { file: 'src/a.ts', start: 4, end: 6, lineContent: 'export const K = 10' }
  ])
  assert.equal(comment(c).status, 'resolved')

  // whatever text a caller sends along is not stored: only the file and the numbers are read
  const forged = await ask('src/b.ts')
  const stored = await b.rpc('commentUpdate', sid, forged, { resolution: { verdict: 'addressed', note: 'n', changed: [{ file: 'src/b.ts', start: 2, lineContent: 'rm -rf /', text: 'nope', extra: 1 }] } })
  assert.deepEqual(stored.resolution.changed, [{ file: 'src/b.ts', start: 2, end: 2, lineContent: '  return 43' }], 'the line is read from git; `end` defaults to `start`')

  // a renamed file is addressable by either path, and lines outside the hunks count too
  const moved = await ask('src/moved.ts')
  assert.equal(resolve(moved, '--changed', 'src/moveme.ts:2-3').code, 0)
  assert.deepEqual(comment(moved).resolution.changed, [{ file: 'src/moved.ts', start: 2, end: 3, lineContent: 'export const stay2 = 2' }])
  // the page writes an en dash between the numbers; copied back, it is read the same
  assert.equal(resolve(moved, '--changed', 'src/moved.ts:1–2').code, 0)
  assert.deepEqual(comment(moved).resolution.changed.map((x) => [x.start, x.end]), [[1, 2]])
})

test('the lines of an uncommitted edit are accepted on a moving comparison', async () => {
  const c = await ask()
  const early = resolve(c, '--changed', 'src/a.ts:8-9')
  assert.equal(early.code, 1); assert.match(early.err, /changed src\/a\.ts:8-9: src\/a\.ts has 7 lines on the compare side; line 8 does not exist/)
  // the session edits the working tree: one line changed, two added, one new file
  write(fx.dir, 'src/a.ts', lines([A[0], '  return 3', ...A.slice(2), '// J is the retry budget', 'export const N = 30']))
  write(fx.dir, 'src/new.ts', lines(['export const fresh = 1', 'export const fresher = 2']))
  assert.equal(resolve(c, '--changed', 'src/a.ts:2', '--changed', 'src/a.ts:8-9', '--changed', 'src/new.ts:1-2').code, 0)
  assert.deepEqual(comment(c).resolution.changed, [
    { file: 'src/a.ts', start: 2, end: 2, lineContent: '  return 3' },
    { file: 'src/a.ts', start: 8, end: 9, lineContent: '// J is the retry budget' },
    { file: 'src/new.ts', start: 1, end: 2, lineContent: 'export const fresh = 1' }
  ])
  assert.equal(git(fx.dir, 'status', '--porcelain'), 'M src/a.ts\n?? src/new.ts', 'nothing was staged or committed to read them')
})

test('a range that is not there is refused by name, and the comment stays unresolved', async () => {
  const c = await ask()
  const was = comment(c)
  const refused = [
    [['--changed', 'src/nope.ts:1'], /^gr: changed src\/nope\.ts:1: src\/nope\.ts is not part of this diff\./, 'a file that is not in the diff'],
    [['--changed', 'a.ts:2'], /^gr: changed a\.ts:2: a\.ts is not part of this diff\. Did you mean: src\/a\.ts\?/, 'a bare file name'],
    [['--changed', 'src/b.ts:2-9'], /^gr: changed src\/b\.ts:2-9: src\/b\.ts has 3 lines on the compare side; line 9 does not exist\n$/, 'a line past the end'],
    [['--changed', 'src/a.ts:5-2'], /^gr: changed src\/a\.ts:5-2: the range ends before it starts\n$/, 'an inverted range'],
    [['--changed', 'src/a.ts:0'], /^gr: changed \{"file":"src\/a\.ts","start":0,"end":0\}: a range is \{ file, start, end \} with line numbers from 1\n$/, 'line 0'],
    [['--changed', 'src/a.ts'], /^gr: changed range "src\/a\.ts" must be "path:line" or "path:start-end"\n$/, 'no line'],
    [['--changed', 'src/a.ts:two'], /^gr: changed range "src\/a\.ts:two" must be "path:line" or "path:start-end"\n$/, 'a line that is not a number'],
    [['--changed', 'src/a.ts:2-'], /^gr: changed range "src\/a\.ts:2-" must be/, 'half a range'],
    [['--changed', 'src/old.ts:1'], /^gr: changed src\/old\.ts:1: src\/old\.ts has no lines on the compare side \(deleted\)\n$/, 'a deleted file'],
    [['--changed', 'img.bin:1'], /^gr: changed img\.bin:1: img\.bin is binary: it has no lines\n$/, 'a binary file'],
    [['--changed', 'src/a.ts:2', '--changed', 'src/b.ts:4'], /^gr: changed src\/b\.ts:4: src\/b\.ts has 3 lines/, 'one bad range among good ones']
  ]
  for (const [args, re, what] of refused) {
    const res = resolve(c, ...args)
    assert.equal(res.code, 1, what); assert.equal(res.out, '', what); assert.match(res.err, re, what)
    assert.deepEqual(comment(c), was, `${what}: the comment is as it was`)
  }
  assert.match(b.try(fx.dir, 'resolve', c, ...S(), '--verdict', 'addressed', '--note', 'n', '--changed').err, /^gr: --changed needs a value\n$/)
  // straight to the server, as any caller could: a reply sent along is not applied either
  await assert.rejects(b.rpc('commentUpdate', sid, c, { reply: { author: 'agent', text: 'Done.' }, resolution: { verdict: 'addressed', note: 'n', changed: [{ file: 'src/a.ts', start: 40 }] } }), /changed src\/a\.ts:40: src\/a\.ts has 9 lines on the compare side; line 40 does not exist/)
  await assert.rejects(b.rpc('commentUpdate', sid, c, { resolution: { verdict: 'addressed', note: 'n', changed: 'src/a.ts:2' } }), /changed is a list of \{ file, start, end \}/)
  await assert.rejects(b.rpc('commentUpdate', sid, c, { resolution: { verdict: 'addressed', note: 'n', changed: [{ file: 'src/a.ts', start: 1.5 }] } }), /line numbers from 1/)
  assert.deepEqual(comment(c), was)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', `${sid}.json`), 'utf8')).state.comments.find((x) => x.id === c), was, 'on disk too')
})

test('in a batch a bad range applies nothing; strings and objects both name ranges', async () => {
  const c = await ask(); const d = await ask('src/b.ts')
  const was = state()
  const bad = b.batch(fx.dir, [
    { op: 'reply', id: c, text: 'Capped it.' },
    { op: 'resolve', id: c, verdict: 'addressed', note: 'Capped.', changed: ['src/a.ts:2'] },
    { op: 'resolve', id: d, verdict: 'addressed', note: 'Same.', changed: ['src/b.ts:2', { file: 'src/b.ts', start: 99, end: 99 }] }
  ], ...S())
  assert.equal(bad.code, 1); assert.equal(bad.out, '')
  assert.match(bad.err, /^gr: operation 3 \(commentUpdate\) failed: changed src\/b\.ts:99: src\/b\.ts has 3 lines on the compare side; line 99 does not exist — nothing was applied\n$/)
  assert.deepEqual(state(), was, 'neither the reply nor the first resolution was kept')
  const shape = b.batch(fx.dir, [{ op: 'resolve', id: c, verdict: 'addressed', note: 'n', changed: ['src/a.ts:2', 'nowhere'] }], ...S())
  assert.equal(shape.code, 1); assert.match(shape.err, /^gr: operation 1 \(resolve\): changed range "nowhere" must be "path:line" or "path:start-end" — nothing was applied\n$/)
  const shape2 = b.batch(fx.dir, [{ op: 'resolve', id: c, verdict: 'addressed', note: 'n', changed: [{ path: 'src/a.ts', line: 2 }] }], ...S())
  assert.equal(shape2.code, 1); assert.match(shape2.err, /operation 1 \(resolve\): changed range \{"path":"src\/a\.ts","line":2\} must be "path:line" or "path:start-end", or \{ file, start, end \} — nothing was applied/)
  assert.deepEqual(state(), was)

  const ok = b.batch(fx.dir, [
    { op: 'resolve', id: c, verdict: 'addressed', note: 'Capped.', changed: ['src/a.ts:2', { file: 'src/a.ts', start: 8, end: 9 }] },
    { op: 'resolve', id: d, verdict: 'reworked', note: 'Same.', changed: 'src/b.ts:1-3' }
  ], ...S())
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.out, `resolved ${c} (src/a.ts) as addressed: Capped.\n  changed: src/a.ts:2, src/a.ts:8-9\nresolved ${d} (src/b.ts) as reworked: Same.\n  changed: src/b.ts:1-3\nbatch: 2 operation(s) applied\n`)
  assert.deepEqual(comment(c).resolution.changed.map((x) => [x.file, x.start, x.end, x.lineContent]), [['src/a.ts', 2, 2, '  return 3'], ['src/a.ts', 8, 9, '// J is the retry budget']])
  assert.deepEqual(comment(d).resolution.changed, [{ file: 'src/b.ts', start: 1, end: 3, lineContent: 'export function b() {' }])
})

test('at most 20 ranges: one more is refused, and the message says so', async () => {
  const c = await ask()
  const was = comment(c)
  const many = (n) => Array.from({ length: n }, (_, i) => ['--changed', `src/a.ts:${(i % 9) + 1}`]).flat()
  const over = resolve(c, ...many(21))
  assert.equal(over.code, 1); assert.match(over.err, /^gr: a resolution names at most 20 changed ranges, got 21: merge neighbouring ones, or name the ones that matter\n$/)
  assert.deepEqual(comment(c), was)
  assert.equal(resolve(c, ...many(20)).code, 0)
  assert.equal(comment(c).resolution.changed.length, 20)
})

test('--sha alone takes the ranges from that commit; --changed with --sha wins', async () => {
  const sha = commit(fx.dir, 'fix: return 3, document J')       // the uncommitted edits above: a.ts lines 2, 8-9 and src/new.ts
  const c = await ask()
  const res = resolve(c, '--sha', sha)
  assert.equal(res.code, 0, res.err)
  assert.equal(res.out, `resolved ${c} (src/a.ts) as addressed: Fixed.\n  changed, taken from commit ${sha.slice(0, 7)}: src/a.ts:2, src/a.ts:8-9, src/new.ts:1-2\n`)
  const r = comment(c).resolution
  assert.deepEqual(Object.keys(r), ['verdict', 'note', 'commit', 'changed', 'at'])
  assert.equal(r.commit, sha)
  assert.deepEqual(r.changed, [
    { file: 'src/a.ts', start: 2, end: 2, lineContent: '  return 3' },
    { file: 'src/a.ts', start: 8, end: 9, lineContent: '// J is the retry budget' },
    { file: 'src/new.ts', start: 1, end: 2, lineContent: 'export const fresh = 1' }
  ])
  // one commit can hold the fixes for several comments: naming the lines wins
  const named = resolve(c, '--sha', sha, '--changed', 'src/a.ts:8')
  assert.equal(named.out, `resolved ${c} (src/a.ts) as addressed: Fixed.\n  changed: src/a.ts:8\n`)
  assert.deepEqual([comment(c).resolution.commit, comment(c).resolution.changed], [sha, [{ file: 'src/a.ts', start: 8, end: 8, lineContent: '// J is the retry budget' }]])
  // …and a named range that is not there is still refused, commit or no commit
  assert.match(resolve(c, '--sha', sha, '--changed', 'src/a.ts:80').err, /changed src\/a\.ts:80: src\/a\.ts has 9 lines/)

  // a later edit moved the commit's lines in a.ts: only what still reads as the commit left it is kept
  write(fx.dir, 'src/a.ts', lines(['// header', A[0], '  return 3', ...A.slice(2), '// J is the retry budget', 'export const N = 30']))
  assert.equal(resolve(c, '--sha', sha).code, 0)
  assert.deepEqual(comment(c).resolution.changed.map((x) => `${x.file}:${x.start}-${x.end}`), ['src/new.ts:1-2'])
  git(fx.dir, 'checkout', '-q', '--', 'src/a.ts')

  // a commit that only removes lines has no new-side lines to point at
  write(fx.dir, 'src/a.ts', lines([A[0], '  return 3', ...A.slice(2, 5), A[6], '// J is the retry budget', 'export const N = 30']))
  const removal = commit(fx.dir, 'drop M')
  const gone = resolve(c, '--sha', removal)
  assert.equal(gone.out, `resolved ${c} (src/a.ts) as addressed: Fixed.\n  no changed lines recorded: commit ${removal.slice(0, 7)} added no lines that are part of this review as it is now (name them with --changed)\n`)
  assert.deepEqual(Object.keys(comment(c).resolution), ['verdict', 'note', 'commit', 'at'])
  assert.match(resolve(c, '--sha', 'no-such-commit').err, /--sha no-such-commit is not a commit/)
})

test('a commit with more than 20 separate changes keeps 20 and says how many it left out', async () => {
  const body = (edit) => lines(Array.from({ length: 60 }, (_, i) => (edit(i + 1) ? `line ${i + 1} changed` : `line ${i + 1}`)))
  write(fx.dir, 'src/many.ts', body(() => false)); commit(fx.dir, 'add many')
  write(fx.dir, 'src/many.ts', body((n) => n % 2 === 0 && n <= 50))
  const sha = commit(fx.dir, 'every other line')                 // 25 single-line changes
  const c = await ask('src/many.ts')
  const res = resolve(c, '--sha', sha)
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, new RegExp(`  changed, taken from commit ${sha.slice(0, 7)}: src/many\\.ts:2, src/many\\.ts:4, .*src/many\\.ts:40\\n  5 more range\\(s\\) of that commit are not recorded \\(at most 20 are kept\\): name the ones that matter with --changed\\n$`))
  const r = comment(c).resolution
  assert.deepEqual([r.changed.length, r.changed.at(-1).start, r.changedMore], [20, 40, 5])
  assert.match(g('comments', '--status', 'resolved'), new RegExp(`\\[${c}\\][^\\[]*→ addressed: Fixed\\. \\(${sha.slice(0, 7)}\\) · changed: src/many\\.ts:2, src/many\\.ts:4, src/many\\.ts:6 \\+22 more\\n`))
})

test('gr comments and the summary of gr done mention the ranges', async () => {
  const c = await ask('src/b.ts', 'Why 43?'); const plain = await ask('src/c.ts', 'Explain c.')
  const r = await b.rpc('requestCreate', sid, { kind: 'apply', commentIds: [c, plain] })
  const out = g('wait', '--timeout', '10')
  assert.match(out, new RegExp(`record each with: gr resolve <commentId> --session ${sid} --verdict addressed\\|reworked\\|skipped --note "…" --changed "path:start-end" \\(the lines you changed for that comment, as they are numbered now; repeat --changed for each place\\), then: gr done ${r.id} --session ${sid}\\n`))
  assert.match(out, /gr batch --session \d+ --file ops\.json \(a resolve operation takes "changed": \["path:start-end"\]\)/)
  write(fx.dir, 'src/b.ts', lines(['export function b() {', '  // 43 is the limit the plan names', '  return 43', '}']))
  g('resolve', c, '--verdict', 'addressed', '--note', 'Said why.', '--changed', 'src/b.ts:2')
  g('resolve', plain, '--verdict', 'skipped', '--note', 'It is a constant.')
  const listed = g('comments')
  assert.match(listed, new RegExp(`\\[${c}\\] resolved · user · src/b\\.ts\\n    Why 43\\? → addressed: Said why\\. · changed: src/b\\.ts:2\\n`))
  assert.match(listed, new RegExp(`\\[${plain}\\] resolved · user · src/c\\.ts\\n    Explain c\\. → skipped: It is a constant\\.\\n`))
  assert.equal(g('done', r.id), `request ${r.id} done\nresolutions:\n  [${c}] addressed — Said why. · changed: src/b.ts:2\n  [${plain}] skipped — It is a constant.\n`)
  git(fx.dir, 'checkout', '-q', '--', 'src/b.ts')
})

test('a resolution without changed lines is exactly what it was', async () => {
  const c = await ask()
  const res = b.try(fx.dir, 'resolve', c, '--verdict', 'skipped', '--note', 'Out of scope.', ...S())
  assert.equal(res.out, `resolved ${c} (src/a.ts) as skipped: Out of scope.\n`)
  const stored = JSON.parse(fs.readFileSync(path.join(b.home, 'sessions', `${sid}.json`), 'utf8')).state.comments.find((x) => x.id === c)
  assert.deepEqual(Object.keys(stored.resolution), ['verdict', 'note', 'at'])
  assert.deepEqual(stored.resolution, { verdict: 'skipped', note: 'Out of scope.', at: stored.resolution.at })
  assert.equal(JSON.stringify(stored.resolution), `{"verdict":"skipped","note":"Out of scope.","at":"${stored.resolution.at}"}`)
  assert.match(g('comments'), new RegExp(`\\[${c}\\] resolved · user · src/a\\.ts\\n    Please fix\\. → skipped: Out of scope\\.\\n`))
  // an empty list is no list; the page's own "Resolve" (a status, no outcome) stores no resolution at all
  const empty = await b.rpc('commentUpdate', sid, c, { resolution: { verdict: 'skipped', note: 'n', changed: [] } })
  assert.deepEqual(Object.keys(empty.resolution), ['verdict', 'note', 'at'])
  const d = await ask()
  assert.equal((await b.rpc('commentUpdate', sid, d, { status: 'resolved' })).resolution, undefined)
  // reopening drops the outcome, ranges included
  await b.rpc('commentUpdate', sid, c, { resolution: { verdict: 'addressed', note: 'n', changed: [{ file: 'src/a.ts', start: 1 }] } })
  assert.equal((await b.rpc('commentUpdate', sid, c, { status: 'queued' })).resolution, undefined)
})

test('a comparison that cannot be edited accepts ranges that exist, and its instructions do not ask for them', async () => {
  const frozen = b.json(fx.dir, 'review', 'HEAD~1..HEAD').sessionId
  const F = ['--session', String(frozen)]
  const c = (await b.rpc('commentAdd', frozen, { anchor: { kind: 'file', file: 'src/many.ts' }, text: 'Why every other line?', author: 'user' })).id
  const r = await b.rpc('requestCreate', frozen, { kind: 'apply', commentIds: [c] })
  assert.equal(r.editable, false)
  const ev = b.json(fx.dir, 'wait', '--timeout', '10', ...F).requests[0]
  assert.match(ev.do, /this comparison cannot be edited/)
  assert.doesNotMatch(ev.do, /changed/)
  // the working tree is not this comparison's compare side: the commit is
  write(fx.dir, 'src/many.ts', fs.readFileSync(path.join(fx.dir, 'src/many.ts'), 'utf8') + 'line 61, uncommitted\n')
  assert.match(b.try(fx.dir, 'resolve', c, '--verdict', 'skipped', '--note', 'n', '--changed', 'src/many.ts:61', ...F).err, /changed src\/many\.ts:61: src\/many\.ts has 60 lines on the compare side; line 61 does not exist/)
  assert.match(b.try(fx.dir, 'resolve', c, '--verdict', 'skipped', '--note', 'n', '--changed', 'src/a.ts:1', ...F).err, /changed src\/a\.ts:1: src\/a\.ts is not part of this diff/)
  const out = b.gr(fx.dir, 'resolve', c, '--verdict', 'skipped', '--note', 'Pinned to a commit.', '--changed', 'src/many.ts:2-4', ...F)
  assert.equal(out, `resolved ${c} (src/many.ts) as skipped: Pinned to a commit.\n  changed: src/many.ts:2-4\n`)
  assert.deepEqual(b.json(fx.dir, 'comments', ...F)[0].resolution.changed, [{ file: 'src/many.ts', start: 2, end: 4, lineContent: 'line 2 changed' }])
  // on the moving comparison the same uncommitted line exists
  const m = await ask('src/many.ts')
  assert.equal(resolve(m, '--changed', 'src/many.ts:61').code, 0)
  assert.equal(comment(m).resolution.changed[0].lineContent, 'line 61, uncommitted')
  git(fx.dir, 'checkout', '-q', '--', 'src/many.ts')
})
