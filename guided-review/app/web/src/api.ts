import type { Api, PushMap } from '@shared/types'

// The whole backend surface: POST /rpc/<channel> with a JSON array of args, plus one
// Server-Sent Events stream scoped to the review on screen.

function authToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    try { sessionStorage.setItem('gr-token', fromUrl) } catch { /* private mode */ }
    return fromUrl
  }
  try { return sessionStorage.getItem('gr-token') || '' } catch { return '' }
}

const TOKEN = authToken()
const withToken = (url: string): string =>
  TOKEN ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : url

async function rpc(channel: string, args: unknown[]): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(withToken('/rpc/' + encodeURIComponent(channel)), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args)
    })
  } catch {
    throw new Error('The review server is not reachable — it stops by itself after 30 idle minutes. In Claude Code run /guided-review --resume (or `gr serve` in a shell) to bring it back, then reload this page.')
  }
  let payload: { value?: unknown; error?: string }
  try { payload = await res.json() } catch { throw new Error(`${channel}: ${res.status} ${res.statusText}`) }
  if (!res.ok || payload.error) throw new Error(payload.error || `${channel}: ${res.status}`)
  return payload.value
}

/** Typed RPC client: `api.loadSession(3)` → POST /rpc/loadSession [3]. */
export const api = new Proxy({} as Api, {
  get: (_t, channel: string) => (...args: unknown[]) => {
    // an omitted optional argument must stay omitted: JSON would turn a trailing
    // `undefined` into `null`, which the server reads as a (bad) value
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
    return rpc(channel, args)
  }
})

type Sub = (msg: never) => void
const subs: Record<string, Set<Sub>> = {}
let source: EventSource | null = null
let scope: number | null | undefined    // undefined = never connected
let onOpen: (() => void) | null = null

/** (Re)connect the push stream for the review on screen; `null` for screens with no
 *  saved review (dashboard, repository page, an unsaved preview). `ui=1` marks this
 *  connection as a browser tab. A no-op when already connected to that review. */
export function connect(sessionId: number | null): void {
  if (source && scope === sessionId) return
  source?.close()
  scope = sessionId
  source = new EventSource(withToken('/events?ui=1' + (sessionId != null ? `&session=${sessionId}` : '')))
  source.onopen = () => onOpen?.()
  source.onmessage = (e) => {
    let parsed: { channel: string; msg: unknown }
    try { parsed = JSON.parse(e.data) } catch { return }
    for (const cb of subs[parsed.channel] ?? []) (cb as (m: unknown) => void)(parsed.msg)
  }
}

/** Called every time the stream (re)opens — events may have been missed before it. */
export function onStreamOpen(cb: () => void): void {
  onOpen = cb
}

export function on<K extends keyof PushMap>(channel: K, cb: (msg: PushMap[K]) => void): () => void {
  const set = (subs[channel] ??= new Set())
  set.add(cb as Sub)
  return () => { set.delete(cb as Sub) }
}
