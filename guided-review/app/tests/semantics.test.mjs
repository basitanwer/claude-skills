// What each /guided-review argument compares, and the git edge cases: root and merge
// commits, renames, deletions, binaries, mode-only changes, files without a trailing
// newline, empty diffs, tags and relative refs, and the working tree (staged,
// unstaged, untracked; on a branch or with a detached HEAD).
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commit, git, makeBridge, makeFixture, sleep, until, write } from './helpers.mjs'

let b; let fx
const walkthrough = (name, sections) => {
  const file = path.join(b.home, name)
  fs.writeFileSync(file, JSON.stringify({ title: name, summary: '', sections }))
  return file
}
before(async () => { b = await makeBridge(); fx = makeFixture() })
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('single commit: HEAD is that commit against its parent, both frozen', () => {
  const info = b.json(fx.dir, 'review', 'HEAD')
  assert.deepEqual([info.base.kind, info.compare.kind], ['commit', 'commit'])
  assert.equal(info.compare.sha, fx.head)
  assert.equal(info.base.sha, git(fx.dir, 'rev-parse', 'HEAD^'))
  assert.deepEqual([info.files, info.commits], [1, 1])
  assert.match(info.notes.join('\n'), /single commit HEAD \(\w{7}\) against its parent \w{7}; both sides are frozen/)
  assert.match(b.gr(fx.dir, 'diff'), /## src\/c\.ts \(added, \+1 −0\)/)
})

test('single commit by abbreviated SHA is the same review as HEAD', () => {
  assert.equal(b.json(fx.dir, 'review', fx.head.slice(0, 9)).sessionId, b.json(fx.dir, 'review', 'HEAD').sessionId, 'identity is the commit, not how it was spelled')
  const older = b.json(fx.dir, 'review', fx.firstFeature)
  assert.equal(older.files, 7)
  assert.deepEqual(older.flags.sort(), ['1 added', '1 binary', '1 deleted', '1 mode-only', '1 renamed'])
})

test('root commit: compared against the empty tree, every file added', () => {
  const info = b.json(fx.dir, 'review', fx.base)
  assert.match(info.notes.join('\n'), /ROOT commit: compared against the empty tree/)
  assert.deepEqual([info.base.kind, info.base.sha], ['empty', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'])
  assert.deepEqual([info.files, info.commits], [8, 1])
  const stat = b.gr(fx.dir, 'diff', '--stat')
  assert.match(stat, /## src\/a\.ts \(added, \+6 −0\)/)
  assert.match(stat, /## img\.bin \(added, \+0 −0, binary\)/)
  // and it is a working review: comments anchor, a walkthrough covers it
  assert.match(b.gr(fx.dir, 'comment', '--file', 'src/a.ts', '--line', '2', '--text', 'first version'), /anchored to: "  return 1"/)
  assert.match(b.gr(fx.dir, 'annotate', '--file', walkthrough('root.json', [{ name: 'Sources', files: ['src/a.ts', 'src/old.ts', 'src/moveme.ts'] }])), /walkthrough stored: 2 section\(s\)/)
})

test('ranges: tags and relative refs; A..B is what B adds since it left A; --direct compares the endpoints', () => {
  const rel = b.json(fx.dir, 'review', 'HEAD~2..HEAD')
  assert.deepEqual([rel.files, rel.commits, rel.base.kind, rel.compare.kind], [2, 2, 'commit', 'commit'])
  const tag = b.json(fx.dir, 'review', 'v0..feature')
  assert.deepEqual([tag.base.kind, tag.compare.kind, tag.files], ['commit', 'branch', 8])
  // diverged sides: main gains a commit that feature does not have
  git(fx.dir, 'checkout', '-q', 'main')
  write(fx.dir, 'README.md', 'main only\n'); commit(fx.dir, 'main moves on')
  git(fx.dir, 'checkout', '-q', 'feature')
  const div = b.json(fx.dir, 'review', 'main..feature')
  assert.equal(div.files, 8, 'the main-only README.md is not part of what feature adds')
  assert.match(div.notes.join('\n'), /main is not an ancestor of feature: the review shows what feature adds since they diverged \(merge-base \w{7}\), like "git diff main\.\.\.feature"\. Add --direct/)
  assert.doesNotMatch(b.gr(fx.dir, 'diff', '--stat'), /README\.md/)
  assert.equal(b.json(fx.dir, 'review', 'main...feature').sessionId, div.sessionId, 'three dots mean the same thing')
  const direct = b.json(fx.dir, 'review', 'main..feature', '--direct')
  assert.notEqual(direct.sessionId, div.sessionId)
  assert.equal(direct.files, 9)
  assert.match(direct.notes.join('\n'), /--direct: the two endpoints main and feature are compared as they are/)
  assert.match(b.gr(fx.dir, 'diff', '--stat'), /## README\.md \(deleted, \+0 −1\)/, 'main-only changes show up reversed in a direct diff')
})

test('a bare branch name is a branch review against the default branch', () => {
  const info = b.json(fx.dir, 'review', 'feature')
  assert.deepEqual([info.base.ref, info.compare.ref, info.compare.kind], ['main', 'feature', 'branch'])
  assert.equal(info.sessionId, b.json(fx.dir, 'review', 'main..feature').sessionId)
  assert.deepEqual(b.json(fx.dir, 'review', 'feature', '--base', 'v0').base.kind, 'commit')
})

test('renames, deletions, binaries, mode-only changes and missing trailing newlines are all shown', () => {
  b.gr(fx.dir, 'review', 'main..feature')
  const diff = b.gr(fx.dir, 'diff')
  assert.match(diff, /## src\/moved\.ts \(renamed from src\/moveme\.ts, \+0 −0\)\n\s+\(no line changes\)/)
  assert.match(diff, /## src\/old\.ts \(deleted, \+0 −1\)/)
  assert.match(diff, /-\s+1\s+export const gone = true/)
  assert.match(diff, /## img\.bin \(modified, \+0 −0, binary\)\n\s+\(binary — no line diff; comment on the file\)/)
  assert.match(diff, /## run\.sh \(modified, \+0 −0, mode 100644 → 100755\)\n\s+\(no line changes\)/)
  assert.match(diff, /## noeol\.txt \(modified, \+1 −1\)\n@@ -1 \+1 @@\n-\s+1\s+no newline at end\n\+\s+1\s+still no newline at end\n/)
  assert.doesNotMatch(diff, /No newline at end of file/, 'git\'s marker is not mistaken for content')
  assert.match(b.gr(fx.dir, 'comment', '--file', 'noeol.txt', '--line', '1', '--text', 'x'), /anchored to: "still no newline at end"/)
  // a renamed file can be addressed by either name; a removed line by its old number
  assert.match(b.gr(fx.dir, 'comment', '--file', 'src/moveme.ts', '--text', 'Renamed.'), /on src\/moved\.ts/)
  assert.match(b.gr(fx.dir, 'comment', '--file', 'src/old.ts', '--side', 'old', '--line', '1', '--text', 'Why removed?'), /on src\/old\.ts:1 \(old\) — anchored to: "export const gone = true"/)
  assert.match(b.gr(fx.dir, 'comment', '--file', 'run.sh', '--text', 'Now executable.'), /on run\.sh/)
})

test('merge commit: shown against its first parent, and says so', () => {
  git(fx.dir, 'checkout', '-q', 'main')
  git(fx.dir, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
  const merge = git(fx.dir, 'rev-parse', 'HEAD')
  const info = b.json(fx.dir, 'review', merge)
  assert.match(info.notes.join('\n'), /MERGE commit with 2 parents: shown against its first parent \w{7}.*Combined \(--cc\) diffs are not supported/)
  assert.equal(info.base.sha, git(fx.dir, 'rev-parse', `${merge}^1`))
  assert.equal(info.files, 8, 'everything the merge brought into main')
  git(fx.dir, 'checkout', '-q', 'feature')
})

test('empty diff: reported, and no session is created', () => {
  const before = b.json(fx.dir, 'sessions').length
  assert.match(b.gr(fx.dir, 'review', 'HEAD..HEAD'), /EMPTY DIFF: .* has no changes\. Nothing to review; no session was created\./)
  assert.match(b.gr(fx.dir, 'review', 'feature..feature'), /EMPTY DIFF: feature → feature has no changes/)
  assert.equal(b.json(fx.dir, 'sessions').length, before)
})

test('working tree: clean is an empty diff; dirty shows staged, unstaged and untracked', () => {
  assert.match(b.gr(fx.dir, 'review', '--working-tree'), /EMPTY DIFF: .*\(the working tree is clean\)/)
  const head = git(fx.dir, 'rev-parse', 'HEAD')
  write(fx.dir, 'src/b.ts', ['export function b() {', '  return 44', '}', ''].join('\n'))
  git(fx.dir, 'add', 'src/b.ts')                                         // staged
  write(fx.dir, 'src/c.ts', 'export const c = 3\nexport const d = 4\n')   // unstaged
  write(fx.dir, 'notes with space.txt', 'scratch\n')                      // untracked, space in its name
  const info = b.json(fx.dir, 'review', '--working-tree')
  assert.deepEqual([info.base.kind, info.base.sha, info.compare.kind, info.compare.ref], ['commit', head, 'branch', 'feature'])
  assert.deepEqual([info.dirty, info.files, info.flags], [true, 3, ['1 untracked']])
  assert.match(info.notes.join('\n'), /feature's uncommitted changes \(staged \+ unstaged \+ untracked\) against HEAD/)
  const diff = b.gr(fx.dir, 'diff')
  assert.match(diff, /-\s+2\s+return 43\s+«staged»/)
  assert.match(diff, /\+\s+2\s+return 44\s+«staged»/)
  assert.match(diff, /\+\s+2\s+export const d = 4\s+«unstaged»/)
  assert.match(diff, /## notes with space\.txt \(added, \+1 −0, untracked\)\n@@ -0,0 \+1,1 @@\n\+\s+1\s+scratch\s+«unstaged»/)
  // comments and a walkthrough work on uncommitted lines; an untracked file nobody
  // placed stays out of the walkthrough and is marked excluded
  assert.match(b.gr(fx.dir, 'comment', '--file', 'src/b.ts', '--line', '2', '--text', 'Why 44?'), /anchored to: "  return 44"/)
  assert.match(b.gr(fx.dir, 'comment', '--file', 'notes with space.txt', '--line', '1', '--text', 'Scratch file?'), /anchored to: "scratch"/)
  assert.match(b.gr(fx.dir, 'annotate', '--file', walkthrough('wt.json', [{ name: 'B', files: ['src/b.ts'] }])), /1 changed file\(s\) were not placed in a section.*src\/c\.ts/)
  assert.deepEqual(b.json(fx.dir, 'state').state.walkthrough.sections.flatMap((s) => s.files), ['src/b.ts', 'src/c.ts'])
  assert.match(b.gr(fx.dir, 'diff', '--stat'), /## notes with space\.txt \(added, \+1 −0, untracked, excluded from the review\)/)
  assert.equal(git(fx.dir, 'rev-parse', 'HEAD'), head, 'reviewing changed nothing')
  assert.match(git(fx.dir, 'status', '--porcelain'), /^M  src\/b\.ts\n M src\/c\.ts\n\?\? "?notes with space\.txt"?$/)
})

test('working tree with --base: commits plus uncommitted changes since a ref', () => {
  const info = b.json(fx.dir, 'review', '--working-tree', '--base', 'HEAD~1')
  assert.deepEqual([info.files, info.commits], [3, 1])
  const diff = b.gr(fx.dir, 'diff', '--file', 'src/c.ts')
  assert.match(diff, /\+\s+1\s+export const c = 3\n/, 'the committed line carries no uncommitted label')
  assert.match(diff, /\+\s+2\s+export const d = 4\s+«unstaged»/)
})

test('working tree with a detached HEAD is reviewable too', () => {
  const onBranch = b.json(fx.dir, 'review', '--working-tree').sessionId
  git(fx.dir, 'checkout', '-q', '--detach')
  const info = b.json(fx.dir, 'review', '--working-tree')
  assert.deepEqual([info.compare.kind, info.dirty, info.files], ['worktree', true, 3])
  assert.notEqual(info.sessionId, onBranch, 'a detached working tree is its own review')
  assert.match(info.notes.join('\n'), /working tree with a detached HEAD/)
  const diff = b.gr(fx.dir, 'diff')
  assert.match(diff, /\+\s+2\s+return 44\s+«staged»/)
  assert.match(diff, /\+\s+2\s+export const d = 4\s+«unstaged»/)
  assert.equal(b.json(fx.dir, 'review', 'HEAD').compare.kind, 'commit', 'commits are reviewable while detached')
  git(fx.dir, 'checkout', '-q', 'feature')
})

test('two reviews open at once both hear about a change (one watcher per open review)', async () => {
  const a = b.json(fx.dir, 'review', 'main..feature').sessionId
  const v = b.json(fx.dir, 'review', 'v0..feature').sessionId
  const [la, lv] = [await b.listen(a), await b.listen(v)]
  await sleep(2500) // let the watcher take its first fingerprint of both
  const next = commit(fx.dir, 'commit the working tree')
  const changed = (l, id) => l.events.find((e) => e.channel === 'repo:changed' && e.msg.sessionId === id && e.msg.headSha === next)
  await until(() => changed(la, a) && changed(lv, v), 10_000)
  assert.equal(changed(la, a).msg.dirty, false)
  assert.equal(la.events.some((e) => e.msg.sessionId === v), false, 'a tab only hears about its own review')
  // an uncommitted edit is a change as well
  fs.appendFileSync(path.join(fx.dir, 'src/c.ts'), 'export const e = 5\n')
  await until(() => la.events.some((e) => e.channel === 'repo:changed' && e.msg.dirty) && lv.events.some((e) => e.channel === 'repo:changed' && e.msg.dirty), 10_000)
  la.close(); lv.close()
  git(fx.dir, 'checkout', '--', 'src/c.ts')
})

test('gr wait --on-change returns when the code under review changes', async () => {
  const id = b.json(fx.dir, 'review', 'main..feature').sessionId
  b.gr(fx.dir, 'annotate', '--file', walkthrough('onchange.json', [{ name: 'All', files: ['src/a.ts'] }]))
  const w = b.start(fx.dir, 'wait', '--on-change', '--timeout', '30', '--session', String(id))
  await until(async () => (await b.rpc('loadSession', id)).presence === 'listening')
  await sleep(2500)
  write(fx.dir, 'src/c.ts', 'export const c = 30\n'); commit(fx.dir, 'c is 30')
  const res = await w.done
  assert.equal(res.code, 0)
  assert.match(res.out, /the code under review changed: 1 new commit\(s\), 1 file\(s\) \+1 −2 since \w{7} — see: gr drift/)
  // without --on-change the same change does not end the wait; it times out quietly
  const quiet = b.start(fx.dir, 'wait', '--timeout', '4', '--session', String(id))
  await sleep(1500)
  write(fx.dir, 'src/c.ts', 'export const c = 31\n'); commit(fx.dir, 'c is 31')
  assert.match((await quiet.done).out, /no requests/)
})

test('bad input is rejected with a reason', () => {
  b.gr(fx.dir, 'review', 'HEAD')
  for (const [args, re] of [
    [['review', 'no-such-ref'], /not a branch or commit: no-such-ref/],
    [['review', '--upload-pack=x..HEAD'], /unknown option --upload-pack/],
    [['review', '-x..HEAD'], /invalid ref/],
    [['review'], /what should be reviewed\?/],
    [['review', '--resume', '--session', '9999'], /review #9999 not found/],
    [['focus', '--file', 'src/c.ts', '--line', '9999'], /has \d+ lines? on the new side; line 9999 does not exist/],
    [['tour', '--stop', 'src/c.ts:1'], /a tour needs 2–8 stops/],
    [['comment', '--text', 'nowhere'], /where\?/],
    [['resolve', 'c1', '--verdict', 'maybe', '--note', 'x'], /usage: gr resolve/],
    [['frobnicate'], /unknown command: frobnicate/]
  ]) {
    const r = b.try(fx.dir, ...args)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.err, re, args.join(' '))
  }
  const outside = b.try(path.dirname(fx.root), 'review', 'HEAD')
  assert.equal(outside.code, 1); assert.match(outside.err, /is not inside a git repository/)
})
