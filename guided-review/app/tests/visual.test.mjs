// "Visualize this PR": the reviewer asks for the whole change as diagrams, the session
// draws them (`gr visualize`), and the server checks them against git the way it checks
// a walkthrough: paths and lines have to exist, and whether a node is new, changed,
// deleted or untouched is read from the diff, never taken from the session.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { commit, git, makeBridge, makeFixture, write } from './helpers.mjs'

let b; let fx; let sid; let l; let fx2
const S = () => ['--session', String(sid)]
const loaded = () => b.rpc('loadSession', sid)
const visual = async () => (await loaded()).state.visual
/** Store a visual the way a session does; returns { code, out, err }. */
const drawIn = (dir, session, v, ...args) => {
  const file = path.join(b.home, 'visual.json')
  fs.writeFileSync(file, JSON.stringify(v))
  return b.try(dir, 'visualize', '--file', file, ...args, '--session', String(session))
}
const draw = (v, ...args) => drawIn(fx.dir, sid, v, ...args)
/** One view of nodes without edges, stored in another review; returns its nodes by id and what gr printed. */
const nodesIn = async (dir, session, nodes) => {
  const res = drawIn(dir, session, { views: [{ kind: 'calls', nodes, edges: [] }] })
  assert.equal(res.code, 0, res.err)
  const v = (await b.rpc('loadSession', session)).state.visual
  return { out: res.out, by: Object.fromEntries(v.views[0].nodes.map((n) => [n.id, n])) }
}
const node = (v, view, id) => v.views.find((x) => x.id === view).nodes.find((n) => n.id === id)

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
  l = b.listener(fx.dir)
  await l.next((e) => e.type === 'ready')
})
after(async () => { await l?.kill(); b.stop(); for (const f of [fx, fx2]) if (f) fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('the request reaches the session with the command that completes it, and only one waits at a time', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'visualize', text: 'mind the retry path', update: true })
  assert.deepEqual([r.kind, r.status, r.text, r.update], ['visualize', 'pending', 'mind the retry path', false], 'nothing is drawn yet, so it cannot be an update')
  const ev = await l.next((e) => e.type === 'request' && e.id === r.id)
  assert.deepEqual([ev.kind, ev.text, ev.update], ['visualize', 'mind the retry path', false])
  assert.match(ev.do, new RegExp(`gr visualize --file <json> --request ${r.id} --session ${sid}`))
  assert.match(ev.do, /visual-schema\.md/)
  await assert.rejects(b.rpc('requestCreate', sid, { kind: 'visualize' }), /already waiting/)

  const res = draw({
    title: 'How the change fits together',
    summary: 'a() and b() changed.',
    views: [
      { kind: 'calls', title: 'Calls', caption: 'Who calls what.', nodes: [
        // every status below is claimed wrongly on purpose: git decides
        { id: 'a', label: 'a()', at: 'src/a.ts:1-3', status: 'new', group: 'core' },
        { id: 'k', label: 'K', at: 'src/a.ts:4', status: 'new' },
        { id: 'b', label: 'b()', file: 'src/b.ts', line: 1, end: 3, status: 'unchanged' },
        { id: 'old', label: 'gone', file: 'src/old.ts', line: 1, status: 'changed' },
        { id: 'spec', label: 'spec', at: 'specs/rate-limit/spec.md:3', status: 'changed' },
        { id: 'mv', label: 'moved', file: 'src/moveme.ts' },
        { id: 'user', label: 'Caller', sub: 'outside this repository', status: 'changed' }
      ], edges: [
        { from: 'user', to: 'a', label: 'calls' }, { from: 'a', to: 'b', kind: 'new' }, ['a', 'k'], { from: 'a', to: 'old', kind: 'removed' },
        { from: 'a', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'nowhere' }
      ] }
    ]
  }, '--request', r.id)
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, new RegExp(`visual stored: 1 diagram\\(s\\), 7 node\\(s\\) \\(request ${r.id} done\\)`))
  for (const re of [/corrected against git: .*"nowhere" is not a node of this view/, /an edge joins "a" to itself/, /"a" → "b" is given twice/]) assert.match(res.out, re)

  const v = await visual()
  const st = (id) => node(v, 'calls', id).status
  assert.deepEqual(['a', 'k', 'b', 'old', 'spec', 'mv', 'user'].map(st), ['changed', 'unchanged', 'new', 'deleted', 'unchanged', 'changed', 'none'])
  assert.deepEqual(node(v, 'calls', 'a'), { id: 'a', label: 'a()', group: 'core', file: 'src/a.ts', inDiff: true, line: 1, end: 3, status: 'changed' })
  assert.deepEqual(node(v, 'calls', 'spec'), { id: 'spec', label: 'spec', file: 'specs/rate-limit/spec.md', line: 3, status: 'unchanged' }, 'a file outside the diff: known to exist, not something the page can go to')
  assert.equal(node(v, 'calls', 'mv').file, 'src/moved.ts', 'a renamed file is named by its new path')
  assert.equal('line' in node(v, 'calls', 'old'), false, 'a deleted file has no lines on the compare side')
  assert.deepEqual(v.views[0].edges, [
    { from: 'user', to: 'a', label: 'calls', kind: '' }, { from: 'a', to: 'b', kind: 'new' }, { from: 'a', to: 'k', kind: '' }, { from: 'a', to: 'old', kind: 'removed' }
  ], 'a self-loop, a repeated edge and an edge to an unknown node are gone')
  const now = await loaded()
  assert.deepEqual([v.endSha, v.signature, now.visualStale], [fx.head, `${now.diffBase}:${now.signature}`, false])
  assert.equal(now.state.requests.find((x) => x.id === r.id).status, 'done')
})

test('a directory is judged by the changed files inside it', async () => {
  const res = draw({ views: [{ kind: 'components', nodes: [
    { id: 'src', label: 'Source', file: 'src/' }, { id: 'specs', label: 'Specs', file: 'specs' }, { id: 'rl', label: 'Rate limit', file: 'specs/rate-limit/' }
  ], edges: [['specs', 'src', 'describes']] }] })
  assert.equal(res.code, 0, res.err)
  const v = await visual()
  assert.deepEqual([v.views[0].kind, v.views[0].title, v.views[0].id], ['architecture', 'Architecture', 'architecture'])
  assert.deepEqual(v.views[0].nodes, [
    { id: 'src', label: 'Source', file: 'src/', inDiff: true, status: 'changed' },
    { id: 'specs', label: 'Specs', file: 'specs/', status: 'unchanged' },
    { id: 'rl', label: 'Rate limit', file: 'specs/rate-limit/', status: 'unchanged' }
  ])
})

test('what git cannot confirm is removed and reported, and a visual with nothing to show is refused', async () => {
  const res = draw({ views: [
    { kind: 'flow', nodes: [
      { id: 'x', label: 'made up', file: 'src/nope.ts', line: 4 },
      { id: 'y', label: 'too far', at: 'src/a.ts:400' },
      { id: 'z', label: 'outside', file: '../../etc/passwd' },
      { id: 'w', label: 'past the end', at: 'specs/rate-limit/plan.md:99' },
      { id: 'y', label: 'same id again' },
      { label: '' }
    ], edges: [['x', 'y'], ['y', 'z'], ['z', 'w']] },
    { kind: 'sideways', title: 'One box', nodes: [{ id: 'only', label: 'alone' }], edges: [] }
  ] })
  assert.equal(res.code, 0, res.err)
  for (const re of [/src\/nope\.ts, which git does not have on the compare side/, /src\/a\.ts:400 is named, but the file has 7 lines/, /not a path of the repository as git spells it/, /plan\.md:99 is named, but the file has 4 lines/, /two nodes have the id "y"/, /node 6 has no label/, /kind "sideways"/, /"One box" has fewer than two nodes — dropped/]) assert.match(res.out, re)
  const v = await visual()
  assert.equal(v.views.length, 1)
  assert.deepEqual(v.views[0].nodes, [
    { id: 'x', label: 'made up', status: 'none' },
    { id: 'y', label: 'too far', file: 'src/a.ts', inDiff: true, status: 'changed' },
    { id: 'z', label: 'outside', status: 'none' },
    { id: 'w', label: 'past the end', file: 'specs/rate-limit/plan.md', status: 'unchanged' }
  ])

  const before = await visual()
  const bad = draw({ views: [{ kind: 'flow', nodes: [{ id: 'a', label: 'alone' }], edges: [] }] })
  assert.notEqual(bad.code, 0)
  assert.match(bad.err, /no view has two nodes or more/)
  assert.deepEqual(await visual(), before, 'a refused visual leaves the stored one alone')
  assert.match(draw({ views: [] }).err, /at least one view/)
})

test('the diagrams go stale when the code changes, survive a new walkthrough, and can be redrawn as an update', async () => {
  const wt = path.join(b.home, 'wt.json')
  fs.writeFileSync(wt, JSON.stringify({ title: 'T', sections: [{ name: 'All', files: ['src/a.ts'] }] }))
  b.gr(fx.dir, 'annotate', '--file', wt, ...S())
  assert.equal((await visual()).views.length, 1, 'a walkthrough does not replace the diagrams')
  assert.equal((await loaded()).visualStale, false)

  write(fx.dir, 'src/a.ts', ['export function a() {', '  return 3', '}', ''].join('\n'))
  commit(fx.dir, 'a returns 3')
  assert.equal((await loaded()).visualStale, true)
  assert.match(b.gr(fx.dir, 'state', ...S()), /visual: Data flow \(flow, 4 nodes\) · drawn at [0-9a-f]{7} — the code CHANGED since/)

  const r = await b.rpc('requestCreate', sid, { kind: 'visualize', update: true })
  assert.equal(r.update, true)
  const ev = await l.next((e) => e.type === 'request' && e.id === r.id)
  assert.equal(ev.update, true)
  assert.match(ev.do, /an update: the current ones are in gr state --json/)
  // a walkthrough request cannot be finished with a visual, nor the other way round
  const w = await b.rpc('requestCreate', sid, { kind: 'walkthrough' })
  await l.next((e) => e.type === 'request' && e.id === w.id)
  const wrong = draw({ views: [{ kind: 'flow', nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], edges: [['a', 'b']] }] }, '--request', w.id)
  assert.notEqual(wrong.code, 0)
  assert.match(wrong.err, /asks for walkthrough, not for a visual/)
  b.gr(fx.dir, 'fail', w.id, '--text', 'not needed', ...S())

  const ok = draw({ views: [{ kind: 'flow', nodes: [{ id: 'a', label: 'a()', at: 'src/a.ts:1-3' }, { id: 'b', label: 'b()', at: 'src/b.ts:1-3' }], edges: [['a', 'b']] }] }, '--request', r.id)
  assert.equal(ok.code, 0, ok.err)
  const now = await loaded()
  assert.deepEqual([now.visualStale, now.state.visual.views[0].nodes.map((n) => n.status)], [false, ['changed', 'new']])
})

test('a visual can travel in a batch, and a cancelled request refuses it', async () => {
  const r = await b.rpc('requestCreate', sid, { kind: 'visualize' })
  await l.next((e) => e.type === 'request' && e.id === r.id)
  const v = { views: [{ kind: 'calls', nodes: [{ id: 'a', label: 'a()' }, { id: 'c', label: 'c', file: 'src/c.ts' }], edges: [['a', 'c']] }] }
  const res = b.batch(fx.dir, [{ op: 'visualize', visual: v, request: r.id }, { op: 'note', text: 'Drew the calls.' }], ...S())
  assert.equal(res.code, 0, res.err)
  assert.match(res.out, /visual stored: 1 diagram\(s\), 2 node\(s\)/)
  assert.equal((await visual()).views[0].kind, 'calls')

  const r2 = await b.rpc('requestCreate', sid, { kind: 'visualize' })
  await l.next((e) => e.type === 'request' && e.id === r2.id)
  await b.rpc('requestCancel', sid, r2.id)
  const late = draw({ views: [{ kind: 'flow', nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], edges: [] }] }, '--request', r2.id)
  assert.equal(late.code, 130)
  assert.match(late.err, /CANCELLED/)
  assert.equal((await visual()).views[0].kind, 'calls', 'nothing was stored for the cancelled request')
})

test('a status cannot be chosen by how a path is spelled, and only git is asked about a path', async () => {
  fx2 = makeFixture()
  const sid2 = b.json(fx2.dir, 'review', 'main..feature').sessionId
  // uncommitted: the last line of moved.ts goes, plan.md moves out of specs/, and a link leads out of the repository
  write(fx2.dir, 'src/moved.ts', ['export const stay1 = 1', 'export const stay2 = 2', ''].join('\n'))
  fs.mkdirSync(path.join(fx2.dir, 'docs'))
  git(fx2.dir, 'mv', 'specs/rate-limit/plan.md', 'docs/plan.md')
  fs.symlinkSync(b.home, path.join(fx2.dir, 'ext'))
  write(fx2.dir, '.gitignore', 'secret.env\n'); write(fx2.dir, 'secret.env', 'A=1\nB=2\n')
  const { out, by } = await nodesIn(fx2.dir, sid2, [
    { id: 'whole', label: 'whole', at: 'src/moved.ts:1-2' }, { id: 'first', label: 'first', at: 'src/moved.ts:1' }, { id: 'last', label: 'last', at: 'src/moved.ts:2' },
    { id: 'slash', label: 'slash', file: 'src/a.ts/', line: 4 }, { id: 'dot', label: 'dot', file: 'src/./a.ts' }, { id: 'case', label: 'case', file: 'SRC/a.ts' },
    { id: 'root', label: 'root', file: '.' }, { id: 'dotgit', label: 'dotgit', at: '.GIT/config:1' },
    { id: 'link', label: 'link', at: 'ext/index.json:1' }, { id: 'ignored', label: 'ignored', at: 'secret.env:99' },
    { id: 'emptied', label: 'emptied', file: 'specs/rate-limit/' }, { id: 'docs', label: 'docs', file: 'docs' }, { id: 'src', label: 'src', file: 'src' },
    { id: 'far', label: 'far', at: 'src/b.ts:2-90' }, { id: 'back', label: 'back', file: 'src/b.ts', line: 3, end: 1 }, { id: 'odd', label: 'odd', file: 'src/b.ts', line: true }
  ])
  const st = (id) => by[id].status
  assert.deepEqual([st('whole'), st('first'), st('last')], ['changed', 'unchanged', 'changed'], 'a line removed at the end of a range counts for the range')
  assert.deepEqual(by.slash, { id: 'slash', label: 'slash', file: 'src/a.ts', inDiff: true, line: 4, status: 'unchanged' }, 'a changed file stays that file with a slash after it')
  for (const id of ['dot', 'case', 'root', 'dotgit', 'link', 'ignored']) assert.deepEqual(by[id], { id, label: id, status: 'none' }, `${id}: not a path git has, so no path is kept`)
  assert.doesNotMatch(out, /the file has \d+ lines[^\n]*(ext|secret|GIT)|(ext|secret|GIT)[^\n]*the file has \d+ lines/, 'nothing outside git was opened to count its lines')
  assert.deepEqual([by.emptied, by.docs, by.src.status], [
    { id: 'emptied', label: 'emptied', file: 'specs/rate-limit/', status: 'changed' },
    { id: 'docs', label: 'docs', file: 'docs/', inDiff: true, status: 'new' }, 'changed'
  ], 'a directory a file was moved out of is changed, though nothing in it is in the diff')
  assert.deepEqual([[by.far.line, by.far.end], [by.back.line, by.back.end], by.odd.line], [[2, 3], [3, undefined], undefined])
  for (const re of [/src\/b\.ts:2-90: the file has 3 lines — the range was cut to 2-3/, /src\/b\.ts:3: the range ends at 1, before it starts/, /src\/b\.ts:\? is named/]) assert.match(out, re)

  // the same questions asked of two fixed commits, where there is no working tree to look at
  const sid3 = b.json(fx2.dir, 'review', `${fx2.base}..${fx2.head}`).sessionId
  const frozen = await nodesIn(fx2.dir, sid3, [
    { id: 'a', label: 'a', at: 'src/a.ts:1-3' }, { id: 'spec', label: 'spec', at: 'specs/rate-limit/spec.md:3' }, { id: 'plan', label: 'plan', at: 'specs/rate-limit/plan.md:99' },
    { id: 'specs', label: 'specs', file: 'specs/' }, { id: 'src', label: 'src', file: 'src/' }, { id: 'old', label: 'old', file: 'src/old.ts' },
    { id: 'slash', label: 'slash', file: 'src/a.ts/' }, { id: 'docs', label: 'docs', file: 'docs/' }
  ])
  assert.deepEqual(Object.values(frozen.by).map((n) => [n.id, n.status, n.file]), [
    ['a', 'changed', 'src/a.ts'], ['spec', 'unchanged', 'specs/rate-limit/spec.md'], ['plan', 'unchanged', 'specs/rate-limit/plan.md'],
    ['specs', 'unchanged', 'specs/'], ['src', 'changed', 'src/'], ['old', 'deleted', 'src/old.ts'], ['slash', 'changed', 'src/a.ts'], ['docs', 'none', undefined]
  ])
  assert.match(frozen.out, /plan\.md:99 is named, but the file has 4 lines/)
  assert.equal((await b.rpc('loadSession', sid3)).visualStale, false, 'two fixed commits never change')

  // a base branch that moves changes the diff, and so what every box should say
  assert.equal((await b.rpc('loadSession', sid2)).visualStale, false)
  git(fx2.dir, 'branch', '-f', 'main', fx2.firstFeature)
  assert.equal((await b.rpc('loadSession', sid2)).visualStale, true)
})

test('odd input is bounded or refused, and a visualize request is not finished by a walkthrough', async () => {
  const long = 'x'.repeat(5000)
  const res = draw({ views: [
    { kind: 'constructor', id: long, title: 'Odd', nodes: [{ label: 'first' }, { id: 'n1', label: 'second' }, { id: long, label: long, sub: long, group: long }, { label: { toString: 1 } }], edges: [[long, 'n1', long]] },
    { kind: '__proto__', nodes: Array.from({ length: 60 }, (_, i) => ({ label: i < 30 ? '' : `node ${i}` })), edges: Array.from({ length: 500 }, () => ['nope', 'nope']) }
  ] })
  assert.equal(res.code, 0, res.err)
  const v = await visual()
  assert.deepEqual(v.views.map((x) => [x.kind, x.id.length, x.nodes.length, x.edges.length]), [['architecture', 80, 3, 1], ['architecture', 12, 30, 0]])
  assert.deepEqual(v.views[0].nodes.map((n) => [n.id.length, n.label.length, n.sub?.length, n.group?.length]), [[2, 5, undefined, undefined], [2, 6, undefined, undefined], [80, 60, 90, 40]])
  assert.deepEqual(v.views[0].nodes.slice(0, 2).map((n) => n.id), ['n2', 'n1'], 'an id made up for a node never takes one the session chose')
  assert.deepEqual([v.views[0].edges[0].from.length, v.views[0].edges[0].label.length], [80, 40])
  assert.ok(res.out.split('\n').length < 60, 'the corrections are summed up, not listed five hundred times')
  assert.match(res.out, /…and \d+ more correction\(s\) of the same kinds/)
  assert.ok(fs.statSync(path.join(b.home, 'sessions', `${sid}.json`)).size < 200_000)

  const r = await b.rpc('requestCreate', sid, { kind: 'visualize' })
  await l.next((e) => e.type === 'request' && e.id === r.id)
  const wt = path.join(b.home, 'wt.json')
  const wrong = b.try(fx.dir, 'annotate', '--file', wt, '--request', r.id, ...S())
  assert.notEqual(wrong.code, 0)
  assert.match(wrong.err, /asks for a visual, not for a walkthrough/)
  assert.equal((await loaded()).state.requests.find((x) => x.id === r.id).status, 'running')
  b.gr(fx.dir, 'fail', r.id, '--text', 'done testing', ...S())
})
