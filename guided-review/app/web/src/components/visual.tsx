import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import type { LoadedReview, VisualEdge, VisualKind, VisualNode, VisualStatus, VisualView } from '@shared/types'
import { useStore } from '../store'
import { focusAnchor, focusLines } from '../focus'
import { layout } from '../graph'
import { ago, baseName, cssq, isOpen, plural, secStyle, short } from '../util'
import { AwayHint, Icon, Md } from './common'

// ── what a box says ───────────────────────────────────────────
const STATUS: Record<VisualStatus, { label: string; mark: string; title: string }> = {
  new: { label: 'New', mark: '+', title: 'Added by this change' },
  changed: { label: 'Changed', mark: '±', title: 'Changed by this change' },
  deleted: { label: 'Deleted', mark: '−', title: 'Removed by this change' },
  unchanged: { label: 'Not changed', mark: '', title: 'Part of the repository; this change does not touch it' },
  none: { label: 'Not code', mark: '', title: 'Names no code of this repository' }
}
const KIND: Record<VisualKind, string> = { architecture: 'Architecture', flow: 'Data flow', calls: 'Function calls' }
/** Where a node's code is, as text. */
const placeOf = (n: VisualNode, full = true): string =>
  !n.file ? '' : `${full || n.file.endsWith('/') ? n.file : baseName(n.file)}${n.line != null ? `:${n.line}${n.end != null ? `–${n.end}` : ''}` : ''}`

/** What clicking a box does: go to its code, when that code is part of the diff as the
 *  page has it now (the diagrams may be older than the code). */
function goTo(n: VisualNode, loaded: LoadedReview): (() => void) | null {
  if (!n.file || !n.inDiff) return null
  const dir = n.file.endsWith('/')
  const f = dir ? loaded.files.find((x) => !x.excluded && x.path.startsWith(n.file!)) : loaded.files.find((x) => x.path === n.file)
  if (!f) return null
  if (dir || n.line == null || f.status === 'deleted' || f.binary) return () => focusAnchor({ kind: 'file', file: f.path }, { top: true })
  const { line } = n
  return () => focusLines(f.path, line, n.end ?? line)
}

// ── text in an SVG has to be measured to be boxed ─────────────
const LABEL = { size: 13, weight: 600 }
const SUB = { size: 11, weight: 400 }
const EDGE = { size: 11, weight: 400 }
const NODE_MAX = 300
let pen: CanvasRenderingContext2D | null | undefined
function textWidth(text: string, f: { size: number; weight: number }): number {
  if (pen === undefined) pen = document.createElement('canvas').getContext('2d')
  if (!pen) return text.length * f.size * 0.58
  pen.font = `${f.weight} ${f.size}px ${getComputedStyle(document.body).fontFamily}`
  return pen.measureText(text).width
}
/** `text`, cut with an ellipsis if it is wider than `max`. */
function fit(text: string, f: { size: number; weight: number }, max: number): string {
  if (textWidth(text, f) <= max) return text
  let cut = text
  while (cut.length > 1 && textWidth(`${cut}…`, f) > max) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}
/** `text` on at most two lines no wider than `max`, broken between words; what does not fit is cut. */
function wrap(text: string, f: { size: number; weight: number }, max: number): string[] {
  if (!text || textWidth(text, f) <= max) return text ? [text] : []
  const words = text.split(' ')
  let first = ''
  let k = 0
  for (; k < words.length; k++) {
    const next = first ? `${first} ${words[k]}` : words[k]
    if (textWidth(next, f) > max) break
    first = next
  }
  // a first word too long for the line: no clean break, so one cut line
  if (!first) return [fit(text, f, max)]
  return [first, fit(words.slice(k).join(' '), f, max)]
}

interface Drawn { node: VisualNode; label: string; sub: string[]; w: number; h: number; mark: string }
function drawn(n: VisualNode): Drawn {
  const mark = STATUS[n.status].mark
  // the bar of its group on the left, the status mark on the right
  const room = NODE_MAX - 14 - 12 - (mark ? 16 : 0)
  const label = fit(n.label, LABEL, room)
  const sub = wrap(n.sub || placeOf(n, false), SUB, room)
  const w = Math.max(96, Math.ceil(Math.max(textWidth(label, LABEL), ...sub.map((l) => textWidth(l, SUB)))) + 14 + 12 + (mark ? 16 : 0))
  return { node: n, label, sub, w, h: 32 + sub.length * 14, mark }
}

/** The code a box stands for, as the diff has it: the lines of its range that the diff shows
 *  (added, removed, and the unchanged ones around them). Empty when the box names no lines,
 *  or its lines are outside what the diff shows. */
const PREVIEW = 12
function codeOf(n: VisualNode, loaded: LoadedReview): { lines: { sign: string; no: number | null; text: string }[]; more: number } {
  if (!n.file || !n.inDiff || n.line == null) return { lines: [], more: 0 }
  const f = loaded.files.find((x) => x.path === n.file)
  if (!f || f.binary) return { lines: [], more: 0 }
  const start = n.line; const end = n.end ?? n.line
  const out: { sign: string; no: number | null; text: string }[] = []
  for (const h of f.hunks) {
    let last = Number(/\+(\d+)/.exec(h.range)?.[1] ?? 1) - 1
    for (const l of h.lines) {
      if (l.new != null) { last = l.new; if (l.new >= start && l.new <= end) out.push({ sign: l.kind === 'add' ? '+' : ' ', no: l.new, text: l.text }) }
      else if (l.kind === 'del' && last >= start - 1 && last < end) out.push({ sign: '−', no: null, text: l.text })
    }
  }
  return { lines: out.slice(0, PREVIEW), more: Math.max(0, out.length - PREVIEW) }
}

/** What the reviewer sees when they point at a box: everything the box could not hold. Its
 *  full name and line, what it does (the session's note), what it is connected to, and its
 *  code as the diff has it. Nothing in it is clicked: a click on the box itself goes to the code. */
function NodeCard({ node, view, loaded, at, link }: { node: VisualNode; view: VisualView; loaded: LoadedReview; at: DOMRect; link: boolean }) {
  const name = (id: string): string => view.nodes.find((n) => n.id === id)?.label ?? id
  const into = view.edges.filter((e) => e.to === node.id)
  const outOf = view.edges.filter((e) => e.from === node.id)
  const code = useMemo(() => codeOf(node, loaded), [node, loaded])
  const vw = window.innerWidth; const vh = window.innerHeight
  const W = Math.min(440, vw - 16)
  // Beside the box when there is room, so that the boxes above and below it, which are
  // usually the ones it connects to, stay in view; else under it, else above it.
  const side = vw - at.right >= W + 20 ? at.right + 12 : at.left >= W + 20 ? at.left - W - 12 : null
  const upper = at.top < vh / 2
  const where = side != null
    ? { left: side, ...(upper ? { top: Math.max(8, at.top), maxHeight: vh - Math.max(8, at.top) - 8 } : { bottom: Math.max(8, vh - at.bottom), maxHeight: at.bottom - 8 }) }
    : { left: Math.max(8, Math.min(at.left, vw - W - 8)), ...(upper ? { top: at.bottom + 8, maxHeight: vh - at.bottom - 16 } : { bottom: vh - at.top + 8, maxHeight: at.top - 16 }) }
  return (
    <div className="viz-card" id="gr-viz-card" role="tooltip" data-gr="visual-card" style={{ width: W, ...where }}>
      <div className="viz-card-head">
        <strong>{node.label}</strong>
        <span className={'label viz-status ' + node.status}>{STATUS[node.status].label}</span>
        {node.group && <span className="muted small">{node.group}</span>}
      </div>
      {node.file && <div className="mono small viz-card-place">{placeOf(node)}</div>}
      {node.sub && <div className="viz-card-sub">{node.sub}</div>}
      {node.note && <Md text={node.note} className="viz-card-note" />}
      {(into.length > 0 || outOf.length > 0) && (
        <ul className="viz-card-links small">
          {into.map((e, i) => <li key={'i' + i}><span className="muted">from</span> {name(e.from)}{e.label && <span className="muted"> · {e.label}</span>}</li>)}
          {outOf.map((e, i) => <li key={'o' + i}><span className="muted">to</span> {name(e.to)}{e.label && <span className="muted"> · {e.label}</span>}</li>)}
        </ul>
      )}
      {code.lines.length > 0 && (
        <pre className="viz-card-code" data-gr="visual-code">
          {code.lines.map((l, i) => <span key={i} className={l.sign === '+' ? 'add' : l.sign === '−' ? 'del' : ''}>{l.sign} {l.text || ' '}{'\n'}</span>)}
          {code.more > 0 && <span className="more">… {plural(code.more, 'more line')}</span>}
        </pre>
      )}
      <div className="muted small">{link ? 'Click the box to go to this code.' : node.file ? (node.inDiff ? 'This code is no longer in the comparison.' : 'This change does not touch it, so the page cannot open it.') : 'Not code of this repository.'}</div>
    </div>
  )
}

// ── one diagram ───────────────────────────────────────────────
function Graph({ view, loaded }: { view: VisualView; loaded: LoadedReview }) {
  // the box under the pointer or the keyboard, and where it is on the screen
  const [hover, setHover] = useState<{ id: string; at: DOMRect } | null>(null)
  // the box last picked: kept in the store, so it is still outlined on the way back from its
  // code. Only outlined: it does not hold the diagram dimmed, and the next box pointed at takes over
  const pinned = useStore((s) => s.visualNode)
  const pin = (id: string | null): void => useStore.getState().set({ visualNode: id })
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  // how wide the drawing may be: the layout breaks a wider layer into rows
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const el = canvas.current
    if (!el) return
    // (less the canvas's own padding and the margin the layout draws round the boxes)
    const measure = (): void => setRoom(Math.max(280, Math.floor(el.clientWidth) - 16 - 32))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const groups = useMemo(() => [...new Set(view.nodes.map((n) => n.group).filter((g): g is string => Boolean(g)))], [view])
  const items = useMemo(() => view.nodes.map(drawn), [view])
  const lay = useMemo(() => {
    const widths = new Map(view.edges.map((e) => [e, e.label ? textWidth(e.label, EDGE) + 8 : 0]))
    return { ...layout(items.map((d) => ({ id: d.node.id, w: d.w, h: d.h })), view.edges, view.edges.some((e) => e.label) ? 76 : 52, (e) => widths.get(e) ?? 0, room), widths }
  }, [items, view, room])
  const links = useMemo(() => new Map(view.nodes.map((n) => [n.id, goTo(n, loaded)])), [view, loaded])
  const cur = view.nodes.find((n) => n.id === hover?.id) ?? null
  const near = useMemo(() => {
    if (!cur) return null
    const ids = new Set([cur.id])
    for (const e of view.edges) { if (e.from === cur.id) ids.add(e.to); if (e.to === cur.id) ids.add(e.from) }
    return ids
  }, [cur, view])
  // back from the code: the keyboard is where it was, on the box that was picked. That focus
  // is the page's doing, not the reviewer pointing at the box, so it lights nothing up
  const restoring = useRef(false)
  useEffect(() => {
    const id = useStore.getState().visualNode
    const el = id ? root.current?.querySelector<SVGGElement>(`[data-gr-node="${cssq(id)}"]`) : null
    if (el) { restoring.current = true; el.focus({ preventScroll: true }); restoring.current = false }
  }, [])
  // the card is placed on the screen, so it goes when the page scrolls under it
  useEffect(() => {
    if (!hover) return
    const off = (): void => setHover(null)
    window.addEventListener('scroll', off, { passive: true, capture: true })
    return () => window.removeEventListener('scroll', off, { capture: true })
  }, [hover])
  const touches = (e: VisualEdge): boolean => Boolean(cur) && (e.from === cur?.id || e.to === cur?.id)
  const act = (n: VisualNode): void => {
    const run = links.get(n.id)
    if (run) { pin(n.id); setHover(null); run() }
  }
  const point = (n: VisualNode, el: Element): void => {
    if (restoring.current) return
    if (pinned && pinned !== n.id) pin(null)
    setHover({ id: n.id, at: el.getBoundingClientRect() })
  }
  const onKey = (e: RKeyboardEvent, n: VisualNode): void => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(n) } else if (e.key === 'Escape') setHover(null) }
  const said = (n: VisualNode): string => [n.label, STATUS[n.status].label.toLowerCase(), placeOf(n), n.sub, n.note].filter(Boolean).join(', ')
  return (
    <div className="viz" ref={root} data-gr="visual-view" data-gr-view={view.id} data-gr-view-kind={view.kind} onMouseLeave={() => setHover(null)}>
      <div className="viz-legend small" aria-label="Legend">
        {(['new', 'changed', 'deleted', 'unchanged', 'none'] as const).filter((s) => view.nodes.some((n) => n.status === s)).map((s) => (
          <span key={s} className="viz-key" title={STATUS[s].title}><span className={'viz-swatch ' + s} aria-hidden="true">{STATUS[s].mark}</span>{STATUS[s].label}</span>
        ))}
        {view.edges.some((e) => e.kind === 'new') && <span className="viz-key" title="Claude Code's reading of the change, not something git can confirm"><span className="viz-line new" aria-hidden="true" />Connection added</span>}
        {view.edges.some((e) => e.kind === 'removed') && <span className="viz-key" title="Claude Code's reading of the change, not something git can confirm"><span className="viz-line removed" aria-hidden="true" />Connection removed</span>}
        {groups.map((g, i) => <span key={g} className="viz-key" style={secStyle(i)}><span className="sec-dot" aria-hidden="true" />{g}</span>)}
        <span className="grow" />
        <span className="muted">Point at a box for what it is and its code. Click one to go to its code.</span>
      </div>
      <div className="viz-canvas" ref={canvas}>
        {/* never wider than the page: a wide layer was broken into rows, and what is still too wide is drawn smaller */}
        <svg viewBox={`${lay.x} 0 ${lay.width} ${lay.height}`} style={{ width: lay.width, maxWidth: '100%', height: 'auto' }} role="group" aria-label={`${view.title}: ${view.nodes.length} boxes, ${plural(view.edges.length, 'connection')}`}>
          <g>
            {lay.wires.map((w, i) => (
              <g key={i} className={'viz-edge' + (w.edge.kind ? ' ' + w.edge.kind : '') + (cur ? (touches(w.edge) ? ' lit' : ' dim') : '')} data-gr-edge={i} data-gr-from={w.edge.from} data-gr-to={w.edge.to}>
                <path d={w.d} />
                <polygon points={w.tip.up ? `${w.tip.x},${w.tip.y} ${w.tip.x - 4.5},${w.tip.y + 8} ${w.tip.x + 4.5},${w.tip.y + 8}` : `${w.tip.x},${w.tip.y} ${w.tip.x - 4.5},${w.tip.y - 8} ${w.tip.x + 4.5},${w.tip.y - 8}`} />
              </g>
            ))}
          </g>
          <g>
            {lay.wires.map((w, i) => {
              const tw = lay.widths.get(w.edge) ?? 0
              if (!tw) return null
              return (
                <g key={i} className={'viz-edge-label' + (cur ? (touches(w.edge) ? ' lit' : ' dim') : '')}>
                  <rect x={w.mid.x - tw / 2} y={w.mid.y - 8} width={tw} height={16} rx={3} />
                  <text x={w.mid.x} y={w.mid.y + 4} textAnchor="middle">{w.edge.label}</text>
                </g>
              )
            })}
          </g>
          <g>
            {items.map((d) => {
              const b = lay.boxes.get(d.node.id)
              if (!b) return null
              const n = d.node
              const link = Boolean(links.get(n.id))
              const gi = n.group ? groups.indexOf(n.group) : -1
              return (
                <g
                  key={n.id} className={`viz-node ${n.status}` + (link ? ' link' : '') + (near ? (near.has(n.id) ? (n.id === cur?.id ? ' cur' : '') : ' dim') : '') + (pinned === n.id ? ' pinned' : '')}
                  transform={`translate(${b.x},${b.y})`} style={secStyle(gi)} tabIndex={0} role="button" aria-label={`${said(n)}${link ? '. Go to the code' : ''}`}
                  aria-describedby={cur?.id === n.id ? 'gr-viz-card' : undefined}
                  data-gr-node={n.id} data-gr-node-status={n.status}
                  onMouseEnter={(e) => point(n, e.currentTarget)} onMouseLeave={() => { setHover(null); if (pinned === n.id) pin(null) }}
                  onFocus={(e) => point(n, e.currentTarget)} onBlur={() => setHover(null)}
                  onClick={() => act(n)} onKeyDown={(e) => onKey(e, n)}
                >
                  <rect className="viz-box" width={b.w} height={b.h} rx={6} />
                  {gi >= 0 && <rect className="viz-group" x={1.5} y={1.5} width={4} height={b.h - 3} rx={2} />}
                  <text className="viz-label" x={14} y={d.sub.length ? 19 : 21}>{d.label}</text>
                  {d.sub.map((line, k) => <text key={k} className="viz-sub" x={14} y={35 + k * 14}>{line}</text>)}
                  {d.mark && <text className="viz-mark" x={b.w - 13} y={d.sub.length ? 19 : 21} textAnchor="middle">{d.mark}</text>}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      {cur && hover && <NodeCard node={cur} view={view} loaded={loaded} at={hover.at} link={Boolean(links.get(cur.id))} />}
    </div>
  )
}

// ── the tab ───────────────────────────────────────────────────
export function VisualTab({ loaded }: { loaded: LoadedReview }) {
  const picked = useStore((s) => s.visualView)
  const { request, set } = useStore.getState()
  const [steer, setSteer] = useState('')
  const [sending, setSending] = useState(false)
  // a second click can arrive before the first one's state is drawn: the ref is what stops it
  const busy = useRef(false)
  const visual = loaded.state.visual
  const open = loaded.state.requests.find((r) => r.kind === 'visualize' && isOpen(r))
  const why = open ? 'Claude Code has already been asked' : loaded.refMissing ? 'A side of this comparison no longer resolves' : loaded.files.length === 0 ? 'There is no change to draw' : undefined
  const blocked = Boolean(why) || sending
  const ask = (update: boolean): void => {
    if (blocked || busy.current) return
    busy.current = true
    setSending(true)
    // the steer is kept until the request is in: a refused one can be sent again as written
    void request({ kind: 'visualize', text: steer.trim() || undefined, update }).then((r) => { if (r) setSteer('') }).finally(() => { busy.current = false; setSending(false) })
  }
  const onSteerKey = (e: RKeyboardEvent): void => { if (e.key === 'Enter') { e.preventDefault(); ask(false) } }
  const drawing = open && (
    <div className="viz-drawing muted" data-gr="visual-drawing">
      <span className="spinner" /> {open.status === 'pending' ? 'Waiting for Claude Code to pick this up' : 'Claude Code is drawing'}{open.progress.length > 0 && <> — {open.progress[open.progress.length - 1].text}</>}
    </div>
  )
  if (!visual) {
    return (
      <div className="blankslate viz-empty" data-gr="visual-empty">
        <h3>See this change as diagrams</h3>
        <p className="muted">Claude Code draws how the whole change fits together: its architecture, how data flows through it, and which functions call which. Every box is checked against git and takes you to its code.</p>
        <div className="row gap wrap viz-ask">
          <input name="gr-field" value={steer} placeholder="What should it show? (optional)" onChange={(e) => setSteer(e.target.value)} onKeyDown={onSteerKey} aria-label="Steer" />
          <button className="btn primary" data-gr="visualize" disabled={blocked} title={why} onClick={() => ask(false)}><Icon name="graph" />Visualize this PR</button>
        </div>
        {drawing}
        <AwayHint />
      </div>
    )
  }
  const view = visual.views.find((v) => v.id === picked) ?? visual.views[0]
  return (
    <div className="visual" data-gr="visual">
      {loaded.visualStale && (
        <div className="flash-banner warn" data-gr="visual-stale">
          <span className="grow">The code changed since these diagrams were drawn. What a box says about its code may no longer hold.</span>
          <button className="btn sm" data-gr="visual-update" disabled={blocked} title={why} onClick={() => ask(true)}>Ask Claude Code to redraw them</button>
        </div>
      )}
      {drawing}
      {(visual.title || visual.summary) && (
        <div className="viz-intro">
          {visual.title && <h2>{visual.title}</h2>}
          {visual.summary && <Md text={visual.summary} />}
        </div>
      )}
      <div className="viz-views" role="group" aria-label="Diagrams">
        {visual.views.map((v) => (
          <button key={v.id} aria-pressed={v.id === view.id} className={'btn sm' + (v.id === view.id ? ' selected' : '')} data-gr-view-tab={v.id} title={KIND[v.kind]} onClick={() => { if (v.id !== view.id) set({ visualView: v.id, visualNode: null }) }}>
            {v.title}<span className="counter">{v.nodes.length}</span>
          </button>
        ))}
      </div>
      {view.caption && <Md text={view.caption} className="viz-caption" />}
      <Graph key={view.id} view={view} loaded={loaded} />
      <div className="desc-foot muted small">
        Drawn at <span className="mono">{short(visual.endSha)}</span> · {ago(visual.at)}
        <span className="grow" />
        <input name="gr-field" value={steer} placeholder="Steer (optional)" onChange={(e) => setSteer(e.target.value)} onKeyDown={onSteerKey} aria-label="Steer" />
        <button className="btn sm" data-gr="visualize" disabled={blocked} title={why} onClick={() => ask(false)}>Ask for fresh diagrams</button>
      </div>
    </div>
  )
}
