import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
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
const NODE_MAX = 280
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

interface Drawn { node: VisualNode; label: string; sub: string; w: number; h: number; mark: string }
function drawn(n: VisualNode): Drawn {
  const mark = STATUS[n.status].mark
  // the bar of its group on the left, the status mark on the right
  const room = NODE_MAX - 14 - 12 - (mark ? 16 : 0)
  const label = fit(n.label, LABEL, room)
  const sub = fit(n.sub || placeOf(n, false), SUB, room)
  const w = Math.max(96, Math.ceil(Math.max(textWidth(label, LABEL), textWidth(sub, SUB))) + 14 + 12 + (mark ? 16 : 0))
  return { node: n, label, sub, w, h: sub ? 46 : 32, mark }
}

// ── one diagram ───────────────────────────────────────────────
function Graph({ view, loaded }: { view: VisualView; loaded: LoadedReview }) {
  const [hover, setHover] = useState<string | null>(null)
  // the box last picked: kept in the store, so it is still marked on the way back from its code
  const pinned = useStore((s) => s.visualNode)
  const pin = (id: string | null): void => useStore.getState().set({ visualNode: id })
  const root = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => [...new Set(view.nodes.map((n) => n.group).filter((g): g is string => Boolean(g)))], [view])
  const items = useMemo(() => view.nodes.map(drawn), [view])
  const lay = useMemo(() => {
    const widths = new Map(view.edges.map((e) => [e, e.label ? textWidth(e.label, EDGE) + 8 : 0]))
    return { ...layout(items.map((d) => ({ id: d.node.id, w: d.w, h: d.h })), view.edges, view.edges.some((e) => e.label) ? 76 : 52, (e) => widths.get(e) ?? 0), widths }
  }, [items, view])
  const links = useMemo(() => new Map(view.nodes.map((n) => [n.id, goTo(n, loaded)])), [view, loaded])
  const cur = view.nodes.find((n) => n.id === (hover ?? pinned)) ?? null
  const near = useMemo(() => {
    if (!cur) return null
    const ids = new Set([cur.id])
    for (const e of view.edges) { if (e.from === cur.id) ids.add(e.to); if (e.to === cur.id) ids.add(e.from) }
    return ids
  }, [cur, view])
  // back from the code: the keyboard is where it was, on the box that was picked
  useEffect(() => {
    const id = useStore.getState().visualNode
    if (id) root.current?.querySelector<SVGGElement>(`[data-gr-node="${cssq(id)}"]`)?.focus({ preventScroll: true })
  }, [])
  const touches = (e: VisualEdge): boolean => Boolean(cur) && (e.from === cur?.id || e.to === cur?.id)
  const name = (id: string): string => view.nodes.find((n) => n.id === id)?.label ?? id
  /** the boxes at the other end of a box's edges, each with what its edge says */
  const ends = (id: string, dir: 'from' | 'to'): string =>
    view.edges.filter((e) => e[dir === 'from' ? 'to' : 'from'] === id).map((e) => `${name(e[dir])}${e.label ? ` (${e.label})` : ''}`).join(', ')
  const go = cur ? links.get(cur.id) ?? null : null
  const act = (n: VisualNode): void => {
    const run = links.get(n.id)
    if (run) { pin(n.id); run() } else pin(pinned === n.id ? null : n.id)
  }
  const onKey = (e: RKeyboardEvent, n: VisualNode): void => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(n) } }
  const said = (n: VisualNode): string => [n.label, STATUS[n.status].label.toLowerCase(), placeOf(n), n.sub].filter(Boolean).join(', ')
  // The details of a box stay while the pointer or the keyboard is anywhere in the diagram
  // or the strip under it (the strip holds a button): they go when either leaves both.
  const inside = (el: EventTarget | null): boolean => el instanceof Node && Boolean(root.current?.contains(el))
  return (
    <div className="viz" ref={root} data-gr="visual-view" data-gr-view={view.id} data-gr-view-kind={view.kind} onMouseLeave={() => setHover(null)} onBlur={(e) => { if (!inside(e.relatedTarget)) setHover(null) }}>
      <div className="viz-legend small" aria-label="Legend">
        {(['new', 'changed', 'deleted', 'unchanged', 'none'] as const).filter((s) => view.nodes.some((n) => n.status === s)).map((s) => (
          <span key={s} className="viz-key" title={STATUS[s].title}><span className={'viz-swatch ' + s} aria-hidden="true">{STATUS[s].mark}</span>{STATUS[s].label}</span>
        ))}
        {view.edges.some((e) => e.kind === 'new') && <span className="viz-key" title="Claude Code's reading of the change, not something git can confirm"><span className="viz-line new" aria-hidden="true" />Connection added</span>}
        {view.edges.some((e) => e.kind === 'removed') && <span className="viz-key" title="Claude Code's reading of the change, not something git can confirm"><span className="viz-line removed" aria-hidden="true" />Connection removed</span>}
        {groups.map((g, i) => <span key={g} className="viz-key" style={secStyle(i)}><span className="sec-dot" aria-hidden="true" />{g}</span>)}
      </div>
      <div className="viz-canvas">
        {/* wider than the page: shrunk to fit, but only a little, so the text stays readable; past that it scrolls sideways */}
        <svg viewBox={`${lay.x} 0 ${lay.width} ${lay.height}`} style={{ width: lay.width, maxWidth: '100%', minWidth: Math.min(lay.width, Math.max(320, lay.width * 0.85)), height: 'auto' }} role="group" aria-label={`${view.title}: ${view.nodes.length} boxes, ${plural(view.edges.length, 'connection')}`}>
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
                  data-gr-node={n.id} data-gr-node-status={n.status}
                  onMouseEnter={() => setHover(n.id)} onFocus={() => setHover(n.id)}
                  onClick={() => act(n)} onKeyDown={(e) => onKey(e, n)}
                >
                  <rect className="viz-box" width={b.w} height={b.h} rx={6} />
                  {gi >= 0 && <rect className="viz-group" x={1.5} y={1.5} width={4} height={b.h - 3} rx={2} />}
                  <text className="viz-label" x={14} y={d.sub ? 19 : 21}>{d.label}</text>
                  {d.sub && <text className="viz-sub" x={14} y={35}>{d.sub}</text>}
                  {d.mark && <text className="viz-mark" x={b.w - 13} y={d.sub ? 19 : 21} textAnchor="middle">{d.mark}</text>}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      <div className="viz-detail" data-gr="visual-detail">
        {!cur ? <span className="muted">Point at a box to see what it is. A box with code in this change takes you to that code.</span> : (
          <>
            <strong>{cur.label}</strong>
            <span className={'label viz-status ' + cur.status} title={STATUS[cur.status].title}>{STATUS[cur.status].label}</span>
            {cur.file && <span className="mono small">{placeOf(cur)}</span>}
            {cur.sub && <span className="muted">{cur.sub}</span>}
            {cur.group && <span className="muted small">in {cur.group}</span>}
            {view.edges.some((e) => e.to === cur.id) && <span className="muted small">from {ends(cur.id, 'from')}</span>}
            {view.edges.some((e) => e.from === cur.id) && <span className="muted small">to {ends(cur.id, 'to')}</span>}
            <span className="grow" />
            {go ? <button className="btn sm" data-gr="visual-go" onClick={() => { pin(cur.id); go() }}>Go to the code</button>
              : cur.file && <span className="muted small">{cur.inDiff ? 'no longer in this comparison' : 'not part of this change'}</span>}
          </>
        )}
      </div>
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
