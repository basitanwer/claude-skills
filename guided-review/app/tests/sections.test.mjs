// A section's Reviewed mark belongs to the files the reviewer saw. A new walkthrough
// keeps the mark for a section that is still the same files and drops it for an id that
// now names other files.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeBridge, makeFixture } from './helpers.mjs'

let b; let fx; let sid
const annotate = (sections) => {
  const f = path.join(b.home, 'w.json')
  fs.writeFileSync(f, JSON.stringify({ title: 'T', summary: '', sections }))
  return b.gr(fx.dir, 'annotate', '--file', f, '--session', String(sid))
}
const reviewed = async () => (await b.rpc('loadSession', sid)).state.reviewedSections

before(async () => {
  b = await makeBridge(); fx = makeFixture()
  sid = b.json(fx.dir, 'review', 'main..feature').sessionId
})
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('a new walkthrough keeps Reviewed for a section with the same files, not for an id reused for others', async () => {
  annotate([{ id: 'core', name: 'Core', files: ['src/a.ts'] }, { id: 'mods', name: 'Modules', files: ['src/b.ts', 'src/c.ts'] }, { id: 'old', name: 'Old', files: ['src/old.ts'] }])
  await b.rpc('saveUiState', sid, { reviewedSections: ['core', 'mods', 'old'] })
  // core: the same file under a new name; mods: the same files in another order; old: its id now names another file
  annotate([{ id: 'core', name: 'The core change', files: ['src/a.ts'] }, { id: 'mods', name: 'Modules', files: ['src/c.ts', 'src/b.ts'] }, { id: 'old', name: 'Old', files: ['src/moved.ts'] }])
  assert.deepEqual(await reviewed(), ['core', 'mods'])
  // a section that is gone takes its mark with it; one that gains a file is not reviewed any more
  annotate([{ id: 'core', name: 'Core', files: ['src/a.ts', 'src/old.ts'] }])
  assert.deepEqual(await reviewed(), [])
})
