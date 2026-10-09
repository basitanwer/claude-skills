import { create } from 'zustand'
import type {
  AnchorInput, Comment, CommentPatch, DashboardData, DriftSummary, FileDiff, FocusTarget, LoadedReview, Presence, PushMap,
  RepoState, RequestKind, ReviewRequest, ReviewState, ReviewView, SessionListItem, TourStop, UiAction, ViewMark
} from '@shared/types'
import { api, connect } from './api'
import { errText, GUIDES, guideOfPick, isOpen, narrowingOf, newId, parseHash, parsePick, pickKey, refInput, routeHash, targetLabel, type DiffMode, type Guide, type CodePick, type Route } from './util'
import { backToPlace, focusAnchor, hasPlace, holdCodePlace, notePlace, parkCodePlace, showPick, startTour } from './focus'

/** `key`: a newer toast with the same key takes the place of an older one. */
export interface Toast { id: string; text: string; kind: 'error' | 'info'; action?: { label: string; run: () => void }; key?: string }
/** the toast that offers a jump the session asked for while the reviewer was writing */
const SHOW_KEY = 'session-show'
/** The reviewer is in the middle of writing: the caret is in a text field, or a comment,
 *  a reply, a question or an answer on screen has text in it that moving the page could
 *  discard. (Text left in a Guide that is not on show is kept with that Guide, and holds
 *  nothing up.) */
export function typing(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'search') && !el.readOnly)) return true
  return [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[name="gr-field"]:not([type]):not([readonly]):not(#gr-file-filter)')].some((f) => f.value.trim() !== '' && f.getClientRects().length > 0)
}
/** `id`: names the tour in the step of the trail it made, so that its later stops rewrite that step and add none. */
export interface Tour { stops: TourStop[]; idx: number; loop?: boolean; id: string }
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
/** The window width from which the tree panel keeps its column while a Guide is open:
 *  below it Guide, code and tree do not fit side by side with a code column wide enough to
 *  read, and the tree folds unless pinned. */
export const TREE_BESIDE_GUIDE = 1900
/** Whether the tree panel has room as a column of its own, on the far right: always where
 *  the code has the window to itself; beside a Guide on a wide window, or when pinned. */
export const treeHasRoom = (s: { guide: Guide | null; treePinned: boolean }): boolean =>
  window.innerWidth >= SHEET_BELOW && (s.guide == null || (window.innerWidth >= STACK_BELOW && (window.innerWidth >= TREE_BESIDE_GUIDE || s.treePinned)))
/** The window width under which the two panes are stacked, the Guide on top and the code
 *  below it, instead of side by side. */
export const STACK_BELOW = 1100
/** The window width under which the code is a sheet that rises over the lower part of the Guide after a pick. */
export const SHEET_BELOW = 760
/** How a change of Guide or of pick reaches the address. `step`: a step of the trail (the
 *  reviewer did it: the browser's Back returns to what was before). `replace`: the address
 *  is brought up to date, without a step (it is not one: showing all files, the pick's code
 *  only, a later stop of a tour). `follow`: the address already says so (it is being
 *  followed, as on Back). A step is only ever added when the Guide, the pick or the jump
 *  the address names changes, so no two steps in a row are the same. */
export type How = 'step' | 'replace' | 'follow'
/** Where a review was left, kept per review in this browser: reopened with its plain
 *  address, it comes back so. `wide`: the Guide had the whole width (or height); `code`:
 *  the code had the whole height, where the panes are stacked; `folded`: the folders
 *  folded in the tree panel. */
interface Left { guide: Guide | null; pick: CodePick | null; picks: Partial<Record<Guide, CodePick>>; all: boolean; wide: boolean; code: boolean; folded: string[] }
function readLeft(id: number): Left | null {
  try {
    const raw = localStorage.getItem(`gr-left-${id}`)
    if (!raw) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    const picks: Partial<Record<Guide, CodePick>> = {}
    for (const g of GUIDES) {
      const one = parsePick(JSON.stringify((v.picks as Record<string, unknown> | undefined)?.[g] ?? null))
      if (one) picks[g] = one
    }
    return {
      guide: GUIDES.find((g) => g === v.guide) ?? null, pick: parsePick(JSON.stringify(v.pick ?? null)), picks, all: v.all === true,
      wide: v.wide === true, code: v.code === true, folded: Array.isArray(v.folded) ? v.folded.filter((x): x is string => typeof x === 'string') : []
    }
  } catch { return null }       // storage blocked, or not what was stored: the review opens as a new one
}
function storedWidths(): Partial<Record<Guide, number>> {
  try {
    const v = JSON.parse(localStorage.getItem('gr-guide-w') ?? '{}') as Record<string, unknown>
    const out: Partial<Record<Guide, number>> = {}
    for (const g of GUIDES) { const n = v[g]; if (typeof n === 'number' && n > 0 && n < 100) out[g] = n }
    return out
  } catch { return {} }
}

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
  /** the Guide on show in the Guide pane; null: the Guide pane is closed and the Code pane has the window */
  guide: Guide | null
  /** the Guide pane has the whole width (the whole height, where the panes are stacked) and the Code pane is folded away, until a jump to code brings it back */
  guideWide: boolean
  /** where the panes are stacked: the Code pane has the whole height and the Guide pane is folded away, until it is asked for again */
  codeWide: boolean
  /** On a phone-width window, where the code is a sheet over the lower part of the Guide:
   *  `code` while the sheet is up. A pick or a jump to code raises it; closing it gives the
   *  Guide back. (Wider windows keep it up to date and do not read it.) */
  front: 'guide' | 'code'
  /** where the reviewer dragged the divider to while the panes are stacked, as the Guide's
   *  share of the height in percent (null: the starting split). Kept apart from the widths. */
  stackSplit: number | null
  /** Details in the top bar is open (the comparison, the effort, the commits) */
  detailsOpen: boolean
  /** how the open review is being looked at: whitespace hidden, one commit only */
  view: ReviewView
  reveal: Reveal | null
  treeWidth: number
  /** with whitespace hidden: files whose every change was whitespace (the server's
   *  whitespace-insensitive diff leaves them out entirely), kept as empty boxes */
  wsOnly: FileDiff[]
  /** null = split on wide screens, unified on narrow ones */
  diffView: DiffView | null
  /** the reviewer has the tree panel switched on (it still folds by itself where it has no room, unless pinned) */
  panelOpen: boolean
  /** the tree panel keeps its column beside a Guide even on a window with little room for three */
  treePinned: boolean
  /** the tree panel is open over the Code pane: asked for (the path bar, the toggle, `t`) where it has no column */
  treeOver: boolean
  /** folders of the tree the reviewer folded, by path */
  closedDirs: string[]
  /** a folder the tree was asked to open at (from the path bar): it unfolds down to it and shows it */
  treeAt: { dir: string; seq: number } | null
  fileQuery: string
  filters: Filters
  treeView: 'tree' | 'list'
  fileOpen: Record<string, boolean>
  /** files whose diff is held back by default (large, generated) and was asked for */
  fileLoaded: Record<string, boolean>
  /** Markdown files the reviewer (or a jump to an exact line) switched between the
   *  rendered document and the source diff; absent: rendered, once the review is saved */
  mdSource: Record<string, boolean>
  excludedOpen: boolean
  /** the fact check's "was already false" group is unfolded */
  factsOpen: boolean
  diffMode: DiffMode
  docPath: string | null
  /** the diagram open in the Visualize Guide, by view id (null: the first one) */
  visualView: string | null
  /** The pick: the item chosen in a Guide (a box of a diagram, a comment's line, a plan
   *  row's file). Beside a Guide the Code pane is narrowed to its code until another pick or
   *  "Show all files"; it stays outlined in its Guide. The address carries it. */
  pick: CodePick | null
  /** Each Guide's own pick: the one it keeps outlined (the box, the open section, the
   *  link), whatever was picked elsewhere since. The Code pane follows the most recent
   *  pick only (`pick`). */
  picks: Partial<Record<Guide, CodePick>>
  /** where the reviewer dragged the divider to with each Guide on show, as the Guide pane's
   *  share of the room in percent (none: the Guide's starting width). Kept for all reviews. */
  guideWidths: Partial<Record<Guide, number>>
  /** Beside a Guide: the Code pane shows all the files, not only the pick's (or, with no
   *  pick, the list of changed files). Left by "Show all files", a click in the tree, or a
   *  jump to code outside the pick. */
  showAll: boolean
  composer: string | null
  tour: Tour | null
  /** the file under the top of the Code pane, kept by followFiles: the path bar, the tree
   *  and the open section of the walkthrough mark it as where the reviewer is */
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

  /** Show a Guide in the Guide pane (opening the pane), or close the pane with null. A
   *  change of Guide is a step of the trail (see How). */
  showGuide(guide: Guide | null, how?: How): void
  /** Make something the pick (null: none): the Code pane follows it, and the Guide it was
   *  made in (`from`; a box and a section say theirs) keeps it outlined. A step of the
   *  trail, unless it is the pick already (see How). */
  pickCode(pick: CodePick | null, opts?: { from?: Guide | null; how?: How }): void
  /** A jump to code the session asked for is a step of the trail: the address names its
   *  target (`focus=`), and Back returns to what the Code pane showed before it. `tour`: the
   *  tour it is a stop of; a whole tour is one step, which its later stops rewrite. */
  jumpStep(target: FocusTarget, tour?: string): void
  /** Take a Guide's pick away. If the Code pane was following it, all the files are shown: a step of the trail. */
  clearPick(guide: Guide): void
  /** Leave the narrowing for all the files, or return to it. */
  showAllFiles(all: boolean): void
  /** Bring the tree panel on show: as its column where it has room, else over the Code pane. */
  openTree(): void
  /** Open the tree at a folder: unfolded down to it, with the folder in view. */
  revealDir(dir: string): void
  setTreePinned(pinned: boolean): void
  /** Remember where the divider was dragged to with this Guide on show (null: back to its starting width). */
  setGuideWidth(guide: Guide, pct: number | null): void
  /** Remember where the divider was dragged to while the panes are stacked (null: back to the starting split). */
  setStackSplit(pct: number | null): void
  /** Make sure the Code pane is on screen: a jump to code is about to land in it. The Guide stays as it is. */
  revealCode(): void
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
  set(patch: Partial<Pick<Store, 'excludedOpen' | 'factsOpen' | 'diffMode' | 'docPath' | 'visualView' | 'composer' | 'tour' | 'status' | 'detailsOpen' | 'navOpen' | 'panelOpen' | 'treeOver' | 'closedDirs' | 'fileQuery' | 'guideWide' | 'codeWide' | 'front'>>): void
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

/** What a step of the trail carries beside its address: each Guide's own pick as it was
 *  at that step. The address names only the pick the Code pane follows; Back and Forward
 *  (and a reload) bring the other Guides' outlines back from here. */
interface StepState { picks: Partial<Record<Guide, CodePick>>
  /** the step was made by this tour (see Tour) */
  tour?: string }
/** The tour that made the step of the trail the page is at, if one did. */
const stepTour = (): string | undefined => { try { const t = (history.state as { tour?: unknown } | null)?.tour; return typeof t === 'string' ? t : undefined } catch { return undefined } }
/** The Guide a pick the address names was made in, when it is one of the links of the Guide
 *  on show (the Conversation, Spec & plan): that Guide keeps it as its own pick. `picks`:
 *  each Guide's own pick at this step of the trail, when the step says (`stepped`): the
 *  pick is the Guide's if it is the one the Guide has there. (A comment chosen in the top
 *  bar's menu is nobody's; a section can be the Walkthrough's.) An address with no step
 *  behind it, pasted or copied: a file or a line is taken to be a link of the Guide on show.
 *  None: the pick's shape says (a box, a section of the Walkthrough), or it is no Guide's. */
function madeIn(pick: CodePick | null, guide: Guide | null, picks: Partial<Record<Guide, CodePick>>, stepped: boolean): Guide | undefined {
  if (!pick || (guide !== 'conversation' && guide !== 'spec')) return undefined
  if (pickKey(picks[guide] ?? null) === pickKey(pick)) return guide
  return !stepped && 'file' in pick && !('section' in pick) ? guide : undefined
}
/** The pick the Code pane was narrowed to when the Guide pane was last closed (its key), if
 *  it was: opened again with that pick and the reviewer still in its code, the pane is
 *  given back narrowed. */
let closedNarrowed: string | null = null
function stepPicks(): Partial<Record<Guide, CodePick>> | null {
  try {
    const kept = (history.state as { picks?: Record<string, unknown> } | null)?.picks
    if (!kept || typeof kept !== 'object') return null
    const picks: Partial<Record<Guide, CodePick>> = {}
    for (const g of GUIDES) { const one = parsePick(JSON.stringify(kept[g] ?? null)); if (one) picks[g] = one }
    return picks
  } catch { return null }
}
/** Replace the hash without re-running the route (the review is already on screen). `state`: see StepState (none: as it was). */
function syncHash(route: Route, state?: StepState): void {
  try { history.replaceState(state ?? (history.state as unknown), '', routeHash(route)) } catch { /* ignore */ }
}
/** Add a step to the trail: the browser's history gets the new address, without the route
 *  being run again (pushState sends no hashchange). Back and Forward then arrive as
 *  hashchange, and applyRoute brings both panes back as the address says. */
function pushHash(route: Route, state: StepState): void {
  const hash = routeHash(route)
  try { if (window.location.hash !== hash) history.pushState(state, '', hash); else history.replaceState(state, '', hash) } catch { /* ignore */ }
}

/** Whether the sheet a phone-width window shows the code in is up at a step of the trail:
 *  at one with a pick, down at one without. (A pick made in another Guide than the one on
 *  show did not raise it: the reviewer changed Guide after it, and got that Guide whole.) */
const sheetUpAt = (guide: Guide | null, pick: CodePick | null, picks: Partial<Record<Guide, CodePick>>): boolean =>
  // (a section linked from another Guide than the Walkthrough is that Guide's own pick)
  guide == null || (pick != null && ((guideOfPick(pick) ?? guide) === guide || pickKey(picks[guide] ?? null) === pickKey(pick)))

export const useStore = create<Store>((set, get) => {
  const fail = (e: unknown): void => get().toast(errText(e), 'error')
  /** What belongs to the review on screen and must not outlive it: a tour, and toasts that would act on it. */
  const leftReview = (): Pick<Store, 'tour' | 'toasts'> => ({ tour: null, toasts: get().toasts.filter((t) => !t.action) })
  /** Bring the address up to date with where the reviewer now is (see How). */
  const move = (patch: { guide?: Guide; pick?: string; all?: boolean; commit?: string; focus?: string }, how: How, tour?: string): void => {
    const route = get().route
    if (route.name !== 'review' || how === 'follow') return
    // (from here on the address says where the reviewer is, the Guide pane closed included.
    // A jump the address names is left behind by the next step, and kept while the address
    // of its own step is brought up to date: that is what tells the step from the one before.)
    const next: Route = { ...route, focus: how === 'step' ? undefined : route.focus, ...patch, here: true, commits: undefined }
    const same = routeHash(next) === routeHash(route)
    // (the step a tour made stays that tour's while it is rewritten)
    const mark = tour ?? (how === 'step' && !same ? undefined : stepTour())
    const state: StepState = { picks: get().picks, ...(mark ? { tour: mark } : {}) }
    if (same) { syncHash(route, state); return }
    set({ route: next })
    if (how === 'step') pushHash(next, state)
    else syncHash(next, state)
  }
  /** Note where this review is being left: the Guide (and whether it has the whole width),
   *  each Guide's pick, the one the code follows, whether all files show, the tree's folded folders. */
  const saveLeft = (): void => {
    const { sessionId, loaded, guide, pick, picks, showAll, guideWide, codeWide, closedDirs } = get()
    if (sessionId == null || !loaded) return
    try { localStorage.setItem(`gr-left-${sessionId}`, JSON.stringify({ guide, pick, picks, all: showAll, wide: guide != null && guideWide, code: guide != null && codeWide && !guideWide, folded: closedDirs })) } catch { /* lasts for this page */ }
  }
  /** Whether a jump the address names (`focus=`) is played when the address is followed: not
   *  one to code outside the pick's, when the address says the Code pane is narrowed to the
   *  pick (the reviewer went back to the pick's code after the jump: "Only <the pick>"). */
  const plays = (t: FocusTarget): boolean => {
    const { guide, showAll, pick, loaded } = get()
    if (t.kind !== 'file' && t.kind !== 'diff') return true
    const to = guide != null && !showAll ? narrowingOf(pick, loaded) : null
    return !to || to.files.includes(loaded?.files.find((f) => f.path === t.file || f.oldPath === t.file)?.path ?? t.file)
  }
  /** A saved review has just been loaded: put the workspace where the address says, or,
   *  with a plain address, where the review was left in this browser. One never opened
   *  here opens on the Walkthrough when there is one, else with the Guide pane closed. */
  const arrive = (route: Route, loaded: LoadedReview, sessionId: number): void => {
    if (route.name !== 'review') return
    const left = readLeft(sessionId)
    const guide = route.here ? route.guide ?? null : left ? left.guide : loaded.state.walkthrough ? 'walkthrough' : null
    const pick = route.here ? parsePick(route.pick) : left?.pick ?? null
    const all = guide == null || (route.here ? Boolean(route.all) : Boolean(left?.all))
    // Each Guide's own pick is not in the address: it comes back from this step of the
    // trail (a reload) or from where the review was left in this browser, whatever the
    // address says of the Guide on show and of the pick the code follows.
    set({
      guide, front: guide ? 'guide' : 'code', picks: stepPicks() ?? left?.picks ?? {}, showAll: all,
      // (the tree's folded folders are as the review was left, whatever the address names)
      closedDirs: left?.folded ?? [],
      // an address of the Commits tab there once was: the commits are in Details now
      detailsOpen: Boolean(route.commits)
    })
    // (Whether this step of the trail, or where the review was left, says each Guide's own
    // pick. Asked before the address is brought up to date: that writes them into the step.)
    const stepped = stepPicks() != null || (!route.here && left != null)
    // the address says what is on show from here on (and loses what it named that made no sense)
    move({ guide: guide ?? undefined, pick: pickKey(pick) || undefined, all: all && guide != null ? true : undefined }, 'replace')
    const from = madeIn(pick, guide, get().picks, stepped)
    // (with all the files on show the pick is outlined, and the code is at its place among them)
    if (pick && all) { get().pickCode(pick, { from, how: 'replace' }); get().showAllFiles(true); showPick(pick, { placeOnly: true }) }
    else if (pick) showPick(pick, { from, how: 'replace' })
    if (get().front === 'code' && !sheetUpAt(guide, get().pick, get().picks)) set({ front: 'guide' })
    // The Guide had the whole width when the review was left: it has it again, with the plain
    // address or with the address of where it was left (a reload). Last: showing the pick's
    // code above brought the Code pane back; it stays narrowed to the pick, folded away.
    // (An address that names another pick is followed to that pick's code.)
    const asLeft = guide != null && left?.guide === guide && (!route.here || pickKey(pick) === pickKey(left.pick))
    if (asLeft && left?.wide) set({ guideWide: true })
    // (so has the code, where the panes are stacked and it had the whole height)
    else if (asLeft && left?.code) set({ codeWide: true })
    if (window.location.hash !== routeHash(get().route)) syncHash(get().route)
    saveLeft()
  }

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
      drift: null, dismissed: [], fileOpen: {}, fileLoaded: {}, mdSource: {}, excludedOpen: false, factsOpen: false, diffMode: 'all', docPath: null, visualView: null, pick: null, picks: {}, showAll: false, closedDirs: [], treeAt: null, treeOver: false,
      composer: null, tour: null, detailsOpen: false, fileQuery: '', wsOnly: []
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
    excludedOpen: false,
    factsOpen: false,
    diffMode: 'all',
    docPath: null,
    visualView: null,
    pick: null,
    picks: {},
    guideWidths: storedWidths(),
    showAll: false,
    composer: null,
    guide: null,
    guideWide: false,
    codeWide: false,
    front: 'code',
    stackSplit: ((): number | null => { try { const n = Number(localStorage.getItem('gr-stack-h')); return n > 0 && n < 100 ? n : null } catch { return null } })(),
    detailsOpen: false,
    view: {},
    reveal: null,
    treeWidth: storedTreeWidth(),
    wsOnly: [],
    diffView: pref('gr-diff-view', ['split', 'unified'] as const, null),
    // the tree as the reviewer last had it; else shown, but folded on a phone-width screen
    panelOpen: pref('gr-tree-open', ['0', '1'] as const, null) != null ? pref('gr-tree-open', ['0', '1'] as const, null) === '1' : typeof window === 'undefined' || window.innerWidth >= 760,
    treePinned: pref('gr-tree-pin', ['1'] as const, null) === '1',
    treeOver: false,
    closedDirs: [],
    treeAt: null,
    fileQuery: '',
    filters: { hideViewed: false, onlyCommented: false, bySection: pref('gr-by-section', ['1'] as const, null) === '1', showExcluded: false },
    treeView: pref('gr-files-view', ['tree', 'list'] as const, 'tree') ?? 'tree',
    tour: null,
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
      // the same review, another Guide or focus: nothing to load
      if (route.name === 'review' && route.session != null && route.session === get().sessionId && get().loaded) {
        const next = viewOfRoute(route)
        const cur = get().view
        // (the step being left: where the code is, for the way back to it)
        const leaving = get().route
        notePlace(routeHash(leaving))
        set({ route })
        // (Back, or Forward, out of the step a tour made ends the tour: its bar goes with it)
        const tour = get().tour
        if (tour && leaving.name === 'review' && leaving.focus && stepTour() !== tour.id) set({ tour: null })
        const guide = route.guide ?? null
        if (guide !== get().guide) get().showGuide(guide, 'follow')
        if (route.commits) set({ detailsOpen: true })       // (an address of the Commits tab there once was)
        if (Boolean(next.ignoreWhitespace) !== Boolean(cur.ignoreWhitespace) || (next.commit ?? '') !== (cur.commit ?? '')) { set({ view: next }); await get().reload() }
        if (stale()) return
        // The pick the Code pane follows, and whether all the files were on show: the pane
        // goes back to how it was at this step. (A pick of a Guide's link is that Guide's.)
        const pick = parsePick(route.pick)
        const same = pickKey(pick) === pickKey(get().pick)
        // each Guide's own pick as it was at this step: a section opened since is closed again, an outline made since goes
        const kept = stepPicks()
        if (kept) set({ picks: kept })
        const from = madeIn(pick, guide, get().picks, kept != null)
        // (an address typed or pasted into the open page carries no step: the pick it names is its Guide's own from here on)
        const its = from ?? guideOfPick(pick)
        if (!kept && pick && its && pickKey(get().picks[its] ?? null) !== pickKey(pick)) set({ picks: { ...get().picks, [its]: pick } })
        // A jump of the session's the address names (`focus=`). The step of one, left or come
        // back to, is where the Code pane goes back to how it was scrolled when this step was
        // last left; a step of one never seen left (a copied address) is played again.
        let replay: FocusTarget | null = null
        if (route.focus) { try { replay = JSON.parse(route.focus) as FocusTarget } catch { /* not a target */ } }
        // (a section's stop is in the address as the Guide and the pick already)
        if (replay && replay.kind === 'section' && route.pick) replay = null
        const jumped = replay != null || Boolean(route.focus) || (leaving.name === 'review' && Boolean(leaving.focus))
        const at = window.location.hash
        let placed = false
        if (guide == null || route.all) {
          const hold = holdCodePlace()
          // all the files, at another step than the pick's that is left: where they were when
          // that step was left, if it is remembered; else on the line they are on
          if (!same) get().pickCode(pick, { from, how: 'follow' })
          set({ showAll: true })
          placed = (!same || jumped) && backToPlace(at)
          if (!placed && !replay) hold.settle()
        } else if (!same || get().showAll) {
          // (back from a jump that left the pick's code, for all the files or for a section a tour
          // stopped at: the pick's code again, where it was)
          if (jumped && hasPlace(at) && (same || narrowingOf(pick, get().loaded))) { get().pickCode(pick, { from, how: 'follow' }); placed = backToPlace(at) }
          else showPick(pick, { from, how: 'follow' })
        } else if (jumped) placed = backToPlace(at)
        // (the sheet a phone-width window shows the code in follows the trail)
        if ((get().front === 'code') !== sheetUpAt(guide, get().pick, get().picks)) { parkCodePlace(); set({ front: sheetUpAt(guide, get().pick, get().picks) ? 'code' : 'guide' }) }
        if (window.location.hash !== routeHash(get().route)) syncHash(get().route)
        saveLeft()
        if (replay && !placed && plays(replay)) { const t = replay; window.setTimeout(() => focusAnchor(t), 60) }
        return
      }
      // a review opens with the Guide pane closed unless the address names a Guide
      const guide = route.name === 'review' ? route.guide ?? null : null
      set({ route, navOpen: false, guide, guideWide: false, codeWide: false, front: guide ? 'guide' : 'code', view: viewOfRoute(route), reveal: null })
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
          if (get().view.ignoreWhitespace && !route.w) { const r = routeWithView(route, get().view); set({ route: r }); syncHash(r) }
          arrive(route, loaded, route.session)
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
            const found = routeWithView({ name: 'review', session: match.sessionId, focus: route.focus, guide: route.guide, pick: route.pick, all: route.all, here: route.here, commits: route.commits }, get().view)
            set({ route: found })
            syncHash(found)
            arrive(found, loaded, match.sessionId)
          } else {
            // a preview: the diff with nothing saved — it is saved on the first write
            connect(null)
            const preview = (): Promise<LoadedReview> => load(() => api.previewReview(repo, base, compare, { direct, view: viewArg() }))
            const loaded = await preview().catch((e: unknown) => { if (!dropCommit(e)) throw e; return preview() })
            if (stale()) return
            showLoaded(loaded, null, { repo, base, compare, direct, fresh: Boolean(route.fresh) })
            if (route.commits) set({ detailsOpen: true })
          }
        } else {
          set({ loading: false })
        }
        if (route.focus) {
          try {
            const target = JSON.parse(route.focus)
            window.setTimeout(() => { if (plays(target)) focusAnchor(target) }, 250)
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
            sessionId, loaded: real, preview: null, route: routeWithView({ name: 'review', session: sessionId, guide: get().guide ?? undefined, pick: pickKey(get().pick) || undefined, all: get().showAll && get().guide != null ? true : undefined }, get().view),
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
      sectionEdits++
      set({ reviewedSections: next })
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

    showGuide(guide, how = 'step') {
      const cur = get()
      // (the Guide that is on show already: at most it comes back on show, where the code had
      // the whole height, and the sheet over it goes down)
      if (cur.guide === guide) {
        if (cur.front !== (guide ? 'guide' : 'code') || cur.codeWide) { parkCodePlace(); set({ front: guide ? 'guide' : 'code', codeWide: false }); saveLeft() }
        return
      }
      // the Code pane changes width under what is being read in it, or is folded away: hold it on that line
      parkCodePlace()
      const hold = holdCodePlace()
      // Opening or closing the Guide pane never changes what the Code pane shows. With the
      // pane closed it shows all the files; opened by the reviewer it goes on showing them,
      // where they were, until something is picked. (A review that opens on a Guide with
      // nothing picked shows the list of changed files.) Closed while the list was showing,
      // it returns to where the files were last read.
      const edge = (cur.guide == null) !== (guide == null)
      const narrowed = narrowingOf(cur.pick, cur.loaded)
      const fromList = guide == null && cur.guide != null && !cur.showAll && !cur.view.commit && !narrowed
      // Closed while the code was narrowed to the pick, and opened again with the same pick
      // while the reviewer is still in that pick's code: the pane is given back as it was,
      // narrowed. (Anywhere else among the files, they go on reading all of them.)
      const again = edge && guide != null && how !== 'follow' && closedNarrowed != null && closedNarrowed === pickKey(cur.pick) && Boolean(narrowed?.files.includes(cur.currentFile ?? ''))
      if (edge) closedNarrowed = guide == null && !cur.showAll && !cur.view.commit && narrowed ? pickKey(cur.pick) : null
      // (nothing is discarded: the Guide left behind is kept as it is, and so is a comment being written beside the code)
      set({ guide, front: guide ? 'guide' : 'code', treeOver: false, codeWide: false, ...(guide ? {} : { guideWide: false }), ...(edge && (guide == null || how !== 'follow') ? { showAll: !again } : {}) })
      move({ guide: guide ?? undefined, all: guide != null && get().showAll ? true : undefined }, how)
      if (fromList) backToPlace()
      hold.settle()
      if (how !== 'follow') saveLeft()
    },
    pickCode(pick, opts) {
      const how = opts?.how ?? 'step'
      // (In the Walkthrough the Guide's own pick is its open section. A line picked there
      // from the fact check is followed by the Code pane, and the section stays open.)
      const made = opts?.from ?? guideOfPick(pick)
      const from = made === 'walkthrough' && pick && !('section' in pick) ? null : made
      // (where the code is, for Back to this step, and, if all the files are on show, for the
      // way back from the list; a step being followed noted its own place when it was left)
      if (how !== 'follow') notePlace()
      // The pick the address names already, in the same Guide: no step is added for it (the
      // same pick twice in a row; "Only <the pick>" after "Show all files"). The address is
      // brought up to date, as it is for "Show all files".
      const route = get().route
      const again = how === 'step' && pick != null && route.name === 'review' && pickKey(pick) === (route.pick ?? '') && (route.guide ?? null) === get().guide
      // (a box is of one diagram: that diagram is the one on show in Visualize)
      set({ pick, showAll: false, treeOver: false, ...(pick && from ? { picks: { ...get().picks, [from]: pick } } : {}), ...(pick && 'box' in pick ? { visualView: pick.box[0] } : {}) })
      // (a pick the reviewer makes while one commit is on show leaves that view: the new step is without it)
      // (the Guide goes into the same step: a pick that also brought its Guide on show is one step, not two)
      move({ guide: get().guide ?? undefined, pick: pickKey(pick) || undefined, all: undefined, ...(how === 'step' ? { commit: undefined } : {}) }, again ? 'replace' : how)
      if (how !== 'follow') saveLeft()
    },
    jumpStep(target, tour) {
      // (one step for a whole tour: the step is its own while the page is at it)
      move({ focus: JSON.stringify(target) }, tour != null && stepTour() === tour ? 'replace' : 'step', tour)
    },
    clearPick(guide) {
      const cur = get()
      const mine = cur.picks[guide]
      if (!mine) return
      const picks = { ...cur.picks }
      delete picks[guide]
      // the Code pane was showing this pick's code: it shows all the files, where it is
      const followed = pickKey(cur.pick) === pickKey(mine)
      const hold = holdCodePlace()
      set({ picks, ...(followed ? { pick: null, showAll: true } : {}) })
      if (followed) move({ pick: undefined, all: cur.guide != null ? true : undefined }, 'step')
      else syncHash(get().route, { picks, ...(stepTour() ? { tour: stepTour() } : {}) })
      hold.settle()
      saveLeft()
    },
    showAllFiles(all) {
      const cur = get()
      if (cur.showAll === all) return
      // from the list of files there is no line to stay on: all the files come back where they were last read
      const fromList = all && cur.guide != null && !narrowingOf(cur.pick, cur.loaded)
      if (!all) notePlace()
      set({ showAll: all })
      move({ all: all && cur.guide != null ? true : undefined }, 'replace')
      if (fromList) backToPlace()
      saveLeft()
    },
    openTree() {
      if (treeHasRoom(get())) get().set({ panelOpen: true, treeOver: false })
      else set({ treeOver: true })
    },
    revealDir(dir) {
      get().openTree()
      set({ treeAt: { dir, seq: (get().treeAt?.seq ?? 0) + 1 } })
    },
    setTreePinned(pinned) {
      set({ treePinned: pinned, treeOver: false })
      if (pinned) get().set({ panelOpen: true })
      savePref('gr-tree-pin', pinned ? '1' : null)
    },
    setStackSplit(pct) {
      set({ stackSplit: pct })
      savePref('gr-stack-h', pct == null ? null : String(pct))
    },
    setGuideWidth(guide, pct) {
      const guideWidths = { ...get().guideWidths }
      if (pct == null) delete guideWidths[guide]
      else guideWidths[guide] = pct
      set({ guideWidths })
      savePref('gr-guide-w', JSON.stringify(guideWidths))
    },
    revealCode() {
      const { front, guideWide } = get()
      if (front !== 'code' || guideWide) { set({ front: 'code', guideWide: false }); saveLeft() }
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
    set(patch) {
      if ('guideWide' in patch || 'front' in patch) parkCodePlace()     // the Code pane may be folded away by this
      if (patch.panelOpen != null) savePref('gr-tree-open', patch.panelOpen ? '1' : '0')      // the tree, shown or hidden, is kept for all reviews
      set(patch)
      if ('guideWide' in patch || 'codeWide' in patch || 'closedDirs' in patch) saveLeft()       // part of where the review is being left
      if (patch.status) {
        if (statusTimer != null) window.clearTimeout(statusTimer)
        statusTimer = window.setTimeout(() => set({ status: null }), 8000)
      }
    },

    applyAction(action) {
      switch (action.kind) {
        // (a jump the session asked for is a step of the trail: Back returns from it)
        case 'focus': focusAnchor(action.target, { how: 'step' }); break
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
      // Nor does the session move anything while the reviewer is writing (the code they are
      // writing about would leave the screen): the jump waits behind a toast until they ask for it.
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
