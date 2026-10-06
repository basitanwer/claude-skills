// "Expand context": lines of a changed file outside its diff hunks come from git
// (old side: the diff base; new side: the compare side, working tree included).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { commit, git, makeBridge, makeFixture, write } from './helpers.mjs'

let b; let fx; let id
const long = (edit) => Array.from({ length: 60 }, (_, i) => (edit[i + 1] ?? `line ${i + 1}`)).join('\n') + '\n'
before(async () => {
  b = await makeBridge(); fx = makeFixture()
  git(fx.dir, 'checkout', '-q', 'main'); write(fx.dir, 'src/long.ts', long({})); commit(fx.dir, 'add long')
  git(fx.dir, 'checkout', '-q', 'feature'); git(fx.dir, 'merge', '-q', '-m', 'merge main', 'main')
  write(fx.dir, 'src/long.ts', long({ 5: 'line five changed', 50: 'line fifty changed' })); commit(fx.dir, 'two separate edits')
  id = b.json(fx.dir, 'review', 'main..feature').sessionId
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('the gap between two hunks can be read from either side', async () => {
  const file = (await b.rpc('loadSession', id)).files.find((f) => f.path === 'src/long.ts')
  assert.equal(file.hunks.length, 2, 'two edits far apart are two hunks')
  const gap = await b.rpc('fileLines', id, 'src/long.ts', 'new', 9, 46)
  assert.deepEqual([gap.start, gap.lines.length, gap.total, gap.lines[0], gap.lines.at(-1)], [9, 38, 60, 'line 9', 'line 46'])
  const old = await b.rpc('fileLines', id, 'src/long.ts', 'old', 5, 5)
  assert.deepEqual(old.lines, ['line 5'], 'the old side is the file at the diff base')
  assert.deepEqual((await b.rpc('fileLines', id, 'src/long.ts', 'new', 5, 5)).lines, ['line five changed'])
  assert.deepEqual((await b.rpc('fileLines', id, 'src/long.ts', 'new', 58, 999)).lines, ['line 58', 'line 59', 'line 60'], 'the range is clamped to the file')
})

test('the new side includes uncommitted edits; renamed and deleted files resolve on the right side', async () => {
  write(fx.dir, 'src/long.ts', long({ 5: 'line five changed', 50: 'line fifty changed', 30: 'uncommitted thirty' }))
  assert.deepEqual((await b.rpc('fileLines', id, 'src/long.ts', 'new', 30, 30)).lines, ['uncommitted thirty'])
  assert.deepEqual((await b.rpc('fileLines', id, 'src/moved.ts', 'old', 1, 1)).lines, ['export const stay1 = 1'], 'old side of a rename is read from its old path')
  assert.deepEqual((await b.rpc('fileLines', id, 'src/old.ts', 'new', 1, 5)).lines, [], 'a deleted file has no new side')
  await assert.rejects(b.rpc('fileLines', id, 'specs/rate-limit/spec.md', 'new', 1, 2), /is not part of this diff/)
  await assert.rejects(b.rpc('fileLines', id, 'img.bin', 'new', 1, 2), /is binary/)
})

test('a line outside the hunks can be commented on; the text comes from git and the comment follows the line', async () => {
  git(fx.dir, 'checkout', '-q', '--', 'src/long.ts')
  const out = b.gr(fx.dir, 'comment', '--as', 'user', '--file', 'src/long.ts', '--line', '30', '--expect', 'line 30', '--text', 'Unchanged, but relevant.')
  assert.match(out, /anchored to: "line 30"/)
  const cid = out.match(/comment (\S+) on/)[1]
  const anchor = () => b.json(fx.dir, 'comments').find((c) => c.id === cid)
  assert.deepEqual([anchor().anchor.line, anchor().anchor.outside, anchor().anchor.lineContent, anchor().status], [30, true, 'line 30', 'queued'])
  // still refused: a wrong expectation, a line past the end, a file that did not change
  assert.match(b.try(fx.dir, 'comment', '--file', 'src/long.ts', '--line', '30', '--expect', 'nope', '--text', 'x').err, /does not contain the expected text/)
  assert.match(b.try(fx.dir, 'comment', '--file', 'src/long.ts', '--line', '61', '--text', 'x').err, /has 60 lines on the new side; line 61 does not exist/)
  assert.match(b.try(fx.dir, 'comment', '--file', 'specs/rate-limit/spec.md', '--line', '1', '--text', 'x').err, /is not part of this diff/)
  // two lines inserted above: the comment moves with its line and stays outside the hunks
  write(fx.dir, 'src/long.ts', '// one\n// two\n' + long({ 5: 'line five changed', 50: 'line fifty changed' })); commit(fx.dir, 'header')
  assert.deepEqual([anchor().anchor.line, anchor().anchor.outside, anchor().status], [32, true, 'queued'])
  // the line itself is rewritten: it is now part of a hunk as a removal, and the comment is stale, not moved
  write(fx.dir, 'src/long.ts', '// one\n// two\n' + long({ 5: 'line five changed', 50: 'line fifty changed', 30: 'rewritten' })); commit(fx.dir, 'rewrite 30')
  assert.deepEqual([anchor().status, anchor().anchor.lineContent], ['outdated', 'line 30'])
})

test('hide whitespace: a whitespace-only edit drops out of the view, and nothing stored changes', async () => {
  write(fx.dir, 'src/b.ts', ['export function b() {', '      return 43', '}', ''].join('\n')); commit(fx.dir, 'reindent b')
  const cid = b.gr(fx.dir, 'comment', '--as', 'user', '--file', 'src/b.ts', '--line', '2', '--text', 'Indent?').match(/comment (\S+) on/)[1]
  const plain = await b.rpc('loadSession', id)
  const quiet = await b.rpc('loadSession', id, { ignoreWhitespace: true })
  assert.deepEqual(quiet.view, { ignoreWhitespace: true })
  const lines = (l) => l.files.find((f) => f.path === 'src/b.ts').hunks.flatMap((h) => h.lines)
  assert.equal(lines(plain)[1].text, '      return 43')
  assert.equal(quiet.files.length, plain.files.length, 'same files')
  assert.equal(quiet.signature, plain.signature, 'same surface, different look')
  const again = await b.rpc('loadSession', id)
  assert.equal(again.state.comments.find((c) => c.id === cid).status, 'queued', 'the view orphaned nothing')
  // against HEAD~1 the reindent is the only change: visible normally, gone with -w
  const one = b.json(fx.dir, 'review', 'HEAD')
  assert.equal((await b.rpc('loadSession', one.sessionId)).files.length, 1)
  assert.equal((await b.rpc('loadSession', one.sessionId, { ignoreWhitespace: true })).files.length, 0)
  b.gr(fx.dir, 'review', 'main..feature')
})

test('one commit of the range can be viewed on its own, read-only', async () => {
  const all = await b.rpc('loadSession', id)
  const reindent = all.commits.find((c) => c.subject === 'reindent b')
  const only = await b.rpc('loadSession', id, { commit: reindent.sha })
  assert.deepEqual(only.files.map((f) => f.path), ['src/b.ts'])
  assert.deepEqual([only.view.commit, only.apply.enabled, only.commits.length], [reindent.sha, false, all.commits.length])
  assert.equal(only.signature, all.signature)
  await assert.rejects(b.rpc('loadSession', id, { commit: fx.base }), /is not part of this comparison/)
})

test('the review list knows which reviews are approved, and when an approval went stale', async () => {
  const state = async () => (await b.rpc('listSessions', fx.dir)).find((s) => s.id === id).approved
  assert.equal(await state(), 'no')
  b.gr(fx.dir, 'approve', '--confirmed-by-user')
  assert.equal(await state(), 'yes')
  write(fx.dir, 'src/c.ts', 'export const c = 99\n')
  assert.equal(await state(), 'stale', 'an uncommitted edit')
  git(fx.dir, 'checkout', '-q', '--', 'src/c.ts')
  assert.equal(await state(), 'yes')
  write(fx.dir, 'src/c.ts', 'export const c = 100\n'); commit(fx.dir, 'bump c')
  assert.equal(await state(), 'stale', 'a new commit')
})

test('a single-commit view still carries the spec and plan', async () => {
  const all = await b.rpc('loadSession', id)
  const only = await b.rpc('loadSession', id, { commit: all.commits[0].sha })
  assert.deepEqual(only.artifacts.map((a) => a.path), all.artifacts.map((a) => a.path))
  assert.ok(only.artifacts.length > 0)
})
