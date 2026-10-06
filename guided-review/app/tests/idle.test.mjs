// The server stops by itself when nothing is connected and nothing has called it for
// the idle period (30 minutes by default; shortened here), and comes back on demand.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { makeBridge, makeFixture, sleep, until } from './helpers.mjs'

let b; let fx
const running = () => /^running:/.test(b.gr(b.home, 'status'))
// `gr status` only probes; the probe itself is a request, so poll the process instead
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
before(async () => { b = await makeBridge({ GUIDED_REVIEW_IDLE_MINUTES: '0.03' }); fx = makeFixture() }) // 1.8 s
after(() => { b.stop(); fs.rmSync(fx.root, { recursive: true, force: true }); fs.rmSync(b.home, { recursive: true, force: true }) })

test('an open tab keeps it running; with nothing connected it stops after the idle period; gr restarts it', async () => {
  const id = b.json(fx.dir, 'review', 'main..feature').sessionId
  const pid = (await b.rpc('info')).pid
  const tab = await b.listen(id)
  await sleep(3500)
  assert.equal(alive(pid), true, 'a connected tab counts as in use')
  tab.close()
  await until(() => !alive(pid), 6000)
  assert.equal(running(), false)
  const again = b.json(fx.dir, 'review', '--resume')
  assert.equal(again.sessionId, id, 'started again on demand, with the review intact')
  assert.notEqual((await b.rpc('info')).pid, pid)
})
