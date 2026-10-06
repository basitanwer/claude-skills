// A Markdown file read as a document, not as source lines: headings, lists, tables and
// code blocks are rendered, and the review still works on it. Every comment stays what it
// is everywhere else, a comment on a source line: a rendered block knows which lines of
// the file it was written on, the "+" on a block comments on its first line, and a thread
// on any of its lines shows under it. Nothing about anchors, the CLI or the session changes.
//
// The file's content is less trusted than Claude's narration (a diff can be somebody
// else's branch), so on top of what `Md` already refuses (raw HTML) nothing here loads
// anything: an image is shown as its text, never fetched, and a link that is not a full
// URL is shown as text, since it would lead to a path on the review server.
import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AnchorInput, Comment, FileDiff, Hunk } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { errText, plural } from '../util'
import { Composer, Thread } from './comments'
import { Icon, MD_SAFE } from './common'

export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

// ── which lines a rendered block stands for ───────────────────
/** As much of a hast node as is used here. */
interface HNode {
  type: string; tagName?: string; children?: HNode[]; value?: string
  position?: { start: { line: number }; end: { line: number } }
  properties?: Record<string, unknown>; data?: Record<string, unknown>
}
/** What can be commented on: the innermost of these that holds a line owns it. */
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'hr', 'li', 'blockquote'])
const HEADING = /^h[1-6]$/
export interface Removed { after: number; lines: string[] }
interface BlockOptions {
  total: number
  /** the document's lines, for what an unchanged line read before */
  lines: string[]
  /** two columns: what stood there before, and what stands there now */
  split: boolean
  /** lines the diff adds (absent: nothing is marked as changed) */
  added?: Set<number>
  removed: Removed[]
  /** lines that have to be on screen whatever is folded: a thread, a jump's target, a stretch the reviewer opened */
  keep: Set<number>
  /** fold the stretches the diff does not touch, as a source diff does */
  fold: boolean
}
/** A rehype plugin (so it needs no parser of its own). It gives every commentable block
 *  the source lines it owns, puts a marker where the diff removed lines, and, when
 *  folding, replaces each run of top-level blocks the change does not touch by one row. */
function mdBlocks(o: BlockOptions) {
  return (tree: HNode): void => {
    // A top-level line the parser keeps as it is (raw HTML, an HTML comment) is text, and
    // a block like any other: it is shown, it can be marked as changed and commented on.
    tree.children = (tree.children ?? []).map((c) => (c.type !== 'element' && c.position && c.value?.trim() ? { type: 'element', tagName: 'p', properties: {}, position: c.position, children: [c] } : c))
    const text = (l: number): boolean => Boolean(o.lines[l - 1]?.trim())
    const blocks: { node: HNode; s: number; e: number; own: number[]; near: number[] }[] = []
    const walk = (n: HNode): void => {
      if (n.type === 'element' && n.position && BLOCK.has(n.tagName ?? '')) blocks.push({ node: n, s: n.position.start.line, e: n.position.end.line, own: [], near: [] })
      for (const c of n.children ?? []) walk(c)
    }
    walk(tree)
    // blocks come in document order, an outer one before what it holds: the last to claim a line is the innermost
    const owner = new Array<number>(o.total + 2).fill(-1)
    blocks.forEach((b, i) => { for (let l = Math.max(1, b.s); l <= Math.min(b.e, o.total); l++) owner[l] = i })
    // A list item or a quote that only holds other blocks (its first line is a paragraph's)
    // is not something to comment on: what is left of it, the blank lines between them, is
    // nobody's, like any other blank line.
    blocks.forEach((b, i) => {
      if ((b.node.tagName === 'li' || b.node.tagName === 'blockquote') && owner[b.s] !== i) for (let l = b.s; l <= Math.min(b.e, o.total); l++) if (owner[l] === i) owner[l] = -1
    })
    for (let l = 1; l <= o.total; l++) if (owner[l] >= 0) blocks[owner[l]].own.push(l)
    // a line no block holds (a blank line, a link definition) goes with the block before it:
    // a thread on it shows there, but the line is not part of what the block says
    let last = owner.find((x, l) => l >= 1 && x >= 0) ?? -1
    for (let l = 1; l <= o.total; l++) { if (owner[l] >= 0) last = owner[l]; else if (last >= 0) blocks[last].near.push(l) }
    // changed: the diff adds one of its lines, or a line with text right after it that no block holds (a link definition)
    const adds = (b: { own: number[]; near: number[] }): boolean => Boolean(o.added) && (b.own.some((l) => o.added?.has(l)) || b.near.some((l) => o.added?.has(l) && text(l)))
    for (const b of blocks) if (b.own.length) b.node.data = { ...b.node.data, mdLines: b.own, mdNear: b.near, mdChanged: adds(b) }

    // The top level: where removed lines are shown, what is folded away and, side by side,
    // what stood there before.
    const tops = (tree.children ?? []).filter((c) => c.type === 'element' && c.position).map((node) => ({ node, s: node.position!.start.line, e: node.position!.end.line }))
    const loose = (tree.children ?? []).filter((c) => c.type === 'element' && !c.position)   // no place in the source (the footnotes): always shown, last
    const N = tops.length
    const any = (set: Set<number> | undefined, a: number, b: number): boolean => { if (set) for (let l = a; l <= b; l++) if (set.has(l)) return true; return false }
    // A run of removed lines belongs to a block, or stood between two. `inside`: the block
    // whose first new line replaces it, else the block it was taken out of. `gap[i]`: it
    // stood on its own before block i (gap[N]: after the last one), a whole paragraph or section.
    const inside: Removed[][] = tops.map(() => [])
    const gap: Removed[][] = Array.from({ length: N + 1 }, () => [])
    for (const r of o.removed) {
      const holds = (l: number): number => tops.findIndex((t) => t.s <= l && l <= t.e)
      const i = o.added?.has(r.after + 1) && holds(r.after + 1) >= 0 ? holds(r.after + 1) : holds(r.after)
      if (i >= 0) inside[i].push(r)
      else gap[tops.filter((t) => t.s <= r.after).length].push(r)
    }
    // touched: lines added in it, or lines with text added between it and the next block, or lines taken out of it
    const changed = tops.map((t, i) => {
      if (inside[i].length > 0 || any(o.added, t.s, t.e)) return true
      for (let l = t.e + 1; l < (tops[i + 1]?.s ?? o.total + 1); l++) if (o.added?.has(l) && text(l)) return true
      return false
    })
    // a block that lost lines says so itself (a list does through the item that went)
    tops.forEach((t, i) => { if (inside[i].length && t.node.data?.mdLines) t.node.data.mdChanged = true })
    const list = (n: HNode): boolean => n.tagName === 'ul' || n.tagName === 'ol'
    /** lines that stood inside a code block or a table are shown as written: on their own they are not Markdown */
    const literal = (n: HNode): boolean => n.tagName === 'pre' || n.tagName === 'table'
    /** In one column, an item that was removed from a list is shown where it stood. */
    const intoList = (n: HNode, r: Removed): void => {
      const items = n.children ?? []
      let at = 0
      items.forEach((c, k) => { if (c.type === 'element' && c.position && c.position.start.line <= r.after) at = k + 1 })
      n.children = [...items.slice(0, at), { type: 'element', tagName: 'li', properties: {}, children: [], data: { mdRemoved: r.lines } }, ...items.slice(at)]
    }
    const show = tops.map((t, i) => !o.fold || changed[i] || Boolean(changed[i - 1]) || Boolean(changed[i + 1]) || gap[i].length > 0 || gap[i + 1].length > 0
      // up to where the next block starts: a line between two blocks belongs to the first
      || any(o.keep, t.s, (tops[i + 1]?.s ?? o.total + 1) - 1))
    // what is shown keeps the heading it stands under, so that it can be placed
    if (o.fold) tops.forEach((t, i) => { if (show[i] && !HEADING.test(t.node.tagName ?? '')) for (let j = i - 1; j >= 0; j--) if (HEADING.test(tops[j].node.tagName ?? '')) { show[j] = true; break } })
    const mark = (data: Record<string, unknown>, children: HNode[] = []): HNode => ({ type: 'element', tagName: 'div', properties: {}, children, data })
    /** a row of the side-by-side view: what stood there, and what stands there now */
    const row = (kind: string, was: HNode[], now: HNode[]): HNode => mark({ mdRow: kind }, [mark({ mdCell: was.length ? 'old' : 'old empty' }, was), mark({ mdCell: now.length ? 'new' : 'new empty' }, now)])
    /** the same block for the other side: read, not commented on */
    const copy = (n: HNode): HNode => {
      const c = structuredClone(n)
      const strip = (x: HNode): void => { if (x.data) { delete x.data.mdLines; delete x.data.mdNear } for (const k of x.children ?? []) strip(k) }
      strip(c)
      return c
    }
    const out: HNode[] = []
    const fold: { run: { from: number; to: number } | null } = { run: null }
    const close = (): void => { if (fold.run) out.push(mark({ mdFold: fold.run })); fold.run = null }
    const gone = (r: Removed): HNode => (o.split ? row('removed', [mark({ mdOld: r.lines })], []) : mark({ mdRemoved: r.lines }))
    for (let i = 0; i < N; i++) {
      if (!show[i]) { fold.run = { from: fold.run?.from ?? tops[i].s, to: (tops[i + 1]?.s ?? o.total + 1) - 1 }; continue }
      close()
      for (const r of gap[i]) out.push(gone(r))
      if (!o.split) {
        // above the block they were taken out of; under it when it was its last lines that went
        const t = tops[i]
        if (list(t.node)) for (const r of inside[i]) intoList(t.node, r)
        else for (const r of inside[i]) if (r.after < t.e) out.push(mark({ mdRemoved: r.lines, mdLiteral: literal(t.node) }))
        out.push(t.node)
        if (!list(t.node)) for (const r of inside[i]) if (r.after >= t.e) out.push(mark({ mdRemoved: r.lines, mdLiteral: literal(t.node) }))
        continue
      }
      if (!changed[i]) { out.push(row('', [copy(tops[i].node)], [tops[i].node])); continue }
      // side by side, blocks that changed one after the other are one row: on the left the
      // lines as they were (what did not change, and what was removed, each in its place)
      let j = i
      while (j + 1 < N && changed[j + 1]) j++
      const runs = [...tops.slice(i, j + 1).flatMap((_, k) => inside[i + k]), ...tops.slice(i + 1, j + 1).flatMap((_, k) => gap[i + 1 + k])]
      const was: string[] = []
      const put = (after: number): void => { for (const r of runs) if (r.after === after) was.push(...r.lines) }
      put(tops[i].s - 1)
      for (let l = tops[i].s; l <= tops[j].e; l++) { if (!o.added?.has(l)) was.push(o.lines[l - 1] ?? ''); put(l) }
      out.push(row('changed', was.some((l) => l.trim()) ? [mark({ mdOld: was })] : [], tops.slice(i, j + 1).map((t) => t.node)))
      i = j
    }
    close()
    for (const r of gap[N]) out.push(gone(r))
    tree.children = [...out, ...loose]
  }
}

// ── what a block needs to know about the review ───────────────
interface DocCtx {
  keyOf(line: number): string
  anchorOf(line: number): AnchorInput
  added?: Set<number>
  threads: Map<number, Comment[]>
  readOnly: boolean
  onHover?(key: string | null): void
  unfold(from: number, to: number): void
}
const Ctx = createContext<DocCtx | null>(null)

/** A block that owns lines: its mark when the change touched it, the "+" that comments on
 *  it, and under it the threads on its lines. */
function Owned({ tag, own, near, changed, rest, children }: {
  tag: string
  /** the lines the block was written on, and the lines after it that no block holds */
  own: number[]; near: number[]
  /** the diff touched it */
  changed: boolean
  rest: Record<string, unknown>; children: ReactNode
}) {
  const ctx = useContext(Ctx)!
  const first = own[0]
  const lines = near.length ? [...own, ...near] : own
  // the line of this block a comment is being written on, if any
  const composing = useStore((s) => (s.composer ? lines.find((l) => ctx.keyOf(l) === s.composer) ?? null : null))
  const threads = lines.flatMap((l) => ctx.threads.get(l) ?? [])
  const key = ctx.keyOf(first)
  const Tag = tag as 'div'
  const tools = !ctx.readOnly && (
    <button className="md-add" title="Comment on this (c)" aria-label={`Comment on line ${first}`} onClick={() => useStore.getState().set({ composer: key })}><Icon name="plus" size={12} /></button>
  )
  const under = (threads.length > 0 || composing != null) && (
    <div className="md-threads">
      {threads.map((c) => <Thread key={c.id} c={c} />)}
      {composing != null && <Composer anchor={ctx.anchorOf(composing)} k={ctx.keyOf(composing)} />}
    </div>
  )
  const attrs = {
    'data-md-lines': lines.join(' '), 'data-md-changed': changed ? 'true' : undefined,
    // the innermost block under the pointer is the one the "c" key comments on
    onMouseOver: ctx.readOnly ? undefined : (e: { stopPropagation(): void }) => { e.stopPropagation(); ctx.onHover?.(key) }
  }
  const cls = 'md-block' + (changed ? ' changed' : '')
  // a list item and a quote hold their tools themselves: a wrapper would break the list
  if (tag === 'li' || tag === 'blockquote') return <Tag {...rest} {...attrs} className={[rest.className, cls].filter(Boolean).join(' ')}>{tools}{children}{under}</Tag>
  return <div {...attrs} className={cls}>{tools}<Tag {...rest}>{children}</Tag>{under}</div>
}
const block = (tag: string) => function MdBlock({ node, children, ...rest }: { node?: unknown; children?: ReactNode }) {
  const data = (node as HNode | undefined)?.data
  const own = data?.mdLines as number[] | undefined
  const ctx = useContext(Ctx)
  const Tag = tag as 'div'
  // an item the diff removed from a list, shown where it stood
  if (Array.isArray(data?.mdRemoved)) return <li className="md-removed-item"><Gone lines={data.mdRemoved as string[]} /></li>
  if (!ctx || !own?.length) return <Tag {...rest}>{children}</Tag>
  return <Owned tag={tag} own={own} near={(data?.mdNear as number[] | undefined) ?? []} changed={Boolean(data?.mdChanged)} rest={rest}>{children}</Owned>
}
/** Markdown that is only read: a quoted piece of a file. Rendered with the same care as
 *  the document itself (no image is fetched, only a full address is a link). */
function Quoted({ text }: { text: string }) {
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_SAFE as unknown as Components}>{text}</ReactMarkdown></div>
}
/** Lines of the document as they were. Rendered when they can stand on their own; shown
 *  as written when they cannot: rows of a table without its head, part of a fence, link
 *  definitions (which render as nothing), or lines out of a code block or a table. */
function Was({ lines, literal }: { lines: string[]; literal?: boolean }) {
  const table = lines.some((l) => /^\s*\|/.test(l)) && !lines.some((l) => /^\s*\|?\s*:?-{3,}/.test(l))
  const fence = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length % 2 === 1
  const defs = lines.every((l) => !l.trim() || /^\s{0,3}\[[^\]]+\]:\s/.test(l))
  const front = lines[0]?.trim() === '---'
  if (literal || table || fence || defs || front) return <pre className="md-removed-src">{lines.join('\n')}</pre>
  // an item from deep in a list is indented: on its own that would read as code
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
  return <Quoted text={lines.map((l) => l.slice(Math.min(indent, l.length))).join('\n')} />
}
/** Lines the diff removed, where they stood. */
function Gone({ lines, literal }: { lines: string[]; literal?: boolean }) {
  return (
    <details className="md-removed" data-gr="md-removed" open={lines.length <= 12}>
      <summary>Removed here · {plural(lines.length, 'line')}</summary>
      <Was lines={lines} literal={literal} />
    </details>
  )
}
/** What the plugin puts in: a folded stretch, lines the diff removed, and the rows and
 *  cells of the side-by-side view. */
function Marker({ node, children, ...rest }: { node?: unknown; children?: ReactNode }) {
  const ctx = useContext(Ctx)
  const data = (node as HNode | undefined)?.data
  const fold = data?.mdFold as { from: number; to: number } | undefined
  if (ctx && fold) {
    return (
      <button className="md-fold" data-gr="md-fold" data-md-fold={`${fold.from}-${fold.to}`} title="Show this part of the document" onClick={() => ctx.unfold(fold.from, fold.to)}>
        <Icon name="unfold" size={14} />{fold.to > fold.from ? `Lines ${fold.from}–${fold.to}` : `Line ${fold.from}`} · not changed
      </button>
    )
  }
  if (Array.isArray(data?.mdRemoved)) return <Gone lines={data.mdRemoved as string[]} literal={Boolean(data.mdLiteral)} />
  if (Array.isArray(data?.mdOld)) return <Was lines={data.mdOld as string[]} />
  if (typeof data?.mdRow === 'string') return <div className={'md-row' + (data.mdRow ? ' ' + data.mdRow : '')} data-gr="md-row" data-md-row={data.mdRow || 'same'}>{children}</div>
  if (typeof data?.mdCell === 'string') return <div className={'md-cell ' + data.mdCell}>{children}</div>
  return <div {...rest}>{children}</div>
}
const COMPONENTS = {
  ...Object.fromEntries([...BLOCK].map((t) => [t, block(t)])),
  div: Marker,
  ...MD_SAFE
} as unknown as Components

/** Front matter (`---` … `---` at the very top) would read as a rule and a heading: show
 *  it as the block of settings it is. The line count stays the same. */
function frontMatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== '---') return lines
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'))
  if (end < 0) return lines
  const out = [...lines]
  out[0] = '```yaml'; out[end] = '```'
  return out
}

/** A Markdown document, rendered, with review comments on its blocks. */
export const MdDoc = memo(function MdDoc({ lines, keyOf, anchorOf, added, removed, threads, readOnly, fold, split, reveal, onHover, side }: {
  lines: string[]
  /** the comment key and the anchor of one of its lines */
  keyOf(line: number): string
  anchorOf(line: number): AnchorInput
  added?: Set<number>
  removed?: Removed[]
  /** the threads to show, by the line each was written on */
  threads: Map<number, Comment[]>
  readOnly?: boolean
  fold?: boolean
  /** side by side: on the left what the changed parts read before (needs `added` and `removed`) */
  split?: boolean
  /** a line a jump is heading for: whatever hides it gives way */
  reveal?: number | null
  onHover?(key: string | null): void
  side?: 'new' | 'old'
}) {
  const [opened, setOpened] = useState<[number, number][]>([])
  const [whole, setWhole] = useState(false)
  const [sought, setSought] = useState<number[]>([])
  if (reveal != null && !sought.includes(reveal)) setSought([...sought, reveal])
  const folding = Boolean(fold) && !whole
  const shown = useMemo(() => frontMatter(lines), [lines])
  const text = useMemo(() => shown.join('\n'), [shown])
  const opts = useMemo<BlockOptions>(() => {
    const keep = new Set<number>([...threads.keys(), ...sought])
    for (const [a, b] of opened) for (let l = a; l <= b; l++) keep.add(l)
    return { total: shown.length, lines: shown, split: Boolean(split), added, removed: removed ?? [], keep, fold: folding }
  }, [shown, split, added, removed, threads, sought, opened, folding])
  const ctx = useMemo<DocCtx>(() => ({
    keyOf, anchorOf, added, threads, readOnly: Boolean(readOnly), onHover,
    unfold: (from, to) => setOpened((o) => [...o, [from, to]])
  }), [keyOf, anchorOf, added, threads, readOnly, onHover])
  // parsed again only when the text or what is shown of it changes, not when a comment box opens
  const body = useMemo(() => <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[mdBlocks, opts]]} components={COMPONENTS}>{text}</ReactMarkdown>, [text, opts])
  return (
    <Ctx.Provider value={ctx}>
      <div className={'md md-doc' + (split ? ' split' : '')} data-gr="md-doc" data-md-side={side ?? 'new'} data-md-split={split ? 'true' : undefined} onMouseLeave={() => onHover?.(null)}>
        {fold && (
          <div className="md-bar small">
            {split && <span className="md-sides"><span>Before</span><span>After</span></span>}
            {folding ? 'Showing what changed, with what is around it.' : 'Showing the whole document.'}
            <button className="link small" data-gr="md-whole" onClick={() => setWhole(!whole)}>{folding ? 'Show the whole document' : 'Show only what changed'}</button>
          </div>
        )}
        {lines.length ? body : <div className="file-msg">Empty document.</div>}
      </div>
    </Ctx.Provider>
  )
})

// ── a changed Markdown file, in Files changed ─────────────────
const ALL = 1_000_000
/** Longer than this is read as source: nobody reviews it as a page, and rendering it is slow. */
const MAX_LINES = 6000
/** What the diff says about the new side of a file: the lines it adds, and the runs of
 *  lines it removes, each with the new-side line it comes after. */
function changes(hunks: Hunk[]): { added: Set<number>; removed: Removed[] } {
  const added = new Set<number>(); const removed: Removed[] = []
  for (const h of hunks) {
    let last = Number(/\+(\d+)/.exec(h.range)?.[1] ?? 1) - 1
    let run: Removed | null = null
    for (const l of h.lines) {
      if (l.kind === 'del') { if (!run) removed.push(run = { after: last, lines: [] }); run.lines.push(l.text); continue }
      run = null
      if (l.new != null) { last = l.new; if (l.kind === 'add') added.add(l.new) }
    }
  }
  return { added, removed }
}

/** The body of a file box for a Markdown file shown rendered. An added file is rendered
 *  whole from the diff itself, a deleted one as it was; of a changed one the whole new
 *  side is read, the blocks the diff touched are marked, removed lines are shown where
 *  they were, and the rest folds away. */
export function MdFileBody({ file, hunks, split, comments, readOnly, stamp, onHover, onSource }: {
  file: FileDiff; hunks: Hunk[]
  /** the page shows diffs side by side: so is a changed document, before and after */
  split: boolean
  /** every comment and question on a line of this file that still has its line */
  comments: Comment[]
  readOnly: boolean
  /** changes when the code under review does */
  stamp: string
  onHover(key: string | null): void
  onSource(): void
}) {
  const path = file.path
  const side: 'new' | 'old' = file.status === 'deleted' ? 'old' : 'new'
  // Every line of an added or a deleted file is in its diff, when that is the diff of the
  // whole comparison. Otherwise (a changed file, or "since you last looked", which holds
  // only what changed since) the file is read.
  const whole = (file.status === 'added' || file.status === 'deleted') && hunks === file.hunks
  const inDiff = useMemo(() => (whole ? hunks.flatMap((h) => h.lines).filter((l) => (side === 'old' ? l.kind === 'del' : l.kind === 'add')).map((l) => l.text) : null), [whole, hunks, side])
  const [read, setRead] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (whole) return
    let live = true
    setRead(null); setError(null)
    void (async () => {
      try {
        // reading a file needs a saved review, as expanding a diff does
        const id = await useStore.getState().materialize()
        if (id == null) throw new Error('the review could not be saved')
        const r = await api.fileLines(id, path, 'new', 1, ALL)
        if (live) setRead(r.lines)
      } catch (e) { if (live) setError(errText(e)) }
    })()
    return () => { live = false }
  }, [whole, path, stamp])
  const lines = inDiff ?? read
  const reveal = useStore((s) => (s.reveal && s.reveal.side === side && (s.reveal.file === path || s.reveal.file === file.oldPath) ? s.reveal.line : null))
  const { added, removed } = useMemo(() => (whole ? { added: undefined, removed: [] } : changes(hunks)), [whole, hunks])
  const { threads, lost, other } = useMemo(() => {
    const threads = new Map<number, Comment[]>(); const lost: Comment[] = []; let other = 0
    for (const c of lines ? comments : []) {
      if (c.anchor.kind !== 'diff') continue
      if (c.anchor.side !== side) { other++; continue }
      const now = lines?.[c.anchor.line - 1]
      if (now === undefined || (c.anchor.lineContent && c.anchor.lineContent !== now)) lost.push(c)
      else threads.set(c.anchor.line, [...(threads.get(c.anchor.line) ?? []), c])
    }
    return { threads, lost, other }
  }, [comments, lines, side])
  const { keyOf, anchorOf } = useMemo(() => ({
    keyOf: (n: number): string => `diff:${path}:${side}:${n}`,
    anchorOf: (n: number): AnchorInput => ({ kind: 'diff', file: path, side, line: n, expect: lines?.[n - 1] })
  }), [path, side, lines])
  if (error) return <div className="file-msg" data-gr="md-error">This file could not be read to render it: {error} <button className="link" onClick={onSource}>Show the source diff</button></div>
  if (!lines) return <div className="file-msg"><span className="spinner" /> Reading the document…</div>
  if (lines.length > MAX_LINES) return <div className="file-msg" data-gr="md-long">{lines.length.toLocaleString()} lines is too long to render as a page. <button className="link" onClick={onSource}>Show the source diff</button></div>
  return (
    <>
      <MdDoc key={stamp} lines={lines} keyOf={keyOf} anchorOf={anchorOf} added={added} removed={removed} threads={threads} readOnly={readOnly} fold={!whole} split={split && !whole} reveal={reveal} onHover={onHover} side={side} />
      {other > 0 && (
        <div className="unplaced" data-gr="md-other-side">
          <span className="small">{plural(other, 'comment')} on removed lines {other === 1 ? 'is' : 'are'} in the source diff. </span>
          <button className="link small" onClick={onSource}>Show the source diff</button>
        </div>
      )}
      {lost.length > 0 && (
        <div className="unplaced" data-gr="line-gone">
          <div className="unplaced-head">Outdated — the line {lost.length === 1 ? 'this was' : 'these were'} written on reads differently now</div>
          {lost.map((c) => <Thread key={c.id} c={c} showAnchor />)}
        </div>
      )}
    </>
  )
}
