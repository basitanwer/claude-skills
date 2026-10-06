import { memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AnchorInput, Comment, DiffLine, FileDiff, Hunk, Section } from '@shared/types'
import { api } from '../api'
import { highlightLine, langForPath } from '../highlight'
import { pairHunkLines, wordDiffRanges, type CharRange } from '../worddiff'
import { useStore } from '../store'
import { showSection } from '../focus'
import { errText, hunksForMode, plural, secStyle } from '../util'
import { CopyButton, DiffStat, Icon, Md, Menu, MenuItem } from './common'
import { CommentSlot, CommentsCtx, Composer, Thread } from './comments'

/** Wrap character ranges of already-highlighted HTML in <mark>, without breaking
 *  the syntax spans: the mark is closed before every tag and reopened after it. */
export function applyMarks(html: string, ranges: CharRange[]): string {
  if (ranges.length === 0) return html
  let out = ''
  let pos = 0
  let i = 0
  let r = 0
  let open = false
  while (i < html.length) {
    if (html[i] === '<') {
      const j = html.indexOf('>', i)
      if (j < 0) break
      if (open) { out += '</mark>'; open = false }
      out += html.slice(i, j + 1)
      i = j + 1
      continue
    }
    let ch: string
    if (html[i] === '&') {
      const j = html.indexOf(';', i)
      ch = j < 0 ? html[i] : html.slice(i, j + 1)
      i += ch.length
    } else {
      ch = html[i]
      i++
    }
    while (r < ranges.length && pos >= ranges[r].start + ranges[r].len) r++
    const want = r < ranges.length && pos >= ranges[r].start
    if (want && !open) { out += '<mark class="wd">'; open = true }
    if (!want && open) { out += '</mark>'; open = false }
    out += ch
    pos++
  }
  if (open) out += '</mark>'
  return out + html.slice(i)
}

// ── the line the pointer is on, for the `c` shortcut ──────────
let hovered: string | null = null
/** Composer key ("diff:<path>:<side>:<n>") of the diff line under the pointer. */
export const hoveredLine = (): string | null => hovered

const keyOf = (path: string, side: 'old' | 'new', n: number): string => `diff:${path}:${side}:${n}`
const lineKeys = (path: string, l: DiffLine): string[] => {
  const keys: string[] = []
  if (l.kind !== 'del' && l.new != null) keys.push(keyOf(path, 'new', l.new))
  if (l.kind !== 'add' && l.old != null) keys.push(keyOf(path, 'old', l.old))
  return keys
}

// ── hunk geometry and the gaps between hunks ──────────────────
interface Geo { oldStart: number; newStart: number; oldEnd: number; newEnd: number }
function geo(h: Hunk): Geo {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.range)
  const a = Number(m?.[1] ?? 1); const b = m?.[2] === undefined ? 1 : Number(m[2])
  const c = Number(m?.[3] ?? 1); const d = m?.[4] === undefined ? 1 : Number(m[4])
  const oldStart = b === 0 ? a + 1 : a; const newStart = d === 0 ? c + 1 : c
  return { oldStart, newStart, oldEnd: oldStart + b - 1, newEnd: newStart + d - 1 }
}
const STEP = 20
const AROUND = 3
const ALL = 1_000_000
const squash = (t: string): string => t.replace(/\s+/g, ' ').trim()

// How long is the file? Needed to know whether anything follows the last hunk. Asked
// once per open file, two at a time, and only for a saved review (it never saves one).
const lengthQueue: (() => Promise<void>)[] = []
let lengthRunning = 0
function pumpLengths(): void {
  while (lengthRunning < 2 && lengthQueue.length) {
    lengthRunning++
    void lengthQueue.shift()!().finally(() => { lengthRunning--; pumpLengths() })
  }
}
function askLength(path: string, done: (total: number) => void): () => void {
  let live = true
  lengthQueue.push(async () => {
    const id = useStore.getState().sessionId
    if (!live || id == null) return
    try { const r = await api.fileLines(id, path, 'new', 1, 0); if (live) done(r.total) } catch { /* the expander stays; a click reports the error */ }
  })
  pumpLengths()
  return () => { live = false }
}

type Cell = { l: DiffLine; marks: CharRange[] } | null
type Item =
  /** hidden lines a..b (b null: to the end of a file of unknown length); `hunk` when the run sits right above one */
  | { k: 'head'; a: number; b: number | null; hunk: Hunk | null; last: boolean; bare?: boolean }
  | { k: 'line'; cell: NonNullable<Cell>; ctx?: boolean }
  | { k: 'pair'; left: Cell; right: Cell; ctx?: boolean }

function Code({ text, lang, marks }: { text: string; lang: string | null; marks: CharRange[] }) {
  return <code className="hl" dangerouslySetInnerHTML={{ __html: applyMarks(highlightLine(text, lang), marks) || '&nbsp;' }} />
}
/** How much of one line is rendered before the rest waits behind "show more", and how
 *  much each click adds. A minified bundle is a single line of 150,000 characters: shown
 *  whole and wrapped, that one line is 300,000px tall. */
const LINE_MAX = 2000
const LINE_MORE = 10_000
/** A line longer than LINE_MAX, cut short. Not highlighted: nobody reads it as code, and
 *  the highlighter is slow on it. */
function LongCode({ text, marks }: { text: string; marks: CharRange[] }) {
  const [n, setN] = useState(LINE_MAX)
  const rest = text.length - n
  return (
    <>
      <Code text={rest > 0 ? text.slice(0, n) : text} lang={null} marks={marks} />
      {rest > 0 && <button className="more-line" data-gr="line-more" title={`This line is ${text.length.toLocaleString()} characters long`} onClick={() => setN(n + LINE_MORE)}>… show {Math.min(rest, LINE_MORE).toLocaleString()} more of {rest.toLocaleString()} hidden characters</button>}
    </>
  )
}

/** One side of a line: number gutter + code, with the "+" that opens the composer. */
function Half({ path, l, side, lang, marks, onAdd, bare }: {
  path: string; l: DiffLine | null; side: 'old' | 'new'; lang: string | null; marks: CharRange[]
  /** absent in a read-only view */
  onAdd?: (key: string) => void
  /** unified view draws both number gutters itself */
  bare?: boolean
}) {
  if (!l) return <><span className="ln empty" /><span className="code empty" /></>
  const n = (side === 'old' ? l.old : l.new) ?? 0
  const key = keyOf(path, side, n)
  // a line's canonical address: removed lines on the old side, everything else on the new
  const canonical = (l.kind === 'del') === (side === 'old')
  const cls = (l.kind || 'ctx') + (l.since ? ' since' : '') + (l.sinceViewed ? ' since-viewed' : '') + (l.origin && l.origin !== 'committed' ? ' o-' + l.origin : '')
  return (
    <>
      {!bare && <span className={'ln ' + cls} title={l.origin && l.origin !== 'committed' ? `Uncommitted — ${l.origin}` : undefined}>{n}</span>}
      <span
        className={'code ' + cls} data-gr-line={canonical ? `${path}:${side}:${n}` : undefined}
        data-old={side === 'old' || (bare && l.kind === '') ? (l.old ?? undefined) : undefined} data-new={side === 'new' ? n : undefined}
        onMouseEnter={onAdd ? () => { hovered = key } : undefined} onMouseLeave={onAdd ? () => { if (hovered === key) hovered = null } : undefined}
      >
        {onAdd && <button className="add-line" title="Comment on this line (c)" aria-label={`Comment on line ${n}`} onClick={() => onAdd(key)}><Icon name="plus" size={12} /></button>}
        <span className="sg">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
        {l.text.length > LINE_MAX ? <LongCode text={l.text} marks={marks} /> : <Code text={l.text} lang={lang} marks={marks} />}
      </span>
    </>
  )
}

function threadsAt(path: string, l: DiffLine | null, side: 'old' | 'new', placed: Map<string, Comment[]>, composer: string | null): ReactNode {
  if (!l) return null
  const n = side === 'old' ? l.old : l.new
  if (n == null || (side === 'old' && l.kind === 'add') || (side === 'new' && l.kind === 'del')) return null
  const key = keyOf(path, side, n)
  const list = placed.get(key) ?? []
  const composing = composer === key
  if (!list.length && !composing) return null
  // the server validates this against git and copies the line text itself; `expect`
  // makes it refuse if the line changed under the reviewer
  const anchor: AnchorInput = { kind: 'diff', file: path, side, line: n, expect: l.text }
  return (
    <>
      {list.map((c) => <Thread key={c.id} c={c} />)}
      {composing && <Composer anchor={anchor} k={key} />}
    </>
  )
}

/** The rows of one file. Besides the diff's hunks it can show any other line of the
 *  file: context the reviewer expanded, and the few lines around a comment or a focus
 *  target that lies outside the hunks. Those lines are read on demand (`fileLines`). */
const DiffBody = memo(function DiffBody({ file, hunks, split, placed, outside, composer, canExpand, readOnly, expandAll }: {
  file: FileDiff; hunks: Hunk[]; split: boolean; placed: Map<string, Comment[]>
  /** comments on lines of this file that are not in the rendered hunks */
  outside: Comment[]
  composer: string | null; canExpand: boolean; readOnly: boolean; expandAll: number
}) {
  const path = file.path
  const lang = useMemo(() => langForPath(path), [path])
  /** new-side numbers of the lines shown outside the hunks */
  const [shown, setShown] = useState<Set<number>>(() => new Set())
  const [cache, setCache] = useState<Map<number, string>>(() => new Map())
  const [total, setTotal] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [doneAll, setDoneAll] = useState(0)
  const reveal = useStore((s) => (s.reveal && (s.reveal.file === path || s.reveal.file === file.oldPath) ? s.reveal : null))
  const onAdd = readOnly ? undefined : (key: string): void => useStore.getState().set({ composer: key })
  const geos = useMemo(() => hunks.map(geo), [hunks])
  const n = hunks.length
  useEffect(() => (canExpand ? askLength(path, setTotal) : undefined), [canExpand, path])

  /** new-side line range of gap `i` (the lines before hunk i; i === n is the tail) */
  const gapRange = (i: number): { start: number; end: number | null; delta: number } => {
    const start = i === 0 ? 1 : geos[i - 1].newEnd + 1
    if (i < n) return { start, end: geos[i].newStart - 1, delta: geos[i].newStart - geos[i].oldStart }
    return { start, end: total, delta: n ? geos[n - 1].newEnd - geos[n - 1].oldEnd : 0 }
  }
  /** Where a line outside the hunks sits: its gap and its new-side number. Null when
   *  the line is inside a hunk (then it is already on screen). */
  const locate = (side: 'old' | 'new', line: number): { gap: number; t: number } | null => {
    for (let i = 0; i <= n; i++) {
      const g = gapRange(i)
      const t = side === 'new' ? line : line + g.delta
      if (t < g.start) return null                          // inside the hunk above this gap
      if (i === n || t <= (g.end ?? 0)) return { gap: i, t }
    }
    return null
  }
  const fetchLines = async (from: number, to: number): Promise<void> => {
    if (to < from) return
    const st = useStore.getState()
    setBusy(true)
    try {
      // reading the file needs a saved review; the first expand saves the draft
      const id = await st.materialize()
      if (id == null) return
      const res = await api.fileLines(id, path, 'new', from, to)
      setCache((prev) => { const next = new Map(prev); res.lines.forEach((t, k) => next.set(res.start + k, t)); return next })
      setTotal(res.total)
      setShown((prev) => { const next = new Set(prev); res.lines.forEach((_, k) => next.add(res.start + k)); return next })
    } catch (e) { st.toast(errText(e), 'error') } finally { setBusy(false) }
  }
  /** Show a line that is outside the hunks, with a few lines either side of it. */
  const showAround = async (targets: { gap: number; t: number }[]): Promise<void> => {
    for (const { gap, t } of targets) {
      const g = gapRange(gap)
      await fetchLines(Math.max(g.start, t - AROUND), Math.min(g.end ?? ALL, t + AROUND))
    }
  }

  // comments outside the hunks, and focus targets, are fetched and shown in place
  const wanted = canExpand ? outside.map((c) => (c.anchor.kind === 'diff' ? locate(c.anchor.side, c.anchor.line) : null)).filter((x): x is { gap: number; t: number } => Boolean(x)) : []
  const missing = wanted.filter((w) => !cache.has(w.t) && (total == null || w.t <= total))
  const missingKey = missing.map((w) => w.t).join(',')
  useEffect(() => {
    if (missing.length && useStore.getState().sessionId != null) void showAround(missing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey])
  const revealSeq = reveal?.seq
  useEffect(() => {
    if (!reveal || !canExpand) return
    const at = locate(reveal.side, reveal.line)
    if (at && !shown.has(at.t)) void showAround([at])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq])
  // "expand all" from the file header: read the whole file once
  if (expandAll !== doneAll) {
    setDoneAll(expandAll)
    if (canExpand) void fetchLines(1, ALL)
  }

  // threads for the outside comments whose line is on screen and still reads the same
  const { all, lost } = useMemo(() => {
    const all = new Map(placed); const lost: Comment[] = []
    if (!canExpand) return { all, lost }
    for (const c of outside) {
      if (c.anchor.kind !== 'diff') continue
      const at = locate(c.anchor.side, c.anchor.line)
      if (!at || (total != null && at.t > total)) { lost.push(c); continue }
      const text = cache.get(at.t)
      if (text === undefined) continue       // still loading
      if (c.anchor.lineContent && text !== c.anchor.lineContent && squash(text) !== squash(c.anchor.lineContent)) { lost.push(c); continue }
      const k = keyOf(path, c.anchor.side, c.anchor.line)
      all.set(k, [...(all.get(k) ?? []), c])
    }
    return { all, lost }
    // locate closes over geos/total, which are in the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, outside, cache, total, geos, canExpand, path])

  const items = useMemo(() => {
    const out: Item[] = []
    for (let i = 0; i <= n; i++) {
      const g = gapRange(i)
      const tail = i === n
      const size = g.end == null ? null : Math.max(0, g.end - g.start + 1)
      const lines = canExpand ? [...shown].filter((k) => k >= g.start && (g.end == null || k <= g.end) && cache.has(k)).sort((x, y) => x - y) : []
      let cursor = g.start
      let headed = false
      const hide = (a: number, b: number | null): void => {
        if (!canExpand) return
        const above = !tail && b === g.end
        if (above) headed = true
        out.push({ k: 'head', a, b, hunk: above ? hunks[i] : null, last: tail && (b == null || b === total) })
      }
      for (const k of lines) {
        if (k > cursor) hide(cursor, k - 1)
        const l: DiffLine = { old: k - g.delta, new: k, kind: '', text: cache.get(k) ?? '' }
        out.push(split ? { k: 'pair', left: { l, marks: [] }, right: { l, marks: [] }, ctx: true } : { k: 'line', cell: { l, marks: [] }, ctx: true })
        cursor = k + 1
      }
      // what is still hidden below the last shown line of this gap; nothing is offered
      // for a file with no hunks at all until something in it is shown
      if (g.end == null) { if (n > 0 || lines.length > 0) hide(cursor, null) } else if (cursor <= g.end) hide(cursor, g.end)
      if (tail) continue
      // the hunk header stays when nothing can be expanded above it
      if (!headed && (size === 0 || !canExpand)) out.push({ k: 'head', a: 1, b: 0, hunk: hunks[i], last: false, bare: true })
      const marks = new Map<number, CharRange[]>()
      for (const [d, a] of pairHunkLines(hunks[i].lines)) {
        const w = wordDiffRanges(hunks[i].lines[d].text, hunks[i].lines[a].text)
        if (w.old.length) marks.set(d, w.old)
        if (w.new.length) marks.set(a, w.new)
      }
      const ls = hunks[i].lines
      const cell = (k: number): NonNullable<Cell> => ({ l: ls[k], marks: marks.get(k) ?? [] })
      if (!split) { ls.forEach((_, k) => out.push({ k: 'line', cell: cell(k) })); continue }
      for (let k = 0; k < ls.length;) {
        if (ls[k].kind === '') { out.push({ k: 'pair', left: cell(k), right: cell(k) }); k++; continue }
        const dels: number[] = []; const adds: number[] = []
        while (k < ls.length && ls[k].kind === 'del') dels.push(k++)
        while (k < ls.length && ls[k].kind === 'add') adds.push(k++)
        for (let p = 0; p < Math.max(dels.length, adds.length); p++) out.push({ k: 'pair', left: p < dels.length ? cell(dels[p]) : null, right: p < adds.length ? cell(adds[p]) : null })
      }
    }
    return out
    // gapRange closes over geos/total, which are in the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunks, geos, shown, cache, total, split, canExpand])

  if (items.length === 0 && lost.length === 0) return null
  return (
    <>
      {items.length > 0 && (
        <div className={'diff ' + (split ? 'split' : 'unified')} role="table" aria-label={`Diff of ${path}`}>
          {items.map((it, i) => {
            if (it.k === 'head') {
              const len = it.b == null ? null : it.b - it.a + 1
              const small = len != null && len > 0 && len <= STEP
              const b = it.b
              return (
                <div key={i} className={'dr head' + (it.hunk ? '' : ' tail')}>
                  <span className="expanders">
                    {!it.bare && small && b != null && <button className="expander" disabled={busy} title="Expand all hidden lines" aria-label="Expand all hidden lines" onClick={() => void fetchLines(it.a, b)}><Icon name="unfold" size={14} /></button>}
                    {!it.bare && !small && it.a > 1 && <button className="expander" disabled={busy} title="Expand down" aria-label="Expand down" onClick={() => void fetchLines(it.a, b == null ? it.a + STEP - 1 : Math.min(b, it.a + STEP - 1))}><Icon name="arrowDown" size={14} /></button>}
                    {!it.bare && !small && !it.last && b != null && <button className="expander" disabled={busy} title="Expand up" aria-label="Expand up" onClick={() => void fetchLines(Math.max(it.a, b - STEP + 1), b)}><Icon name="arrowUp" size={14} /></button>}
                  </span>
                  <span className="head-text mono">{it.hunk ? `${it.hunk.range} ${it.hunk.header}` : ''}</span>
                </div>
              )
            }
            if (it.k === 'line') {
              const l = it.cell.l
              const side: 'old' | 'new' = l.kind === 'del' ? 'old' : 'new'
              const any = lineKeys(path, l).some((k) => all.has(k) || composer === k)
              const cls = (l.kind || 'ctx') + (l.origin && l.origin !== 'committed' ? ' o-' + l.origin : '')
              return (
                <div key={i} className="dr-wrap">
                  <div className={'dr' + (it.ctx ? ' expanded' : '')}>
                    <span className={'ln ' + cls} title={l.origin && l.origin !== 'committed' ? `Uncommitted — ${l.origin}` : undefined}>{l.kind === 'add' ? '' : (l.old ?? '')}</span>
                    <span className={'ln ' + cls}>{l.kind === 'del' ? '' : (l.new ?? '')}</span>
                    <Half path={path} l={l} side={side} lang={lang} marks={it.cell.marks} onAdd={onAdd} bare />
                  </div>
                  {any && (
                    <div className="dr-threads">
                      {threadsAt(path, l, side, all, composer)}
                      {l.kind === '' && threadsAt(path, l, 'old', all, composer)}
                    </div>
                  )}
                </div>
              )
            }
            const L = it.left?.l ?? null; const R = it.right?.l ?? null
            const lt = threadsAt(path, L, 'old', all, composer); const rt = threadsAt(path, R, 'new', all, composer)
            return (
              <div key={i} className="dr-wrap">
                <div className={'dr' + (it.ctx ? ' expanded' : '')}>
                  <Half path={path} l={L} side="old" lang={lang} marks={it.left?.marks ?? []} onAdd={onAdd} />
                  <Half path={path} l={R} side="new" lang={lang} marks={it.right?.marks ?? []} onAdd={onAdd} />
                </div>
                {(lt || rt) && <div className="dr-threads two"><div>{lt}</div><div>{rt}</div></div>}
              </div>
            )
          })}
        </div>
      )}
      {lost.length > 0 && (
        <div className="unplaced" data-gr="line-gone">
          <div className="unplaced-head">Outdated — the line {lost.length === 1 ? 'this was' : 'these were'} written on no longer reads the same</div>
          {lost.map((c) => <Thread key={c.id} c={c} showAnchor />)}
        </div>
      )}
    </>
  )
})

// A diff is held back behind "Load diff" when it is large (by lines, or by size: a few
// lines can still be megabytes), or generated and more than a screenful: named like
// build output or a lockfile, or carrying a line no person wrote. A small file under
// such a path, or one long line in a short file, renders as usual. Its comments stay reachable: the prompt counts them,
// and focusing one loads the diff.
const LARGE = 1500
const LARGE_CHARS = 300_000
const LONG_LINE = 5000
/** A generated file smaller than this is rendered like any other: holding it saves nothing. */
const GENERATED_HELD = 20_000
const GENERATED = /(^|\/)(dist|node_modules|vendor)\/|\.min\.[a-z]+$|\.map$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum)$/
const sizeText = (chars: number): string => (chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} MB` : chars >= 1000 ? `${Math.round(chars / 1000)} KB` : `${chars} B`)

/** A changed file, in the shape of a GitHub "Files changed" box. */
export function FileBox({ file, split, section, sectionNo, grouped, note, whitespaceOnly }: {
  file: FileDiff; split: boolean; section?: Section; note?: string
  /** the section's position in the walkthrough: picks its colour */
  sectionNo?: number
  /** the file sits under its section's header, which already says what it belongs to */
  grouped?: boolean
  /** with whitespace hidden, nothing of this file's change is left */
  whitespaceOnly?: boolean
}) {
  const override = useStore((s) => s.fileOpen[file.path])
  const mode = useStore((s) => s.diffMode)
  const sinceKind = useStore((s) => s.loaded?.since?.kind ?? null)
  const composer = useStore((s) => s.composer)
  const index = useContext(CommentsCtx)
  const view = useStore((s) => s.loaded?.view)
  const signature = useStore((s) => s.loaded?.signature)
  const commitView = Boolean(view?.commit)
  const [notesOpen, setNotesOpen] = useState(true)
  const inPanel = useStore((s) => Boolean(section) && s.sectionPanel === section?.id)
  const loadLarge = useStore((s) => Boolean(s.fileLoaded[file.path]))
  const [expandAll, setExpandAll] = useState(0)
  const { setFileOpen, setFileLoaded, toggleViewed, toggleExcluded, set } = useStore.getState()

  const viewed = file.viewed === 'viewed'
  const changed = file.viewed === 'changed'
  const excluded = Boolean(file.excluded)
  const hunks = hunksForMode(file, mode)
  const size = useMemo(() => {
    let lines = 0; let chars = 0; let longest = 0
    for (const h of hunks) for (const l of h.lines) { lines++; chars += l.text.length; if (l.text.length > longest) longest = l.text.length }
    return { lines, chars, longest }
  }, [hunks])
  const generated = !file.binary && (GENERATED.test(file.path) || size.longest > LONG_LINE)
  const large = size.lines > LARGE || size.chars > LARGE_CHARS
  const held = (large || (generated && size.chars > GENERATED_HELD)) && hunks.length > 0 && !loadLarge
  const open = override ?? (!viewed && !excluded)
  // in a since-view, a file with no since-diff at all is unchanged since that baseline
  const unchangedSince = !file.untracked && ((mode === 'since' && file.sinceHunks === undefined) || (mode === 'viewed' && file.sinceViewedHunks === undefined))
  const fileKey = `file:${file.path}`
  const mixed = useMemo(() => [...new Set(file.hunks.flatMap((h) => h.lines.map((l) => l.origin)).filter((x) => x === 'staged' || x === 'unstaged'))], [file.hunks])

  const textFile = !file.binary && (file.status === 'modified' || file.status === 'renamed')
  // lines outside the hunks can be read and shown (not in a since-view or a commit view:
  // their line numbers belong to another diff)
  const canExpand = mode === 'all' && !commitView && textFile

  // Where each comment on this file goes. `placed`: on a rendered hunk line that still
  // reads what the comment was written on. `outside`: on a line of the file that is not
  // in the rendered hunks — the diff body fetches and shows it in place. `gone`: the
  // server says the line no longer exists. `hidden`: this view cannot show the line.
  const { placed, outside, gone, hidden } = useMemo(() => {
    const placed = new Map<string, Comment[]>(); const outside: Comment[] = []; const gone: Comment[] = []; const hidden: Comment[] = []
    if (commitView) return { placed, outside, gone, hidden }
    const textsOf = (hs: Hunk[]): Map<string, string> => {
      const m = new Map<string, string>()
      for (const h of hs) for (const l of h.lines) for (const k of lineKeys(file.path, l)) m.set(k, l.text)
      return m
    }
    const rendered = textsOf(hunks)
    const full = hunks === file.hunks ? rendered : textsOf(file.hunks)
    const prefix = `diff:${file.path}:`
    for (const [k, list] of index) {
      if (!k.startsWith(prefix)) continue
      for (const c of list) {
        if (c.anchor.kind !== 'diff' || c.anchor.file !== file.path) continue
        const text = rendered.get(k)
        if (c.lineGone) gone.push(c)
        else if (text !== undefined && (!c.anchor.lineContent || c.anchor.lineContent === text)) placed.set(k, [...(placed.get(k) ?? []), c])
        else if (text !== undefined) gone.push(c)
        else if (canExpand) outside.push(c)
        else if (full.has(k) || c.anchor.outside) hidden.push(c)
        else gone.push(c)
      }
    }
    return { placed, outside, gone, hidden }
  }, [hunks, index, file.path, file.hunks, canExpand, commitView])

  const labels: { text: string; cls?: string; title?: string }[] = []
  if (whitespaceOnly) labels.push({ text: 'Whitespace only', title: 'Every change in this file is whitespace, which is hidden' })
  if (file.status === 'added' && !file.untracked) labels.push({ text: 'Added', cls: 'ok' })
  if (file.status === 'deleted') labels.push({ text: 'Deleted', cls: 'bad' })
  if (file.status === 'renamed') labels.push({ text: 'Renamed' })
  if (file.untracked) labels.push({ text: 'Untracked', cls: 'warn', title: 'Not tracked by git yet' })
  if (file.binary) labels.push({ text: 'Binary' })
  if (file.modeChange) labels.push({ text: `Mode ${file.modeChange.from} → ${file.modeChange.to}`, title: 'File mode changed' })
  if (file.conflict) labels.push({ text: 'Conflict', cls: 'bad', title: 'Unresolved merge conflict' })
  if (!file.untracked && mixed.length) labels.push({ text: mixed.length === 2 ? 'Staged + unstaged' : mixed[0] === 'staged' ? 'Staged' : 'Unstaged', cls: 'warn', title: 'Has uncommitted changes' })
  if (excluded) labels.push({ text: 'Left out', title: 'Not part of the review' })

  const allFiles = (openAll: boolean): void => {
    const files = useStore.getState().loaded?.files ?? []
    useStore.setState({ fileOpen: Object.fromEntries(files.map((f) => [f.path, openAll])) })
  }
  const expandable = canExpand && hunks.length > 0
  /** comments and questions on lines of a diff that is held back */
  const inside = held ? [...placed.values()].reduce((n, l) => n + l.length, 0) + outside.length : 0
  const body = <DiffBody key={`${signature}|${view?.ignoreWhitespace ? 'w' : ''}`} file={file} hunks={hunks} split={split} placed={placed} outside={outside} composer={commitView ? null : composer} canExpand={canExpand} readOnly={commitView} expandAll={expandAll} />

  return (
    <div className={'file' + (open ? ' open' : '') + (section && !grouped ? ' in-sec' : '')} style={section ? secStyle(sectionNo) : undefined} data-gr-file={file.path} data-gr-file-section={section?.id} data-gr-viewed={viewed ? 'true' : changed ? 'changed' : 'false'}>
      <div className="file-head">
        <button className="icon-btn" aria-expanded={open} aria-label={open ? 'Collapse file' : 'Expand file'} onClick={() => setFileOpen(file.path, !open)}>
          <Icon name={open ? 'chevDown' : 'chevRight'} />
        </button>
        <span className="mono file-path" title={file.path}>{file.oldPath && <span className="muted">{file.oldPath} → </span>}{file.path}</span>
        <CopyButton text={file.path} title="Copy path" />
        {expandable && open && !held && <button className="icon-btn" title="Expand all lines" aria-label="Expand all lines" onClick={() => setExpandAll((n) => n + 1)}><Icon name="unfold" /></button>}
        {section && !grouped && (
          <button className={'sec-chip' + (inPanel ? ' on' : '')} data-gr="section-chip" aria-pressed={inPanel} title={`Part of “${section.name}”${section.desc ? ` — ${section.desc}` : ''}\nClick to ${inPanel ? 'close' : 'read'} the section beside the code`} onClick={() => showSection(inPanel ? null : section.id)}>
            <span className="sec-dot" /><span className="clip">{section.name}</span>
          </button>
        )}
        <span className="grow" />
        {labels.map((l) => <span key={l.text} className={'label ' + (l.cls ?? '')} title={l.title}>{l.text}</span>)}
        {changed && <span className="label warn" title="Tick Viewed to mark it viewed as it is now">Changed since last view</span>}
        <DiffStat add={file.add} del={file.del} />
        {!excluded && (
          <label className={'viewed-box' + (viewed ? ' on' : '') + (commitView ? ' off' : '')} title={commitView ? 'Viewed marks apply to the whole comparison — show all changes to set them' : 'Mark this file viewed; it folds away and comes back if it changes'}>
            <input name="gr-field" type="checkbox" checked={viewed} disabled={commitView} onChange={() => void toggleViewed(file)} data-gr="viewed" /> Viewed
          </label>
        )}
        {!commitView && <button className="icon-btn" title="Comment on this file" aria-label="Comment on this file" onClick={() => { setFileOpen(file.path, true); set({ composer: fileKey }) }}><Icon name="comment" /></button>}
        <Menu label={<Icon name="kebab" />} className="icon-btn" title="More" align="right">
          {(close) => (
            <>
              <MenuItem onClick={() => { void navigator.clipboard?.writeText(file.path); close() }}>Copy path</MenuItem>
              {file.untracked && <MenuItem onClick={() => { void toggleExcluded(file); close() }}>{excluded ? 'Include in the review' : 'Leave out of the review'}</MenuItem>}
              <MenuItem onClick={() => { allFiles(false); close() }}>Collapse all files</MenuItem>
              <MenuItem onClick={() => { allFiles(true); close() }}>Expand all files</MenuItem>
            </>
          )}
        </Menu>
      </div>
      {open && (
        <div className="file-body">
          {note && (
            <div className={'notes' + (notesOpen ? ' open' : '')} data-gr="claude-notes">
              <button className="notes-head" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
                <Icon name={notesOpen ? 'chevDown' : 'chevRight'} size={12} /><span className="avatar agent sm" aria-hidden="true">C</span>Claude’s notes
              </button>
              {notesOpen && (
                <div className="notes-body"><Md text={note} /></div>
              )}
            </div>
          )}
          {!commitView && <CommentSlot anchor={{ kind: 'file', file: file.path }} k={fileKey} />}
          {unchangedSince ? (
            <div className="file-msg">{mode === 'viewed' ? 'No changes since you marked it viewed.' : `No changes since ${sinceKind === 'approved' ? 'the approved state' : 'the walkthrough'}.`}</div>
          ) : file.binary ? (
            <div className="file-msg">Binary file not shown.</div>
          ) : hunks.length === 0 ? (
            <>
            <div className="file-msg" data-gr="file-msg">
              {mode !== 'all' ? 'Changed, with no line changes to show.'
                : whitespaceOnly || (view?.ignoreWhitespace && textFile && !file.modeChange && file.status === 'modified') ? 'Whitespace-only changes.'
                : file.modeChange ? `File mode changed from ${file.modeChange.from} to ${file.modeChange.to}.`
                  : file.status === 'renamed' ? 'File renamed without changes.'
                    : file.status === 'deleted' ? 'Empty file removed.' : 'Empty file.'}
            </div>
            {body}
            </>
          ) : held ? (
            <div className="file-msg held" data-gr="diff-held" data-gr-held={generated ? 'generated' : 'large'}>
              <strong>{generated ? 'Generated file' : 'Large diff'}</strong>
              <span className="muted small">{generated ? 'Build output, lockfiles and minified code are not rendered by default' : 'Large diffs are not rendered by default'} — {plural(size.lines, 'line')}, {sizeText(size.chars)}.</span>
              <button className="btn sm" data-gr="load-diff" onClick={() => setFileLoaded(file.path)}>Load diff</button>
              {inside > 0 && <span className="small" data-gr="held-comments">{plural(inside, 'comment')} on its lines — loading the diff shows {inside === 1 ? 'it' : 'them'}.</span>}
            </div>
          ) : (
            body
          )}
          {gone.length > 0 && (
            <div className="unplaced" data-gr="line-gone">
              <div className="unplaced-head">Outdated — the line {gone.length === 1 ? 'this was' : 'these were'} written on is no longer in the comparison</div>
              {gone.map((c) => <Thread key={c.id} c={c} showAnchor />)}
            </div>
          )}
          {hidden.length > 0 && (
            <div className="unplaced" data-gr="line-hidden">
              <div className="unplaced-head">On lines this view hides — switch to “All changes”</div>
              {hidden.map((c) => <Thread key={c.id} c={c} showAnchor />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
