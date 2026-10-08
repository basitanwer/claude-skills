import { create } from 'zustand'
import type {
  AnchorInput, Comment, CommentPatch, DashboardData, DriftSummary, FileDiff, FocusTarget, LoadedReview, Presence, PushMap,
  RepoState, RequestKind, ReviewRequest, ReviewState, ReviewView, SessionListItem, TourStop, UiAction, ViewMark
} from '@shared/types'
import { api, connect } from './api'
import { errText, isOpen, newId, parseHash, refInput, routeHash, targetLabel, type DiffMode, type Route, type Tab } from './util'
import { focusAnchor, startTour } from './focus'

/** `key`: a newer toast with the same key takes the place of an older one. */
export interface Toast { id: string; text: string; kind: 'error' | 'info'; action?: { label: string; run: () => void }; key?: string }
/** the toast that offers a jump the session asked for while the reviewer was writing */
const SHOW_KEY = 'session-show'
/** The reviewer is in the middle of writing: the caret is in a text field, or a comment,
 *  a reply, a question or an answer has text in it that moving the page could discard. */
export function typing(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search') && !el.readOnly)) return true
  return [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[name="gr-field"]:not([type]):not([readonly]):not(#gr-file-filter)')].some((f) => f.value.trim() !== '')
}
export interface Tour {
  stops: TourStop[]; idx: number; loop?: boolean
  /** where the reviewer was when the tour started: what "Back to …" returns to */
  origin?: NonNullable<Store['returnTo']>
}
export interface Hub { repo: string; state: RepoState | null; sessions: SessionListItem[]; showArchived: boolean }
/** The code under review moved while this view was open. */
export interface Drift { signature: string; summary: DriftSummary | null }
interface PreviewInputs { repo: string; base: string; compare: string; direct: boolean; fresh: boolean }
export type DiffView = 'split' | 'unified'
/** A diff line the review was asked to show; a file box reveals it if it lies outside the hunks. */
/** `end`: with side `new`, show the whole range `line`..`end`, not only the lines round `line` */
export interface Reveal { file: string; side: 'old' | 'new'; line: number; end?: number; seq: number }
const TREE_W = { min: 200, max: 600, def: 300 }
export const treeWidthLimits = TREE_W
function storedTreeWidth(): number {
  try { const n = Number(localStorage.getItem('gr-tree-w')); return n >= TREE_W.min && n <= TREE_W.max ? n : TREE_W.def } catch { return TREE_W.def }
}
export interface Filters { hideViewed: boolean; onlyCommented: boolean; bySection: boolean; showExcluded: boolean }

/** View preferences that outlive the page (best effort: storage may be blocked). */
function pref<T extends string>(key: string, allowed: readonly T[], fallback: T | null): T | null {
  try { const v = localStorage.getItem(key); return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback } catch { return fallback }
}
function savePref(key: string, value: string | null): void {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* lasts for this page */ }
}

interface Store {
  route: Route
  toasts: Toast[]
  dashboard: DashboardData | null
  hub: Hub | null

  loading: boolean
  loaded: LoadedReview | null
  /** null while the review is an unsaved preview */
  sessionId: number | null
  preview: PreviewInputs | null
  viewedAt: Record<string, ViewMark>
  reviewedSections: string[]
  drift: Drift | null
  /** finished (failed / cancelled) requests the reviewer dismissed from the panel */
  dismissed: string[]

  // view state
  tab: Tab
  /** how the open review is being looked at: whitespace hidden, one commit only */
  view: ReviewView
  reveal: Reveal | null
  treeWidth: number
  /** with whitespace hidden: files whose every change was whitespace (the server's
   *  whitespace-insensitive diff leaves them out entirely), kept as empty boxes */
  wsOnly: FileDiff[]
  /** null = split on wide screens, unified on narrow ones */
  diffView: DiffView | null
  panelOpen: boolean
  fileQuery: string
  filters: Filters
  treeView: 'tree' | 'list'
  fileOpen: Record<string, boolean>
  /** files whose diff is held back by default (large, generated) and was asked for */
  fileLoaded: Record<string, boolean>
  /** Markdown files the reviewer (or a jump to an exact line) switched between the
   *  rendered document and the source diff; absent: rendered, once the review is saved */
  mdSource: Record<string, boolean>
  sectionOpen: Record<string, boolean>
  excludedOpen: boolean
  /** the fact check's "was already false" group is unfolded */
  factsOpen: boolean
  diffMode: DiffMode
  docPath: string | null
  /** the diagram open in the Visualize tab, by view id (null: the first one) */
  visualView: string | null
  /** the box of that diagram the reviewer last picked: it stays marked, so it is found again on the way back from its code */
  visualNode: string | null
  composer: string | null
  tour: Tour | null
  /** Where the reviewer was before a jump took them to another tab or far down the same
   *  one: offered back by the "Back to …" bar. `top` is how far down the window the thing the link sat in was
   *  (restored exactly); `y` is the page's scroll position, used if that thing is gone. */
  returnTo: { tab: Tab; y: number; top: number | null; label: string; target?: FocusTarget } | null
  /** the walkthrough section open in the panel beside the code (Files changed), by id */
  sectionPanel: string | null
  /** the file under the top of the window in Files changed, kept by followFiles: the
   *  file tree and the section panel mark it as where the reviewer is */
  currentFile: string | null
  status: string | null
  navOpen: boolean

  /** `opts.key`: see Toast. `opts.keep`: stays until dismissed or acted on. */
  toast(text: string, kind?: Toast['kind'], action?: Toast['action'], opts?: { key?: string; keep?: boolean }): void
  dismissToast(id: string): void
  go(route: Route): void
  applyRoute(route: Route): Promise<void>
  boot(): Promise<void>

  loadDashboard(): Promise<void>
  loadHub(repo: string, showArchived?: boolean): Promise<void>
  archive(id: number, archived: boolean): Promise<void>

  /** Save an unsaved preview (the first write does this); returns the session id. */
  materialize(): Promise<number | null>
  reload(): Promise<void>
  softReload(): void
  toggleApprove(): Promise<void>
  toggleArtifactApproval(path: string): Promise<void>
  retarget(ref: string): Promise<void>

  toggleViewed(file: FileDiff): Promise<void>
  toggleSectionReviewed(id: string): Promise<void>
  toggleExcluded(file: FileDiff): Promise<void>

  addComment(anchor: AnchorInput, text: string): Promise<string | null>
  updateComment(id: string, patch: CommentPatch): Promise<void>
  removeComment(id: string): Promise<void>

  /** Close a Question thread, by its first question's request id, or open it again. */
  resolveAsk(root: string, resolved: boolean): Promise<void>
  /** Ask the attached Claude Code session for something. */
  request(input: { kind: RequestKind; text?: string; anchor?: AnchorInput; commentIds?: string[]; update?: boolean; commit?: boolean; follows?: string }): Promise<ReviewRequest | null>
  cancelRequest(id: string): Promise<void>
  /** Put a request a session claimed but seems to have dropped back in the queue. */
  retryRequest(id: string): Promise<void>
  dismissRequest(id: string): void

  setTab(tab: Tab): void
  /** Change the view (hide whitespace / one commit) and reload under it. */
  setView(patch: ReviewView): Promise<void>
  revealLine(file: string, side: 'old' | 'new', line: number, end?: number): void
  setTreeWidth(px: number | null): void
  setDiffView(view: DiffView): void
  setTreeView(view: 'tree' | 'list'): void
  setFilters(patch: Partial<Filters>): void
  setFileOpen(path: string, open: boolean): void
  setFileLoaded(path: string): void
  setMdSource(path: string, source: boolean): void
  setSectionOpen(id: string, open: boolean): void
  set(patch: Partial<Pick<Store, 'excludedOpen' | 'factsOpen' | 'diffMode' | 'docPath' | 'visualView' | 'visualNode' | 'composer' | 'tour' | 'returnTo' | 'sectionPanel' | 'status' | 'navOpen' | 'panelOpen' | 'fileQuery'>>): void
  applyAction(action: UiAction): void

  onStreamOpen(): void
  onSessionChanged(msg: PushMap['session:changed']): void
  onRepoChanged(msg: PushMap['repo:changed']): void
  onUiAction(msg: PushMap['ui:action']): void
  onPresence(msg: PushMap['presence']): void
}

let materializing: Promise<number | null> | null = null
let reloadTimer: number | null = null
let statusTimer: number | null = null
let askedNotify = false
let loadsInFlight = 0
let routeSeq = 0
/** the review being loaded, and whether it changed while its load was in flight */
let loadingSession: number | null = null
let changedWhileLoading = false
/** counts the reviewer's changes to the reviewed sections: a reload that was in flight
 *  when one was made carries the list from before it (the save brings another reload) */
let sectionEdits = 0
/** Saves of the reviewed-sections list that have not returned yet. */
let sectionSaves = 0

/** Ask for notification permission the first time the reviewer asks Claude Code for
 *  something — never on page load. */
function primeNotifications(): void {
  if (askedNotify) return
  askedNotify = true
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
  } catch { /* unsupported */ }
}

/** Replace the hash without re-running the route (the review is already on screen). */
function syncHash(route: Route): void {
  try { history.replaceState(null, '', routeHash(route)) } catch { /* ignore */ }
}

export const useStore = create<Store>((set, get) => {
  const fail = (e: unknown): void => get().toast(errText(e), 'error')
  /** What belongs to the review on screen and must not outlive it: the way back, a tour,
   *  the open section, and toasts that would act on it. */
  const leftReview = (): Pick<Store, 'returnTo' | 'tour' | 'sectionPanel' | 'toasts'> => ({ returnTo: null, tour: null, sectionPanel: null, toasts: get().toasts.filter((t) => !t.action) })

  const setState = (state: ReviewState): void => {
    const loaded = get().loaded
    // (while a Reviewed tick is being saved, an answer to another call still has the list from before it)
    if (loaded) set({ loaded: { ...loaded, state }, viewedAt: state.viewedAt, reviewedSections: sectionSaves ? get().reviewedSections : state.reviewedSections })
  }
  const patchState = (fn: (s: ReviewState) => ReviewState): void => {
    const loaded = get().loaded
    if (loaded) set({ loaded: { ...loaded, state: fn(loaded.state) } })
  }
  const patchFile = (path: string, patch: Partial<FileDiff>): void => {
    const loaded = get().loaded
    if (loaded) set({ loaded: { ...loaded, files: loaded.files.map((f) => (f.path === path ? { ...f, ...patch } : f)) } })
  }
  const putComment = (c: Comment): void => patchState((s) => ({
    ...s, comments: s.comments.some((x) => x.id === c.id) ? s.comments.map((x) => (x.id === c.id ? c : x)) : [...s.comments, c]
  }))

  /** undefined when nothing is switched on, so plain loads stay plain */
  const viewArg = (v: ReviewView = get().view): ReviewView | undefined => (v.ignoreWhitespace || v.commit ? v : undefined)
  const viewOfRoute = (route: Route): ReviewView => {
    if (route.name !== 'review') return {}
    // hide-whitespace is a remembered preference; the hash can only switch it on
    const w = route.w || pref('gr-hide-ws', ['1'] as const, null) === '1'
    return { ...(w ? { ignoreWhitespace: true } : {}), ...(route.commit ? { commit: route.commit } : {}) }
  }
  const routeWithView = (route: Route, v: ReviewView): Route => (route.name === 'review' ? { ...route, w: v.ignoreWhitespace || undefined, commit: v.commit } : route)
  /** A commit that is no longer in the comparison (a rebase, a stale link): fall back
   *  to all changes and say why. */
  const dropCommit = (e: unknown): boolean => {
    if (!get().view.commit || !/is not part of this comparison/.test(errText(e))) return false
    const view = { ...get().view }
    delete view.commit
    set({ view })
    const route = routeWithView(get().route, view)
    set({ route })
    syncHash(route)
    get().toast(`${errText(e)} — showing all changes.`, 'info')
    return true
  }
  /** Find the files the whitespace-insensitive diff dropped, by asking for the same
   *  review without that option and comparing the file lists. */
  let wsSeq = 0
  const refreshWsOnly = (): void => {
    const seq = ++wsSeq
    const { loaded, sessionId, preview, view } = get()
    if (!loaded || !view.ignoreWhitespace) { if (get().wsOnly.length) set({ wsOnly: [] }); return }
    const plain: ReviewView | undefined = view.commit ? { commit: view.commit } : undefined
    const full = sessionId != null ? api.loadSession(sessionId, plain)
      : preview ? api.previewReview(preview.repo, preview.base, preview.compare, { direct: preview.direct, view: plain }) : null
    if (!full) return
    void full.then((canon) => {
      if (seq !== wsSeq || get().loaded?.signature !== canon.signature) return
      const have = new Set((get().loaded?.files ?? []).map((f) => f.path))
      set({ wsOnly: canon.files.filter((f) => !have.has(f.path) && !f.binary).map((f) => ({ ...f, hunks: [], add: 0, del: 0, sinceHunks: undefined, sinceViewedHunks: undefined })) })
    }).catch(() => { /* the list simply stays as the server gave it */ })
  }
  const load = async <T,>(fn: () => Promise<T>): Promise<T> => {
    loadsInFlight++
    try { return await fn() } finally { loadsInFlight-- }
  }
  /** First load of a saved review: subscribe before loading, and if it changed while
   *  the load was in flight (the response may predate the change), load once more. */
  const openSession = async (sessionId: number): Promise<LoadedReview> => {
    connect(sessionId)
    loadingSession = sessionId
    changedWhileLoading = false
    try {
      try {
        return await load(() => api.loadSession(sessionId, viewArg()))
      } catch (e) {
        if (!dropCommit(e)) throw e
        return await load(() => api.loadSession(sessionId, viewArg()))
      }
    } finally {
      loadingSession = null
      if (changedWhileLoading) get().softReload()
    }
  }

  const showLoaded = (loaded: LoadedReview, sessionId: number | null, preview: PreviewInputs | null): void => {
    set({
      loaded, sessionId, preview, loading: false,
      viewedAt: loaded.state.viewedAt, reviewedSections: loaded.state.reviewedSections,
      drift: null, dismissed: [], fileOpen: {}, fileLoaded: {}, mdSource: {}, sectionOpen: {}, excludedOpen: false, factsOpen: false, diffMode: 'all', docPath: null, visualView: null, visualNode: null,
      composer: null, tour: null, returnTo: null, sectionPanel: null, fileQuery: '', wsOnly: []
    })
    refreshWsOnly()
  }

  return {
    route: { name: 'dashboard' },
    toasts: [],
    dashboard: null,
    hub: null,
    loading: false,
    loaded: null,
    sessionId: null,
    preview: null,
    viewedAt: {},
    reviewedSections: [],
    drift: null,
    dismissed: [],
    fileOpen: {},
    fileLoaded: {},
    mdSource: {},
    sectionOpen: {},
    excludedOpen: false,
    factsOpen: false,
    diffMode: 'all',
    docPath: null,
    visualView: null,
    visualNode: null,
    composer: null,
    tab: 'files',
    view: {},
    reveal: null,
    treeWidth: storedTreeWidth(),
    wsOnly: [],
    diffView: pref('gr-diff-view', ['split', 'unified'] as const, null),
    panelOpen: typeof window === 'undefined' || window.innerWidth >= 760,   // the tree starts folded on a phone-width screen
    fileQuery: '',
    filters: { hideViewed: false, onlyCommented: false, bySection: pref('gr-by-section', ['1'] as const, null) === '1', showExcluded: false },
    treeView: pref('gr-files-view', ['tree', 'list'] as const, 'tree') ?? 'tree',
    tour: null,
    returnTo: null,
    sectionPanel: null,
    currentFile: null,
    status: null,
    navOpen: false,

    toast(text, kind = 'error', action, opts) {
      const id = newId('t')
      const rest = get().toasts.filter((t) => !opts?.key || t.key !== opts.key)
      set({ toasts: [...rest.slice(-4), { id, text, kind, ...(action ? { action } : {}), ...(opts?.key ? { key: opts.key } : {}) }] })
      if (kind === 'info' && !opts?.keep) window.setTimeout(() => get().dismissToast(id), action ? 15_000 : 6000)
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },

    go(route) {
      const hash = routeHash(route)
      if (window.location.hash === hash) void get().applyRoute(route)
      else window.location.hash = hash
    },

    async boot() {
      await get().applyRoute(parseHash(window.location.hash))
    },

    async applyRoute(route) {
      const seq = ++routeSeq
      const stale = (): boolean => seq !== routeSeq      // a newer navigation took over
      // the same review, another tab or focus: nothing to load
      if (route.name === 'review' && route.session != null && route.session === get().sessionId && get().loaded) {
        const next = viewOfRoute(route)
        const cur = get().view
        set({ route, tab: route.tab ?? 'files' })
        if (Boolean(next.ignoreWhitespace) !== Boolean(cur.ignoreWhitespace) || (next.commit ?? '') !== (cur.commit ?? '')) { set({ view: next }); await get().reload() }
        if (route.focus) { try { const t = JSON.parse(route.focus); window.setTimeout(() => focusAnchor(t, { nav: true }), 60) } catch { /* ignore */ } }
        return
      }
      set({ route, navOpen: false, tab: route.name === 'review' ? route.tab ?? 'files' : 'files', view: viewOfRoute(route), reveal: null })
      if (route.name === 'dashboard') {
        connect(null)
        set({ loaded: null, sessionId: null, preview: null, hub: null, ...leftReview() })
        await get().loadDashboard()
        return
      }
      if (route.name === 'hub') {
        connect(null)
        set({ loaded: null, sessionId: null, preview: null, ...leftReview() })
        await get().loadHub(route.path, false)
        return
      }
      set({ loading: true, loaded: null, sessionId: null, preview: null, ...leftReview() })
      try {
        if (route.session != null) {
          const loaded = await openSession(route.session)
          if (stale()) return
          showLoaded(loaded, route.session, null)
          if (get().view.ignoreWhitespace && !route.w) syncHash(routeWithView(route, get().view))
        } else if (route.repo) {
          const repo = route.repo
          const st = await api.openRepo(repo)           // validates the path and records it under Recent
          const base = route.base || st.defaultBase
          const compare = route.compare || (st.current !== 'HEAD' ? st.current : '@worktree')
          const direct = Boolean(route.direct)
          const match = route.fresh ? null : await api.findSession(repo, base, compare, { direct })
          if (stale()) return
          if (match) {
            const loaded = await openSession(match.sessionId)
            if (stale()) return
            showLoaded(loaded, match.sessionId, null)
            syncHash(routeWithView({ name: 'review', session: match.sessionId, focus: route.focus, tab: route.tab }, get().view))
          } else {
            // a preview: the diff with nothing saved — it is saved on the first write
            connect(null)
            const preview = (): Promise<LoadedReview> => load(() => api.previewReview(repo, base, compare, { direct, view: viewArg() }))
            const loaded = await preview().catch((e: unknown) => { if (!dropCommit(e)) throw e; return preview() })
            if (stale()) return
            showLoaded(loaded, null, { repo, base, compare, direct, fresh: Boolean(route.fresh) })
          }
        } else {
          set({ loading: false })
        }
        if (route.focus) {
          try {
            const target = JSON.parse(route.focus)
            window.setTimeout(() => focusAnchor(target, { nav: true }), 250)     // opening a link: there is no earlier place to go back to
          } catch { get().toast('The focus parameter in the URL is not valid JSON.', 'error') }
        }
      } catch (e) {
        if (stale()) return
        set({ loading: false })
        fail(e)
      }
    },

    async loadDashboard() {
      try { set({ dashboard: await api.dashboard() }) } catch (e) { fail(e) }
    },

    async loadHub(repo, showArchived) {
      const archived = showArchived ?? get().hub?.showArchived ?? false
      if (get().hub?.repo !== repo) set({ hub: { repo, state: null, sessions: [], showArchived: archived } })
      try {
        const [state, sessions] = await Promise.all([api.openRepo(repo), api.listSessions(repo, archived)])
        set({ hub: { repo, state, sessions, showArchived: archived } })
      } catch (e) { fail(e) }
    },

    async archive(id, archived) {
      try {
        await api.archiveSession(id, archived)
        const hub = get().hub
        if (hub) await get().loadHub(hub.repo)
      } catch (e) { fail(e) }
    },

    async materialize() {
      const existing = get().sessionId
      if (existing != null) return existing
      if (materializing) return materializing
      const { loaded, preview } = get()
      if (!loaded) return null
      materializing = (async () => {
        try {
          // the same inputs the preview was built from, so the saved review is the
          // comparison on screen (a ref typed as HEAD~2 keeps reading HEAD~2)
          const pair = loaded.session.pair
          const repo = preview?.repo ?? loaded.session.repo
          const { sessionId } = await api.startSession(
            repo, preview?.base ?? refInput(pair.base), preview?.compare ?? refInput(pair.compare),
            { fresh: preview?.fresh ?? false, direct: preview?.direct ?? loaded.session.direct }
          )
          const real = await openSession(sessionId)
          set({
            sessionId, loaded: real, preview: null, route: routeWithView({ name: 'review', session: sessionId, tab: get().tab }, get().view),
            viewedAt: real.state.viewedAt, reviewedSections: real.state.reviewedSections
          })
          syncHash(get().route)
          refreshWsOnly()
          return sessionId
        } catch (e) {
          fail(e)
          return null
        } finally {
          materializing = null
        }
      })()
      return materializing
    },

    async reload() {
      const { sessionId, preview } = get()
      try {
        if (sessionId != null) {
          const edits = sectionEdits
          const next = await load(() => api.loadSession(sessionId, viewArg()))
          if (get().sessionId !== sessionId) return     // navigated away meanwhile
          // sections ticked while this was loading stay ticked: stepping through them quickly on a
          // large review, the next tick would otherwise be saved on top of the older list
          set({ loaded: next, viewedAt: next.state.viewedAt, reviewedSections: edits === sectionEdits && !sectionSaves ? next.state.reviewedSections : get().reviewedSections, drift: null })
          refreshWsOnly()
        } else if (preview) {
          const next = await load(() => api.previewReview(preview.repo, preview.base, preview.compare, { direct: preview.direct, view: viewArg() }))
          if (get().preview !== preview) return
          set({ loaded: next, drift: null })
          refreshWsOnly()
        }
      } catch (e) {
        if (dropCommit(e)) await get().reload()
        else fail(e)
      }
    },

    softReload() {
      if (reloadTimer != null) window.clearTimeout(reloadTimer)
      reloadTimer = window.setTimeout(() => { reloadTimer = null; void get().reload() }, 200)
    },

    async toggleApprove() {
      const was = get().loaded?.approved
      const id = await get().materialize()
      if (id == null) return
      try {
        await (was ? api.unapprove(id) : api.approve(id))
        await get().reload()          // `approved` is the server's verdict on this exact surface
      } catch (e) { fail(e) }
    },

    async toggleArtifactApproval(path) {
      const id = await get().materialize()
      if (id == null) return
      try {
        const approvedAt = get().loaded?.state.artifactApprovals[path]
        setState(await api.approveArtifact(id, path, !approvedAt))
      } catch (e) { fail(e) }
    },

    async retarget(ref) {
      const { sessionId } = get()
      if (sessionId == null || !ref.trim()) return
      try {
        await api.retargetSession(sessionId, ref.trim())
        await get().reload()
      } catch (e) { fail(e) }
    },

    async toggleViewed(file) {
      const id = await get().materialize()
      if (id == null) return
      const was = file.viewed === 'viewed'
      const fileOpen = { ...get().fileOpen }
      delete fileOpen[file.path]      // back to the default: viewed files fold away
      set({ fileOpen })
      patchFile(file.path, { viewed: was ? undefined : 'viewed' })
      try {
        // the server snapshots the commit and the on-disk content hash, so a later
        // commit or an uncommitted edit both turn the mark into "changed since viewed"
        setState(await api.setViewed(id, file.path, !was))
        get().softReload()            // file.viewed / since-viewed marks are the server's
      } catch (e) {
        patchFile(file.path, { viewed: file.viewed })
        fail(e)
      }
    },

    async toggleSectionReviewed(sectionId) {
      const id = await get().materialize()
      if (id == null) return
      const cur = get().reviewedSections
      const next = cur.includes(sectionId) ? cur.filter((s) => s !== sectionId) : [...cur, sectionId]
      const sectionOpen = { ...get().sectionOpen }
      delete sectionOpen[sectionId]
      sectionEdits++
      set({ reviewedSections: next, sectionOpen })
      sectionSaves++
      try { await api.saveUiState(id, { reviewedSections: next }) } catch (e) { fail(e) } finally { sectionSaves-- }
    },

    async toggleExcluded(file) {
      if (!file.untracked) return
      const id = await get().materialize()
      const loaded = get().loaded
      if (id == null || !loaded) return
      const fileExcluded = { ...loaded.state.fileExcluded, [file.path]: !file.excluded }
      patchFile(file.path, { excluded: !file.excluded })
      try {
        await api.saveUiState(id, { fileExcluded })
        get().softReload()            // what is left out changes the surface (and its approval)
      } catch (e) { fail(e) }
    },

    async addComment(anchor, text) {
      const body = text.trim()
      if (!body) return null
      const id = await get().materialize()
      if (id == null) return null
      try {
        // the server checks the anchor against the live diff and copies the line text
        // from git; it refuses a line that is not there
        const c = await api.commentAdd(id, { anchor, text: body, author: 'user', status: 'queued' })
        putComment(c)
        return c.id
      } catch (e) {
        fail(e)
        return null
      }
    },

    async updateComment(commentId, patch) {
      const id = get().sessionId
      if (id == null) return
      try { putComment(await api.commentUpdate(id, commentId, patch)) } catch (e) { fail(e) }
    },

    async removeComment(commentId) {
      const id = get().sessionId
      if (id == null) return
      try {
        await api.commentDelete(id, commentId)
        patchState((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== commentId) }))
      } catch (e) { fail(e) }
    },

    async request(input) {
      const id = await get().materialize()
      if (id == null) return null
      primeNotifications()
      try {
        const r = await api.requestCreate(id, input)
        patchState((s) => ({ ...s, requests: s.requests.some((x) => x.id === r.id) ? s.requests : [...s.requests, r] }))
        get().softReload()            // picks up what the server did alongside (the user message, comments marked sent)
        return r
      } catch (e) {
        fail(e)
        return null
      }
    },

    async resolveAsk(root, resolved) {
      const id = get().sessionId
      if (id == null) return
      try {
        const st = await api.askResolve(id, root, resolved)
        patchState((s) => ({ ...s, resolvedAsks: st.resolvedAsks ?? [] }))
      } catch (e) { fail(e) }
    },

    async cancelRequest(requestId) {
      const id = get().sessionId
      if (id == null) return
      try {
        const r = await api.requestCancel(id, requestId)
        patchState((s) => ({ ...s, requests: s.requests.map((x) => (x.id === r.id ? r : x)) }))
        get().softReload()
      } catch (e) { fail(e) }
    },

    async retryRequest(requestId) {
      const id = get().sessionId
      if (id == null) return
      try {
        const r = await api.requestRetry(id, requestId)
        patchState((s) => ({ ...s, requests: s.requests.map((x) => (x.id === r.id ? r : x)) }))
        get().softReload()
      } catch (e) { fail(e) }
    },

    dismissRequest(requestId) {
      set({ dismissed: [...get().dismissed, requestId] })
    },

    setTab(tab) {
      if (get().tab === tab) return
      const route = get().route
      set({ tab, composer: null })
      if (route.name === 'review') {
        const next = { ...route, tab, focus: undefined }
        set({ route: next })
        syncHash(next)
      }
      window.scrollTo({ top: 0 })
    },
    async setView(patch) {
      const view: ReviewView = { ...get().view, ...patch }
      if (!view.ignoreWhitespace) delete view.ignoreWhitespace
      if (!view.commit) delete view.commit
      if ('ignoreWhitespace' in patch) savePref('gr-hide-ws', view.ignoreWhitespace ? '1' : null)
      const route = routeWithView(get().route, view)
      set({ view, route, composer: null, ...(view.commit ? { diffMode: 'all' as DiffMode } : {}) })
      syncHash(route)
      await get().reload()
    },
    revealLine(file, side, line, end) {
      set({ reveal: { file, side, line, ...(end != null && end > line ? { end } : {}), seq: (get().reveal?.seq ?? 0) + 1 } })
    },
    setTreeWidth(px) {
      const w = px == null ? TREE_W.def : Math.round(Math.min(TREE_W.max, Math.max(TREE_W.min, px)))
      set({ treeWidth: w })
      savePref('gr-tree-w', px == null ? null : String(w))
    },
    setDiffView(view) { set({ diffView: view }); savePref('gr-diff-view', view) },
    setTreeView(view) { set({ treeView: view }); savePref('gr-files-view', view) },
    setFilters(patch) {
      const filters = { ...get().filters, ...patch }
      set({ filters })
      savePref('gr-by-section', filters.bySection ? '1' : null)
    },
    setFileOpen(path, open) {
      set({ fileOpen: { ...get().fileOpen, [path]: open } })
    },
    setMdSource(path, source) {
      if (get().mdSource[path] !== source) set({ mdSource: { ...get().mdSource, [path]: source } })
    },
    setFileLoaded(path) {
      if (!get().fileLoaded[path]) set({ fileLoaded: { ...get().fileLoaded, [path]: true } })
    },
    setSectionOpen(id, open) {
      set({ sectionOpen: { ...get().sectionOpen, [id]: open } })
    },
    set(patch) {
      set(patch)
      if (patch.status) {
        if (statusTimer != null) window.clearTimeout(statusTimer)
        statusTimer = window.setTimeout(() => set({ status: null }), 8000)
      }
    },

    applyAction(action) {
      switch (action.kind) {
        case 'focus': focusAnchor(action.target); break
        case 'tour':
          startTour(action.stops, action.loop)
          break
        case 'status': get().set({ status: action.text }); break
        case 'navigate': window.location.hash = action.hash.replace(/^#?/, '#'); break
      }
    },

    onStreamOpen() {
      // the stream just (re)connected: anything pushed while it was down was missed.
      // A load already in flight covers it; otherwise refresh the open review.
      if (get().sessionId != null && loadsInFlight === 0) get().softReload()
    },

    onSessionChanged({ sessionId }) {
      if (loadingSession === sessionId) changedWhileLoading = true
      else if (get().sessionId === sessionId) get().softReload()
    },

    onRepoChanged({ sessionId, signature }) {
      const loaded = get().loaded
      if (!loaded || get().sessionId !== sessionId) return
      // never swap the code out from under the reviewer: show the pill, they fold it in
      if (signature === loaded.signature) { set({ drift: null }); return }
      set({ drift: { signature, summary: get().drift?.summary ?? null } })
      void api.driftSince(sessionId, loaded.headSha).then((summary) => {
        if (get().drift?.signature === signature) set({ drift: { signature, summary } })
      }).catch(() => { /* the pill still shows, without the counts */ })
    },

    onUiAction({ sessionId, action, answerTo }) {
      if (get().sessionId !== sessionId) return
      // an answer never moves the page by itself: it shows where the question was asked,
      // and the code it cites is one click away
      if (answerTo) { get().toast('Claude Code answered.', 'info', { label: action.kind === 'tour' ? 'Start the tour' : 'Show the code it cites', run: () => get().applyAction(action) }); return }
      // Nor does the session take the page away while the reviewer is writing (a tab switch
      // would discard the text): the jump waits behind a toast until they ask for it.
      const what = action.kind === 'focus' ? targetLabel(action.target) : action.kind === 'tour' ? `a tour of ${action.stops.length} ${action.stops.length === 1 ? 'stop' : 'stops'}` : action.kind === 'navigate' ? 'another page' : null
      if (what && typing()) { get().toast(`Claude Code wants to show you ${what}`, 'info', { label: 'Go', run: () => get().applyAction(action) }, { key: SHOW_KEY, keep: true }); return }
      // a newer jump, played at once, replaces one that was still on offer
      if (what) set({ toasts: get().toasts.filter((t) => t.key !== SHOW_KEY) })
      get().applyAction(action)
    },

    onPresence({ sessionId, presence }: { sessionId: number; presence: Presence }) {
      const loaded = get().loaded
      if (loaded && get().sessionId === sessionId && loaded.presence !== presence) set({ loaded: { ...loaded, presence } })
    }
  }
})

/** Requests still waiting on Claude Code for the open review. */
export const openRequests = (s: { loaded: LoadedReview | null }): ReviewRequest[] => (s.loaded?.state.requests ?? []).filter(isOpen)
export const isBusy = (s: { loaded: LoadedReview | null }): boolean => (s.loaded?.state.requests ?? []).some(isOpen)
