import { useMemo, useState } from 'react'
import type { SessionListItem } from '@shared/types'
import { useStore } from '../store'
import { ago, baseName, EFFORT, effortTitle, plural, routeHash, short, SIDE_KIND, symLabel } from '../util'
import { Icon, Menu, MenuItem, RefPicker, ThemeToggle } from '../components/common'

export function TopBar({ crumbs }: { crumbs: { label: string; href?: string }[] }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/" title="All repositories"><span className="brand-mark" aria-hidden="true" /></a>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.length === 0 && <a className="strong" href="#/">Guided review</a>}
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span className="muted crumb-sep">/</span>}
            {c.href ? <a className={i === 0 ? 'strong' : ''} href={c.href}>{c.label}</a> : <span className="strong">{c.label}</span>}
          </span>
        ))}
      </nav>
      <span className="grow" />
      <ThemeToggle />
    </header>
  )
}

/** A saved review, as a row of GitHub's pull-request list. */
function SessionRow({ s, showRepo, onArchive }: { s: SessionListItem; showRepo?: boolean; onArchive?: (archived: boolean) => void }) {
  const cmp = SIDE_KIND[s.pair.compare.kind]
  return (
    <div className={'list-row' + (s.archived ? ' archived' : '')} data-gr-session={s.id}>
      {s.approved === 'yes' ? <span title="Approved"><Icon name="check" className="st-approved" /></span> : s.approved === 'stale' ? <span title="Changes since approval"><Icon name="pr" className="st-stale" /></span> : <span title="Open"><Icon name="pr" className={s.archived ? 'muted' : 'st-open'} /></span>}
      <div className="grow">
        <a className="row-title" href={routeHash({ name: 'review', session: s.id })}>{s.title || `${symLabel(s.pair.compare.symbol)} against ${symLabel(s.pair.base.symbol)}`}</a>
        {s.approved === 'yes' && <span className="label ok" data-gr="list-approved">Approved</span>}
        {s.approved === 'stale' && <span className="label warn" data-gr="list-approved">Changes since approval</span>}
        {s.archived && <span className="label">Archived</span>}
        {!s.hasWalkthrough && <span className="label" title="Claude Code has not written a walkthrough for it">No walkthrough</span>}
        {s.effort && <span className="label effort" data-gr="list-effort" title={effortTitle(s.effort)}>{s.effort}: {EFFORT[s.effort].sum}</span>}
        <div className="muted small">
          #{s.id}{showRepo && <> · <span className="mono">{baseName(s.repo)}</span></>} · <span className="mono">{symLabel(s.pair.base.symbol)} ← {symLabel(s.pair.compare.symbol)}</span>
          <span title={cmp.title}> · {cmp.label}</span>{s.direct && <span title="The two endpoints are compared directly"> · endpoints</span>} · updated {ago(s.updatedAt)}
        </div>
      </div>
      {s.pendingRequests > 0 && <span className="row-count" title="Asked of Claude Code and not done yet"><span className="spinner" />{s.pendingRequests}</span>}
      {s.unresolved > 0 && <span className="row-count" title={plural(s.unresolved, 'open comment')}><Icon name="comment" />{s.unresolved}</span>}
      {onArchive && (
        <Menu label={<Icon name="kebab" />} className="icon-btn" align="right" title="More">
          {(close) => <MenuItem onClick={() => { onArchive(!s.archived); close() }}>{s.archived ? 'Restore' : 'Archive'}</MenuItem>}
        </Menu>
      )}
    </div>
  )
}

export function Dashboard() {
  const data = useStore((s) => s.dashboard)
  const go = useStore((s) => s.go)
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState('')
  const [hidden, setHidden] = useState<string[]>([])
  const q = filter.trim().toLowerCase()
  const repos = useMemo(() => (data?.repos ?? []).filter((r) => !q || r.path.toLowerCase().includes(q) || r.current.toLowerCase().includes(q)), [data, q])
  const sessions = useMemo(() => (data?.recentSessions ?? []).filter((s) =>
    !q || s.repo.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q) || s.pair.compare.symbol.toLowerCase().includes(q)), [data, q])
  const notices = (data?.notices ?? []).filter((n) => !hidden.includes(n))
  const open = (): void => { if (path.trim()) go({ name: 'hub', path: path.trim() }) }
  return (
    <div className="page" data-gr-screen="dashboard">
      <TopBar crumbs={[]} />
      <main className="page-body">
        {notices.map((n) => (
          <div key={n} className="flash-banner warn" data-gr="notice">
            <span className="grow">{n}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setHidden([...hidden, n])}><Icon name="x" size={14} /></button>
          </div>
        ))}
        <div className="subhead">
          <span className="filter-input grow"><Icon name="search" size={14} /><input name="gr-field" value={filter} placeholder="Find a repository or review…" onChange={(e) => setFilter(e.target.value)} aria-label="Filter" /></span>
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); open() }}>
            <input name="gr-field" className="mono path-input" value={path} placeholder="/path/to/a/git/repository" onChange={(e) => setPath(e.target.value)} aria-label="Repository path" data-gr="open-path" />
            <button className="btn sm primary" type="submit" disabled={!path.trim()}><Icon name="repo" />Open</button>
          </form>
        </div>

        <div className="list-box">
          <div className="list-head"><Icon name="pr" /><strong>Recent reviews</strong><span className="counter">{sessions.length}</span></div>
          {!data ? <div className="blankslate sm">Loading…</div>
            : sessions.length === 0 ? <div className="blankslate sm">No saved reviews{q ? ' match' : ' yet'}.</div>
              : sessions.map((s) => <SessionRow key={s.id} s={s} showRepo />)}
        </div>

        <div className="list-box">
          <div className="list-head"><Icon name="repo" /><strong>Repositories</strong><span className="counter">{repos.length}</span></div>
          {data && repos.length === 0 && <div className="blankslate sm">No repositories{q ? ' match' : ' opened yet'}.</div>}
          {repos.map((r) => (
            <div key={r.path} className="list-row">
              <Icon name="repo" className="muted" />
              <div className="grow">
                <a className="row-title" href={routeHash({ name: 'hub', path: r.path })}>{baseName(r.path)}</a>
                <span className="ref-chip mono">{r.current === 'HEAD' ? 'detached HEAD' : r.current}</span>
                <div className="muted small"><span className="mono">{r.path}</span> · {plural(r.sessionCount, 'review')} · updated {ago(r.lastActivity)}</div>
              </div>
              <a className="btn sm" href={routeHash({ name: 'review', repo: r.path })} title={r.current === 'HEAD' ? `Review the working tree against ${r.defaultBase}` : `Review ${r.current} against ${r.defaultBase}`}>
                {r.current === 'HEAD' ? 'Review working tree' : 'Review current branch'}
              </a>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

export function Hub() {
  const hub = useStore((s) => s.hub)
  const { go, loadHub, archive } = useStore.getState()
  const [base, setBase] = useState('')
  const [compare, setCompare] = useState('')
  const [fresh, setFresh] = useState(false)
  const [direct, setDirect] = useState(false)
  if (!hub) return null
  const st = hub.state
  const detached = st?.current === 'HEAD'
  const defBase = st?.defaultBase ?? ''
  const defCompare = st ? (detached ? '@worktree' : st.current) : ''
  const open = (): void => go({ name: 'review', repo: hub.repo, base: base.trim() || defBase, compare: compare.trim() || defCompare, fresh, direct })
  const where = new Map((st?.worktrees ?? []).filter((w) => w.branch).map((w) => [w.branch!, w]))
  return (
    <div className="page" data-gr-screen="hub">
      <TopBar crumbs={[{ label: baseName(hub.repo) }]} />
      <main className="page-body">
        <div className="hub-head">
          <h1>{baseName(hub.repo)}</h1>
          {st && <span className="ref-chip mono">{detached ? 'detached HEAD' : st.current}</span>}
          {st && (st.dirty ? <span className="label warn">{plural(st.dirtyCount, 'uncommitted change')}</span> : <span className="label">Clean</span>)}
          <span className="muted small mono">{hub.repo}</span>
        </div>

        <form className="list-box compare-box" data-gr="new-review" onSubmit={(e) => { e.preventDefault(); open() }}>
          <div className="list-head"><Icon name="pr" /><strong>Compare changes</strong></div>
          <div className="compare-row">
            <RefPicker
              repo={hub.repo} value={base} onChange={setBase} relativeTo={compare && !compare.startsWith('@') ? compare : undefined}
              label="base" placeholder={defBase || 'main'}
              specials={[{ value: '@empty', note: 'the empty tree: everything shows as added (use it for a root commit)' }]}
            />
            <Icon name="arrowLeft" className="muted cmp-arrow" />
            <RefPicker
              repo={hub.repo} value={compare} onChange={setCompare} relativeTo={compare && !compare.startsWith('@') ? compare : undefined}
              label="compare" placeholder={defCompare || 'branch'}
              specials={detached ? [{ value: '@worktree', note: 'the working tree of the detached HEAD, uncommitted changes included' }] : []}
            />
            <button className="btn sm primary" type="submit" disabled={!st} data-gr="open-review">Open review</button>
          </div>
          <div className="compare-opts">
            <label className="check" title="Off: the diff starts at the merge-base, so it shows only what the compare side added (like a pull request). On: the two endpoints are compared as they are.">
              <input name="gr-field" type="checkbox" checked={direct} onChange={(e) => setDirect(e.target.checked)} data-gr="direct" /> Compare endpoints directly
            </label>
            <label className="check" title="Start another review even if one is saved for this pair">
              <input name="gr-field" type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} data-gr="fresh" /> Start a new review
            </label>
            <span className="muted small" title="A branch follows its tip and includes uncommitted changes when checked out. A tag, SHA or HEAD~N is frozen. One commit: SHA^ as base, SHA as compare. Only uncommitted work: HEAD as base, the checked-out branch as compare.">Branches move; tags, SHAs and HEAD~N are fixed.</span>
          </div>
        </form>

        <div className="list-box">
          <div className="list-head">
            <Icon name="pr" /><strong>Reviews</strong><span className="counter">{hub.sessions.length}</span><span className="grow" />
            <label className="check"><input name="gr-field" type="checkbox" checked={hub.showArchived} onChange={(e) => void loadHub(hub.repo, e.target.checked)} /> Show archived</label>
          </div>
          {hub.sessions.length === 0
            ? <div className="blankslate sm">No saved reviews for this repository.</div>
            : hub.sessions.map((s) => <SessionRow key={s.id} s={s} onArchive={(a) => void archive(s.id, a)} />)}
        </div>

        <div className="list-box">
          <div className="list-head"><Icon name="commit" /><strong>Branches</strong><span className="counter">{st?.branches.length ?? 0}</span></div>
          {!st && <div className="blankslate sm">Loading…</div>}
          {st?.branches.map((b) => {
            const w = where.get(b)
            return (
              <div key={b} className="list-row">
                <div className="grow">
                  <span className="ref-chip mono">{b}</span>
                  {b === st.defaultBase && <span className="label">Default</span>}
                  {w && <span className="muted small"> checked out{w.primary ? '' : ` in ${baseName(w.path)}`} at <span className="mono">{short(w.head)}</span>{w.dirty ? ' · uncommitted changes' : ''}</span>}
                </div>
                {b !== st.defaultBase && <a className="btn sm" href={routeHash({ name: 'review', repo: hub.repo, base: st.defaultBase, compare: b })}>Review against {st.defaultBase}</a>}
              </div>
            )
          })}
          {st?.worktrees.filter((w) => !w.branch).map((w) => (
            <div key={w.path} className="list-row">
              <div className="grow"><span className="ref-chip mono">detached</span><span className="muted small"> {w.primary ? 'primary worktree' : baseName(w.path)} at <span className="mono">{short(w.head)}</span>{w.dirty ? ' · uncommitted changes' : ''}</span></div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
