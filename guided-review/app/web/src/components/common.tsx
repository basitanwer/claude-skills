import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FocusTarget, Presence, RefOptions } from '@shared/types'
import { api } from '../api'
import { highlightBlock } from '../highlight'
import { useStore } from '../store'
import { tourStop } from '../focus'
import { short, type Guide } from '../util'

// ── the Guide a thing is drawn in ─────────────────────────────
/** The Guide a component is drawn in (null: it is in the Code pane or the top bar). A jump
 *  to code made from inside a Guide is a pick; one made anywhere else is not. */
export const GuideCtx = createContext<Guide | null>(null)
/** For a link to code inside a Guide: the Guide it is in (to hand to the jump) and whether
 *  its target is the pick, to mark it as such. */
export function usePickLink(t: FocusTarget | null): { from: Guide | null; picked: boolean } {
  const from = useContext(GuideCtx)
  const picked = useStore((s) => {
    // (each Guide keeps its own pick outlined, whatever was picked elsewhere since)
    // (in the Walkthrough, whose own pick is the open section, a link is marked while the code follows it)
    const p = from === 'walkthrough' ? s.pick ?? undefined : from ? s.picks[from] : undefined
    // (a link to a section, in another Guide than the Walkthrough, is that Guide's pick while the section is)
    if (from && from !== 'walkthrough' && t?.kind === 'section') return p != null && 'section' in p && p.section === t.sectionId
    if (!from || !t || !p || !('file' in p) || 'section' in p || (t.kind !== 'file' && t.kind !== 'diff') || p.file !== t.file) return false
    return t.kind === 'file' ? p.line == null : p.line === t.line && (p.side ?? 'new') === t.side
  })
  return { from, picked }
}

// ── markdown ──────────────────────────────────────────────────
/** Prose written by Claude Code or the reviewer, and lines quoted from a file. Raw HTML
 *  in the source is not rendered (react-markdown's default), so it can never inject markup. */
/** Code in Markdown: a fenced block is highlighted, a word of code is left as it is. */
export function MdCode({ className: cn, children }: { className?: string; children?: ReactNode }) {
  const src = String(children ?? '')
  const lang = /language-([\w+-]+)/.exec(cn ?? '')?.[1] ?? null
  if (lang || src.includes('\n')) {
    return <code className="hl" dangerouslySetInnerHTML={{ __html: highlightBlock(src.replace(/\n$/, ''), lang) }} />
  }
  return <code>{children}</code>
}
const SCHEME = /^(https?:|mailto:)/i
/** A link in Markdown. Only a full web or mail address is one: anything else (a path, a
 *  fragment, another scheme) would lead to an address on the review server, or run. */
export function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  return SCHEME.test(href ?? '')
    ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
    : <span className="md-rel" title={href ? `Links to ${href} (not followed from the review)` : undefined}>{children}</span>
}
/** An image in Markdown is described, never fetched: text that comes from a diff or from a
 *  session that read one must not make the reviewer's browser call out. */
export function MdImg({ src, alt }: { src?: string; alt?: string }) {
  return <span className="md-img" title="Images are not loaded in a review">Image{alt ? `: ${alt}` : ''}{src ? <span className="mono"> {String(src)}</span> : null}</span>
}
/** What every piece of Markdown on the page is rendered with. */
export const MD_SAFE = { a: MdLink, img: MdImg, code: MdCode }
export const Md = memo(function Md({ text, className }: { text: string; className?: string }) {
  return (
    <div className={'md' + (className ? ' ' + className : '')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MD_SAFE}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export function Badge({ tone, children, title }: { tone?: 'ok' | 'warn' | 'bad' | 'accent' | 'muted'; children: ReactNode; title?: string }) {
  return <span className={'badge' + (tone ? ' ' + tone : '')} title={title}>{children}</span>
}

// ── toasts / status ───────────────────────────────────────────
export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  const status = useStore((s) => s.status)
  if (toasts.length === 0 && !status) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {status && <div className="toast info" data-gr="status"><span className="toast-text">{status}</span></div>}
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} data-gr="toast">
          <span className="toast-text">{t.text}</span>
          {t.action && <button className="btn sm" data-gr="toast-action" onClick={() => { t.action?.run(); dismiss(t.id) }}>{t.action.label}</button>}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  )
}

// ── theme ─────────────────────────────────────────────────────
function storedTheme(): string | null {
  try { return localStorage.getItem('gr-theme') } catch { return null }
}
export function applyStoredTheme(): void {
  const t = storedTheme()
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
}
export function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme
  if (set === 'light' || set === 'dark') return set
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
export function setTheme(next: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = next
  try { localStorage.setItem('gr-theme', next) } catch { /* storage blocked — the choice lasts for this page */ }
  window.dispatchEvent(new window.Event(THEME_SET))
}
/** told to the window when the theme is chosen (the top bar's button and View settings both choose it) */
const THEME_SET = 'gr-theme-set'

// ── icons (16px, stroke = currentColor) ───────────────────────
const PATHS: Record<string, string> = {
  chevDown: 'M4 6l4 4 4-4', chevRight: 'M6 4l4 4-4 4', chevUp: 'M4 10l4-4 4 4',
  file: 'M4 1.75h5.5L13 5.25v9H4zM9.5 1.75v3.5H13', folder: 'M1.75 3.75h4l1.5 1.75h7v7.75H1.75z',
  comment: 'M2 2.75h12v8.5H8.5L5 14v-2.75H2z', gear: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  sidebar: 'M1.75 2.75h12.5v10.5H1.75zM6 2.75v10.5', copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8', check: 'M3 8.5l3.2 3.2L13 5',
  kebab: 'M3 8h.01M8 8h.01M13 8h.01', plus: 'M8 3v10M3 8h10', x: 'M4 4l8 8M12 4l-8 8', filter: 'M2 4h12M4.5 8h7M7 12h2',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM11 11l3.5 3.5', commit: 'M1 8h4M11 8h4M8 5a3 3 0 100 6 3 3 0 000-6z',
  book: 'M2 2.75h5a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 007 11.75H2zM14 2.75H9.5A1.5 1.5 0 008 4.25v9a1.5 1.5 0 011.5-1.5H14z',
  arrowUp: 'M8 13V3M4 7l4-4 4 4', arrowDown: 'M8 3v10M4 9l4 4 4-4', unfold: 'M8 2v4M5.5 4L8 1.5 10.5 4M8 14v-4M5.5 12L8 14.5l2.5-2.5M2 8h12',
  graph: 'M2.5 2.5h4v3h-4zM9.5 10.5h4v3h-4zM2.5 10.5h4v3h-4zM4.5 5.5v5M6.5 4h5v6.5',
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  expand: 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9', columns: 'M1.75 2.75h12.5v10.5H1.75zM8 2.75v10.5',
  pin: 'M9.5 1.75l4.75 4.75-2.25.75-2.5 2.5.25 3-1.25 1.25-3-3-3.25 3.25M5.5 10.5l-3-3L3.75 6.25l3 .25 2.5-2.5z',
  arrowLeft: 'M13 8H3M7 4L3 8l4 4', repo: 'M3 1.75h10v12.5H3zM3 11h10M6 4.5h4', circle: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11z',
  pr: 'M4 5v6M4 3.5a1 1 0 100-2 1 1 0 000 2zM4 14.5a1 1 0 100-2 1 1 0 000 2zM12 14.5a1 1 0 100-2 1 1 0 000 2zM12 12.5V7a2 2 0 00-2-2H8M9.5 3L7.5 5l2 2'
}
export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={'ico' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}

// ── file-type icons (16px) ────────────────────────────────────
// A two-letter badge for a language, a coloured glyph for markup, data and scripts, and
// the plain file icon for everything else. The colours are fixed, not theme tokens: each
// was picked to read on both the light and the dark background.
const BADGES: Record<string, [label: string, bg: string, fg: string]> = {
  js: ['JS', '#f0db4f', '#323330'], ts: ['TS', '#3178c6', '#fff'], py: ['PY', '#3572a5', '#fff'], go: ['GO', '#00a4cc', '#fff'],
  rs: ['RS', '#c8643a', '#fff'], rb: ['RB', '#cc342d', '#fff']
}
const GLYPHS: Record<string, [color: string, d: string]> = {
  css: ['#4a90d9', 'M6 2.5L4.5 13.5M11.5 2.5L10 13.5M2.5 6h11M2 10h11'],
  html: ['#e4572e', 'M5 4.5L1.5 8 5 11.5M11 4.5L14.5 8 11 11.5M9.25 3L6.75 13'],
  json: ['#c99a1c', 'M6 2.5c-1.5 0-2 .7-2 2v1.8c0 .9-.5 1.7-1.5 1.7 1 0 1.5.8 1.5 1.7v1.8c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.8c0 .9.5 1.7 1.5 1.7-1 0-1.5.8-1.5 1.7v1.8c0 1.3-.5 2-2 2'],
  md: ['#519aba', 'M1.5 11V5l2.75 3L7 5v6M12 5v6M9.75 8.75L12 11l2.25-2.25'],
  sh: ['#4eaa25', 'M2.5 4.5l4 3.5-4 3.5M8.5 12h5'],
  conf: ['#a074c4', 'M2 4.5h6M11 4.5h3M2 11.5h3M8 11.5h6M9.5 3a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM6.5 10a1.5 1.5 0 100 3 1.5 1.5 0 000-3z'],
  img: ['#a074c4', 'M2 3h12v10H2zM2 11l3.5-3.5L8 10l2-2 4 4M10.5 5.25a.75.75 0 100 1.5.75.75 0 000-1.5z']
}
/** The React mark, for .jsx and .tsx. */
const ATOMS: Record<string, string> = { jsx: '#149eca', tsx: '#3178c6' }
const KINDS: Record<string, string> = {
  mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', scss: 'css', sass: 'css', less: 'css', htm: 'html', vue: 'html', svelte: 'html', xml: 'html',
  jsonc: 'json', json5: 'json', markdown: 'md', mdx: 'md', bash: 'sh', zsh: 'sh', fish: 'sh', yml: 'conf', yaml: 'conf', toml: 'conf', ini: 'conf', env: 'conf',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', ico: 'img'
}
export function FileIcon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const kind = KINDS[ext] ?? ext
  const cls = 'ico' + (className ? ' ' + className : '')
  const badge = BADGES[kind]
  if (badge) {
    return (
      <svg className={cls} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-gr-filetype={kind}>
        <rect x="1" y="1" width="14" height="14" rx="3" fill={badge[1]} />
        <text x="8" y="11.1" textAnchor="middle" fontSize="7.6" fontWeight="700" fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif" fill={badge[2]}>{badge[0]}</text>
      </svg>
    )
  }
  if (ATOMS[kind]) {
    return (
      <svg className={cls} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={ATOMS[kind]} strokeWidth="1" aria-hidden="true" data-gr-filetype={kind}>
        {[0, 60, 120].map((a) => <ellipse key={a} cx="8" cy="8" rx="6.75" ry="2.6" transform={`rotate(${a} 8 8)`} />)}
        <circle cx="8" cy="8" r="1.2" fill={ATOMS[kind]} stroke="none" />
      </svg>
    )
  }
  const glyph = GLYPHS[kind]
  if (!glyph) return <Icon name="file" size={size} className={'muted' + (className ? ' ' + className : '')} />
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={glyph[0]} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-gr-filetype={kind}>
      <path d={glyph[1]} />
    </svg>
  )
}

/** GitHub's five-block diffstat: green and red in proportion, grey for the rest. */
export function DiffStat({ add, del, blocksOnly }: { add: number; del: number; blocksOnly?: boolean }) {
  const total = add + del
  const g = total === 0 ? 0 : Math.max(add > 0 ? 1 : 0, Math.round((add / total) * Math.min(5, total)))
  const r = total === 0 ? 0 : Math.min(5 - g, Math.max(del > 0 ? 1 : 0, Math.round((del / total) * Math.min(5, total))))
  return (
    <span className="diffstat" title={`${add} addition${add === 1 ? '' : 's'} & ${del} deletion${del === 1 ? '' : 's'}`}>
      {!blocksOnly && <><span className="plus">+{add}</span> <span className="minus">−{del}</span></>}
      <span className="blocks" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => <span key={i} className={i < g ? 'g' : i < g + r ? 'r' : ''} />)}
      </span>
    </span>
  )
}

export function CopyButton({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1400) }, () => { /* clipboard unavailable */ })
  }
  return <button className="icon-btn" title={done ? 'Copied' : title} aria-label={title} onClick={copy}><Icon name={done ? 'check' : 'copy'} /></button>
}

/** Keep an open popover inside the window: it hangs from its button, to the left or to the
 *  right, and on a narrow window (or from a button near an edge) that would put part of it
 *  off the page, where nothing scrolls to it. It is moved sideways by what it sticks out,
 *  inside the pane that would cut it off if it is in one, and made no taller than the room
 *  under its top: it scrolls inside itself. Fitted when it opens, and again when it or the
 *  window changes size. */
export function useFitted(pop: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) return
    const fit = (): void => {
      el.style.transform = ''
      el.style.maxWidth = ''
      el.style.maxHeight = ''
      let r = el.getBoundingClientRect()
      if (!r.width) return
      const pane = el.closest('[data-gr-scroll]')?.getBoundingClientRect()
      const lo = Math.max(8, (pane?.left ?? 0) + 4)
      const hi = Math.min(window.innerWidth - 8, (pane?.right ?? window.innerWidth) - 4)
      if (r.width > hi - lo) { el.style.maxWidth = `${Math.floor(hi - lo)}px`; r = el.getBoundingClientRect() }
      const by = r.right > hi ? Math.max(lo - r.left, hi - r.right) : r.left < lo ? lo - r.left : 0
      if (Math.abs(by) >= 1) el.style.transform = `translateX(${Math.round(by)}px)`
      // (in a pane, what is under the pane's edge is scrolled to with the pane)
      const room = window.innerHeight - r.top - 8
      if (!pane && r.height > room) el.style.maxHeight = `${Math.max(96, Math.floor(room))}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    window.addEventListener('resize', fit)
    return () => { ro.disconnect(); window.removeEventListener('resize', fit); el.style.transform = ''; el.style.maxWidth = ''; el.style.maxHeight = '' }
  }, [pop, open])
}

/** A button that opens a popover; closes on outside click and Escape. */
export function Menu({ label, title, className, align = 'left', children, hook, onOpen }: {
  label: ReactNode; title?: string; className?: string; align?: 'left' | 'right'; hook?: string; onOpen?: () => void
  children: ReactNode | ((close: () => void) => ReactNode)
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  useFitted(pop, open)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="menu" ref={box}>
      <button className={className ?? 'btn sm'} title={title} aria-haspopup="true" aria-expanded={open} data-gr={hook} onClick={() => { if (!open) onOpen?.(); setOpen(!open) }}>{label}</button>
      {open && <div className={'menu-pop ' + align} role="menu" ref={pop}>{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>}
    </div>
  )
}
export function MenuItem({ children, onClick, checked, disabled, danger, title }: { children: ReactNode; onClick: () => void; checked?: boolean; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button className={'menu-item' + (danger ? ' danger' : '')} role="menuitem" disabled={disabled} title={title} onClick={onClick}>
      <span className="menu-check">{checked ? <Icon name="check" size={14} /> : null}</span>{children}
    </button>
  )
}

// ── Claude Code presence ──────────────────────────────────────
const PRESENCE: Record<Presence, { label: string; title: string }> = {
  listening: { label: 'Claude Code is listening', title: 'A Claude Code session is waiting for requests from this page' },
  working: { label: 'Claude Code is working', title: 'A Claude Code session is active on this review' },
  away: { label: 'No Claude Code session is attached', title: 'Requests you make here wait until a Claude Code session picks them up' }
}
export function PresenceDot({ presence }: { presence: Presence }) {
  const p = PRESENCE[presence]
  return (
    <span className={'presence ' + presence} data-gr="presence" data-gr-presence={presence} title={p.title}>
      <span className="presence-dot" aria-hidden="true" />{p.label}
    </span>
  )
}
/** Shown beside anything that waits on Claude Code while no session is attached. */
export function AwayHint() {
  const away = useStore((s) => s.loaded?.presence === 'away')
  if (!away) return null
  return (
    <div className="away-hint small" data-gr="away-hint">
      Nothing is listening. In Claude Code run <code>/guided-review --resume</code> — it will pick this up.
    </div>
  )
}

// ── ref picker ────────────────────────────────────────────────
/** Branch / tag / commit / typed ref. A branch name follows its tip; anything else
 *  git can resolve (SHA, tag, HEAD~N) is frozen at that commit. */
export function RefPicker({ repo, value, onChange, relativeTo, label, placeholder, specials }: {
  repo: string; value: string; onChange: (v: string) => void; relativeTo?: string; label: string; placeholder?: string
  specials?: { value: string; note: string }[]
}) {
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState<RefOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const fieldId = useId()
  useEffect(() => {
    if (!open) return
    let live = true
    const none: RefOptions = { branches: [], tags: [], defaultBase: '', commits: [] }
    void api.refOptions(repo, relativeTo || undefined)
      .then((r) => { if (live) { setOpts(r); setError(null) } })
      .catch((e: unknown) => { if (live) { setOpts(none); setError(e instanceof Error ? e.message : String(e)) } })
    return () => { live = false }
  }, [open, repo, relativeTo])
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  const q = value.trim().toLowerCase()
  const hit = (s: string): boolean => !q || s.toLowerCase().includes(q)
  const branches = (opts?.branches ?? []).filter(hit)
  const tags = (opts?.tags ?? []).filter(hit).slice(0, 30)
  const commits = (opts?.commits ?? []).filter((c) => !q || c.sha.startsWith(q) || c.subject.toLowerCase().includes(q)).slice(0, 30)
  const special = (specials ?? []).filter((s) => hit(s.value) || hit(s.note))
  const pick = (v: string): void => { onChange(v); setOpen(false) }
  const nothing = opts && branches.length + tags.length + commits.length + special.length === 0
  return (
    <div className="refpick" ref={box}>
      <label className="field-label" htmlFor={fieldId}>{label}</label>
      <input id={fieldId} name="gr-field"
        value={value} placeholder={placeholder ?? 'branch, tag, SHA or HEAD~N'} spellCheck={false}
        onFocus={() => setOpen(true)} onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onKeyDown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') setOpen(false) }}
      />
      {open && (
        <div className="pop">
          {!opts && <div className="pop-note">Loading refs…</div>}
          {error && <div className="pop-note">The refs could not be listed ({error}). You can still type one.</div>}
          {nothing && !error && <div className="pop-note">No branch, tag or recent commit matches. Whatever you typed is used as a git ref.</div>}
          {branches.length > 0 && <div className="pop-head">Branches (follow the tip)</div>}
          {branches.map((b) => (
            <button key={'b' + b} className="pop-item" onMouseDown={(e) => { e.preventDefault(); pick(b) }}>
              <span className="mono">{b}</span>{b === opts?.defaultBase && <Badge tone="muted">default base</Badge>}
            </button>
          ))}
          {tags.length > 0 && <div className="pop-head">Tags (frozen)</div>}
          {tags.map((t) => (
            <button key={'t' + t} className="pop-item" onMouseDown={(e) => { e.preventDefault(); pick(t) }}><span className="mono">{t}</span></button>
          ))}
          {commits.length > 0 && <div className="pop-head">Recent commits (frozen)</div>}
          {commits.map((c) => (
            <button key={'c' + c.sha} className="pop-item" onMouseDown={(e) => { e.preventDefault(); pick(c.sha) }}>
              <span className="mono">{short(c.sha)}</span><span className="pop-sub">{c.subject}</span>
            </button>
          ))}
          {special.length > 0 && <div className="pop-head">Special</div>}
          {special.map((s) => (
            <button key={'s' + s.value} className="pop-item" onMouseDown={(e) => { e.preventDefault(); pick(s.value) }}>
              <span className="mono">{s.value}</span><span className="pop-sub">{s.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── tour stepper (ui:action tours, and tours opened from a chat answer) ──
export function TourBar() {
  const tour = useStore((s) => s.tour)
  const set = useStore((s) => s.set)
  if (!tour) return null
  const n = tour.stops.length
  const stop = tour.stops[tour.idx]
  const step = (d: number): void => {
    let idx = tour.idx + d
    if (idx < 0 || idx >= n) {
      if (!tour.loop) return
      idx = (idx + n) % n
    }
    tourStop(idx)
  }
  return (
    <div className="tourbar" data-gr="tour">
      <div className="tour-head">
        <strong>Tour</strong>
        <span className="muted">stop {tour.idx + 1} of {n}</span>
        <button className="icon-btn" aria-label="Close tour" onClick={() => set({ tour: null })}>×</button>
      </div>
      {stop.note && <div className="tour-note">{stop.note}</div>}
      <div className="row gap">
        <button className="btn sm" disabled={!tour.loop && tour.idx === 0} onClick={() => step(-1)}>Previous</button>
        <button className="btn sm" onClick={() => tourStop(tour.idx)}>Show again</button>
        <button className="btn sm primary" disabled={!tour.loop && tour.idx === n - 1} onClick={() => step(1)}>Next</button>
      </div>
    </div>
  )
}

export function ThemeToggle() {
  const [, bump] = useState(0)
  // (with no theme chosen the page follows the system's: when that changes under the page, so does what this button offers)
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-color-scheme: dark)')
    const on = (): void => bump((n) => n + 1)
    m?.addEventListener('change', on)
    window.addEventListener(THEME_SET, on)
    return () => { m?.removeEventListener('change', on); window.removeEventListener(THEME_SET, on) }
  }, [])
  const dark = currentTheme() === 'dark'
  return (
    <button className="icon-btn" title={dark ? 'Switch to light' : 'Switch to dark'} aria-label="Switch theme" onClick={() => { setTheme(dark ? 'light' : 'dark'); bump((n) => n + 1) }}>
      {dark ? '☀' : '☾'}
    </button>
  )
}
