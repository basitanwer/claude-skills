// Lays a small directed graph out in layers, top to bottom: what a diagram of the
// Visualize tab is drawn from. No dependency: a few dozen boxes do not need one.
//   1. cycles are broken (an edge back to a node still being walked is turned round)
//   2. each node gets a layer: one below the lowest node that points at it
//   3. an edge that crosses layers is routed through a point in each layer it crosses
//   4. layers are ordered to reduce crossings (barycentre sweeps, the best one kept)
//   5. nodes are moved sideways towards what they connect to, without overlapping
// A layer wider than the page is broken into rows first, so the drawing grows downwards and never sideways.
import type { VisualEdge } from '@shared/types'

export interface Box { id: string; x: number; y: number; w: number; h: number }
export interface Wire {
  edge: VisualEdge
  /** the path, from the edge's `from` to its `to` */
  d: string
  /** the arrowhead at `to`: its tip and which way it points */
  tip: { x: number; y: number; up: boolean }
  /** where a label sits */
  mid: { x: number; y: number }
}
/** `x`: where the drawing starts on the x axis (a label can reach left of the first box). */
export interface Layout { x: number; width: number; height: number; boxes: Map<string, Box>; wires: Wire[] }

const GAP_X = 28
const GAP_ROUTE = 14
const PAD = 16
/** how far apart the ends of two edges sit on the same side of a box */
const PORT = 14
/** how wide a row of boxes that connect to nothing may get before the next row starts */
const ROW = 900
const LABEL_H = 16

interface Vertex { id: string | null; w: number; h: number; rank: number; cx: number; up: number[]; down: number[] }

/** `labelWidth`: how wide an edge's label is drawn (0: it has none), so that labels can be
 *  kept off each other. `maxWidth`: how wide a layer of boxes may get before it is broken
 *  into rows (0: any width). */
export function layout(sizes: { id: string; w: number; h: number }[], edges: VisualEdge[], gapY = 56, labelWidth: (e: VisualEdge) => number = () => 0, maxWidth = 0): Layout {
  const index = new Map(sizes.map((s, i) => [s.id, i]))
  const n = sizes.length
  const es = edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to)
    .map((edge) => ({ edge, u: index.get(edge.from)!, v: index.get(edge.to)!, rev: false }))

  // 1. break cycles
  const out: number[][] = sizes.map(() => [])
  es.forEach((e, i) => out[e.u].push(i))
  const seen = new Uint8Array(n)                  // 1: being walked, 2: done
  const walk = (u: number): void => {
    seen[u] = 1
    for (const i of out[u]) {
      const e = es[i]
      if (seen[e.v] === 1) e.rev = true
      else if (!seen[e.v]) walk(e.v)
    }
    seen[u] = 2
  }
  for (let u = 0; u < n; u++) if (!seen[u]) walk(u)
  // from here on an edge runs downwards from `s` to `t`
  const flow = es.map((e) => (e.rev ? { ...e, s: e.v, t: e.u } : { ...e, s: e.u, t: e.v }))

  // 2. layers: the longest way down to each node
  const rank = new Array<number>(n).fill(0)
  const waiting = new Array<number>(n).fill(0)
  const below: number[][] = sizes.map(() => [])
  for (const e of flow) { waiting[e.t]++; below[e.s].push(e.t) }
  const queue: number[] = []
  for (let u = 0; u < n; u++) if (!waiting[u]) queue.push(u)
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q]
    for (const t of below[u]) { rank[t] = Math.max(rank[t], rank[u] + 1); if (!--waiting[t]) queue.push(t) }
  }
  // a node nothing points at sits just above the first thing it points at, not at the very top
  for (let u = 0; u < n; u++) if (below[u].length && !flow.some((e) => e.t === u)) rank[u] = Math.min(...below[u].map((t) => rank[t])) - 1

  // boxes that connect to nothing go in rows of their own under the rest, not in one long line
  const lone = sizes.map((_, u) => !flow.some((e) => e.s === u || e.t === u))
  if (lone.some(Boolean)) {
    let r = lone.every(Boolean) ? 0 : Math.max(...rank.filter((_, u) => !lone[u])) + 1
    let w = 0
    sizes.forEach((s, u) => {
      if (!lone[u]) return
      if (w > 0 && w + s.w > ROW) { r++; w = 0 }
      rank[u] = r; w += s.w + GAP_X
    })
  }

  // a layer wider than the page becomes several rows, and every layer under it moves down.
  // Boxes of one layer have no edges between them, so a row is a layer like any other.
  if (maxWidth > 0) {
    const was = [...rank]
    const ranks = [...new Set(was)].sort((a, b) => a - b)
    let shift = 0
    for (const r of ranks) {
      let row = 0; let w = 0
      sizes.forEach((s, u) => {
        if (was[u] !== r) return
        if (w > 0 && w + s.w > maxWidth) { row++; w = 0 }
        rank[u] = r + shift + row; w += s.w + GAP_X
      })
      shift += row
    }
  }

  // 3. vertices: the nodes, and a routing point wherever an edge crosses a layer
  const vs: Vertex[] = sizes.map((s, i) => ({ id: s.id, w: s.w, h: s.h, rank: rank[i], cx: 0, up: [], down: [] }))
  const routes = flow.map((e) => {
    const route = [e.s]
    for (let r = rank[e.s] + 1; r < rank[e.t]; r++) { vs.push({ id: null, w: 0, h: 0, rank: r, cx: 0, up: [], down: [] }); route.push(vs.length - 1) }
    route.push(e.t)
    for (let i = 0; i + 1 < route.length; i++) { vs[route[i]].down.push(route[i + 1]); vs[route[i + 1]].up.push(route[i]) }
    return route
  })
  const depth = Math.max(0, ...vs.map((v) => v.rank)) + 1
  let layers: number[][] = Array.from({ length: depth }, () => [])
  vs.forEach((v, i) => layers[v.rank].push(i))

  // 4. order each layer to reduce crossings
  const at = new Array<number>(vs.length).fill(0)
  const place = (ls: number[][]): void => { for (const l of ls) l.forEach((v, i) => { at[v] = i }) }
  const crossings = (ls: number[][]): number => {
    place(ls)
    let c = 0
    for (const l of ls) {
      const segs = l.flatMap((v) => vs[v].down.map((t) => [at[v], at[t]]))
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) c++
    }
    return c
  }
  let best = layers.map((l) => [...l])
  let least = crossings(best)
  for (let it = 0; it < 12 && least > 0; it++) {
    const down = it % 2 === 0
    place(layers)
    for (let k = 1; k < depth; k++) {
      const r = down ? k : depth - 1 - k
      const key = new Map(layers[r].map((v, i) => {
        const near = down ? vs[v].up : vs[v].down
        return [v, near.length ? near.reduce((a, x) => a + at[x], 0) / near.length : i]
      }))
      layers[r] = [...layers[r]].sort((a, b) => key.get(a)! - key.get(b)!)
      layers[r].forEach((v, i) => { at[v] = i })
    }
    const c = crossings(layers)
    if (c < least) { least = c; best = layers.map((l) => [...l]) }
  }
  layers = best

  // 5. sideways: packed first, then pulled towards neighbours. A layer is placed from the
  //    left and from the right and the two are averaged, which keeps the gaps on both sides.
  const half = (v: number): number => vs[v].w / 2
  const gap = (a: number, b: number): number => (vs[a].id === null && vs[b].id === null ? GAP_ROUTE : GAP_X)
  for (const l of layers) {
    let x = 0
    l.forEach((v, i) => { if (i) x += half(l[i - 1]) + gap(l[i - 1], v) + half(v); vs[v].cx = x })
    const mid = l.length ? (vs[l[0]].cx + vs[l[l.length - 1]].cx) / 2 : 0
    for (const v of l) vs[v].cx -= mid
  }
  const pull = (l: number[], towards: (v: Vertex) => number[]): void => {
    const want = l.map((v) => { const near = towards(vs[v]); return near.length ? near.reduce((a, x) => a + vs[x].cx, 0) / near.length : vs[v].cx })
    const left = [...want]; const right = [...want]
    for (let i = 1; i < l.length; i++) left[i] = Math.max(left[i], left[i - 1] + half(l[i - 1]) + gap(l[i - 1], l[i]) + half(l[i]))
    for (let i = l.length - 2; i >= 0; i--) right[i] = Math.min(right[i], right[i + 1] - half(l[i + 1]) - gap(l[i], l[i + 1]) - half(l[i]))
    l.forEach((v, i) => { vs[v].cx = (left[i] + right[i]) / 2 })
    hold(l)
  }
  // Pulling boxes towards their neighbours must not push the drawing wider than the page:
  // each box is held between the leftmost and the rightmost place its layer leaves it within
  // `maxWidth`. A layer that cannot fit at all (its boxes and gaps are wider) is left packed.
  const hold = (l: number[]): void => {
    if (!(maxWidth > 0) || !l.length) return
    const lo: number[] = []; const hi: number[] = new Array<number>(l.length)
    l.forEach((v, i) => { lo.push(i ? lo[i - 1] + half(l[i - 1]) + gap(l[i - 1], v) + half(v) : -maxWidth / 2 + half(v)) })
    for (let i = l.length - 1; i >= 0; i--) hi[i] = i === l.length - 1 ? maxWidth / 2 - half(l[i]) : hi[i + 1] - half(l[i + 1]) - gap(l[i], l[i + 1]) - half(l[i])
    if (lo[l.length - 1] > hi[l.length - 1]) { const mid = (lo[0] + lo[l.length - 1]) / 2; l.forEach((v, i) => { vs[v].cx = lo[i] - mid }); return }
    l.forEach((v, i) => { vs[v].cx = Math.min(hi[i], Math.max(lo[i], vs[v].cx)) })
  }
  for (let it = 0; it < 8; it++) {
    for (let r = 1; r < depth; r++) pull(layers[r], (v) => v.up)
    for (let r = depth - 2; r >= 0; r--) pull(layers[r], (v) => v.down)
  }
  const minLeft = vs.length ? Math.min(...vs.map((v, i) => v.cx - half(i))) : 0
  for (const v of vs) v.cx += PAD - minLeft

  const tops: number[] = []; const heights: number[] = []
  let y = PAD
  for (const l of layers) {
    const h = Math.max(0, ...l.map((v) => vs[v].h))
    tops.push(y); heights.push(h)
    y += h + gapY
  }
  const boxes = new Map<string, Box>()
  vs.forEach((v) => { if (v.id !== null) boxes.set(v.id, { id: v.id, x: v.cx - v.w / 2, y: tops[v.rank] + (heights[v.rank] - v.h) / 2, w: v.w, h: v.h }) })

  // where each edge leaves and enters a box: spread along the side, in the order of the far ends
  const ports = (list: { route: number[]; far: number }[], v: Vertex): Map<number[], number> => {
    const sorted = [...list].sort((a, b) => vs[a.far].cx - vs[b.far].cx)
    const step = Math.min(PORT, Math.max(0, v.w - 24) / Math.max(1, sorted.length))
    return new Map(sorted.map((p, i) => [p.route, v.cx + (i - (sorted.length - 1) / 2) * step]))
  }
  const leaving = new Map<number[], number>(); const entering = new Map<number[], number>()
  for (let u = 0; u < n; u++) {
    for (const [r, x] of ports(routes.filter((r) => r[0] === u).map((route) => ({ route, far: route[1] })), vs[u])) leaving.set(r, x)
    for (const [r, x] of ports(routes.filter((r) => r[r.length - 1] === u).map((route) => ({ route, far: route[route.length - 2] })), vs[u])) entering.set(r, x)
  }
  const drawn = flow.map((e, i) => {
    const route = routes[i]
    const s = boxes.get(sizes[e.s].id)!; const t = boxes.get(sizes[e.t].id)!
    // points from the upper box down to the lower one; a routing point is crossed straight down
    let pts: [number, number][] = [[leaving.get(route)!, s.y + s.h]]
    for (const v of route.slice(1, -1)) pts.push([vs[v].cx, tops[vs[v].rank]], [vs[v].cx, tops[vs[v].rank] + heights[vs[v].rank]])
    pts.push([entering.get(route)!, t.y])
    if (e.rev) pts = pts.reverse()
    let d = `M${pts[0][0]},${pts[0][1]}`
    for (let k = 1; k < pts.length; k++) {
      const [x1, y1] = pts[k - 1]; const [x2, y2] = pts[k]
      const ym = (y1 + y2) / 2
      d += x1 === x2 ? `L${x2},${y2}` : `C${x1},${ym} ${x2},${ym} ${x2},${y2}`
    }
    // a point of the stretch from pts[k] to pts[k + 1], which is a curve between two layers
    const on = (k: number, t: number): { x: number; y: number } => {
      const [x1, y1] = pts[k]; const [x2, y2] = pts[k + 1]
      const a = (1 - t) ** 3 + 3 * (1 - t) ** 2 * t; const b = 3 * (1 - t) * t ** 2 + t ** 3
      return { x: a * x1 + b * x2, y: (1 - t) ** 3 * y1 + 3 * (1 - t) * t * (y1 + y2) / 2 + t ** 3 * y2 }
    }
    const along: { x: number; y: number }[] = []
    for (let k = 0; k + 1 < pts.length; k++) for (let t = 0; t <= 1; t += 0.1) along.push(on(k, t))
    const end = pts[pts.length - 1]
    // the label goes on the stretch between two layers nearest the middle of the edge
    return { edge: e.edge, d, tip: { x: end[0], y: end[1], up: e.rev }, on: (t: number) => on(2 * Math.floor((route.length - 1) / 2), t), along }
  })
  // Labels, one edge after the other. Each goes where it hides least: on its edge at the
  // middle or further along, or beside the edge when anything on it would cover another
  // label, a box or somebody else's line (two edges between the same boxes run side by side).
  const labels: { x: number; y: number; w: number }[] = []
  const wires: Wire[] = drawn.map((g, i) => {
    const w = labelWidth(g.edge)
    if (!w) return { edge: g.edge, d: g.d, tip: g.tip, mid: g.on(0.5) }
    const cost = (p: { x: number; y: number }): number => {
      const l = p.x - w / 2; const r = p.x + w / 2; const t = p.y - LABEL_H / 2; const b = p.y + LABEL_H / 2
      let c = 0
      for (const o of labels) if (Math.abs(o.x - p.x) < (o.w + w) / 2 + 4 && Math.abs(o.y - p.y) < LABEL_H) c += 100
      for (const box of boxes.values()) if (l < box.x + box.w && r > box.x && t < box.y + box.h && b > box.y) c += 50
      drawn.forEach((o, j) => { if (j !== i) for (const q of o.along) if (q.x > l - 2 && q.x < r + 2 && q.y > t - 2 && q.y < b + 2) c++ })
      return c
    }
    const spots = [0.5, 0.35, 0.65, 0.2, 0.8].map((t) => ({ p: g.on(t), extra: 0 }))
    for (const t of [0.5, 0.3, 0.7]) for (const side of [1, -1]) { const p = g.on(t); spots.push({ p: { x: p.x + side * (w / 2 + 6), y: p.y }, extra: 0.5 }) }
    let mid = spots[0].p; let least = Infinity
    for (const s of spots) { const c = cost(s.p) + s.extra; if (c < least) { least = c; mid = s.p } }
    labels.push({ ...mid, w })
    return { edge: g.edge, d: g.d, tip: g.tip, mid }
  })
  // a label may reach past the boxes on either side
  const x = Math.min(0, ...labels.map((l) => l.x - l.w / 2 - 4))
  const right = Math.max(...vs.map((v, i) => v.cx + half(i)), ...labels.map((l) => l.x + l.w / 2 - PAD + 4)) + PAD
  return { x, width: right - x, height: y - gapY + PAD, boxes, wires }
}
