import type { ChangedRange, FocusTarget, TourStop } from '@shared/types'
import { typing, useStore, type How } from './store'
import { baseName, cssq, narrowingOf, type CodePick, type Guide, type Pane } from './util'

// ── the panes ─────────────────────────────────────────────────
// The page itself never scrolls. The Code pane and each Guide scroll by themselves, and
// everything in this file that moves the reviewer moves one pane's own scroller: nothing
// here scrolls the window, and nothing uses scrollIntoView (which would move every
// scrollable box above its target, the frame of the workspace included).
/** A pane's scroller. A Guide has one once it has been shown; it is kept, hidden, while another Guide is. */
const scrollerFor = (pane: Pane): HTMLElement | null => document.querySelector<HTMLElement>(`[data-gr-scroll="${pane}"]`)
/** The Code pane's scroller: the column of file boxes. */
export const codeScroller = (): HTMLElement | null => scrollerFor('code')
/** The scroller an element sits in. */
const scrollerOf = (el: Element): HTMLElement | null => el.closest<HTMLElement>('[data-gr-scroll]')
/** Whether an element is drawn: it is not in a pane, or a Guide, that is hidden. */
const drawn = (el: Element): boolean => el.getClientRects().length > 0
/** How far below the top edge of its scroller an element is. */
const topIn = (el: Element, sc: Element): number => el.getBoundingClientRect().top - sc.getBoundingClientRect().top
/** Bring an element into view by scrolling the pane it is in, and only that: to the top of
 *  the pane, or to its middle (an element taller than the pane is shown from its top). */
export function showInPane(el: HTMLElement, at: 'top' | 'middle' = 'middle'): void {
  const sc = scrollerOf(el)
  if (!sc) return
  const h = el.getBoundingClientRect().height
  sc.scrollBy({ top: at === 'top' || h > sc.clientHeight - 16 ? topIn(el, sc) - 8 : topIn(el, sc) + h / 2 - sc.clientHeight / 2 })
}

/** Bring an element into view in its pane if any of it is out of view; one that is in view stays where it is. */
export function showIfOut(el: Element): void {
  const sc = scrollerOf(el)
  if (!sc || !drawn(el)) return
  const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect()
  if (r.top < s.top || r.bottom > s.bottom) showInPane(el as HTMLElement)
}

function selectorsFor(t: FocusTarget): string[] {
  switch (t.kind) {
    case 'summary': return ['[data-gr="summary"]']
    case 'section': return [`[data-gr-section="${cssq(t.sectionId)}"]`]
    case 'file': return [`[data-gr-file="${cssq(t.file)}"]`]
    case 'diff': {
      const file = `[data-gr-file="${cssq(t.file)}"]`
      // exact side first; a context line carries both numbers, so fall back to the
      // matching old/new number, then to the file box itself
      return [
        `[data-gr-line="${cssq(`${t.file}:${t.side}:${t.line}`)}"]`,
        // a Markdown file shown rendered: the block that line was written in
        `${file} [data-md-side="${t.side}"] [data-md-lines~="${t.line}"]`,
        `${file} [data-${t.side}="${t.line}"]`,
        file
      ]
    }
  }
}

/** The first of these selectors that matches something drawn, in one pane (`within`: its
 *  scroller) or on the whole page. The panes are all in the page at once, and a Guide that
 *  is not on show is still there, hidden: the same section, say, can be found in several. */
function find(sels: string[], within: ParentNode = document): HTMLElement | null {
  for (const s of sels) {
    try { for (const el of within.querySelectorAll<HTMLElement>(s)) if (drawn(el)) return el } catch { /* not a valid selector for this id */ }
  }
  return null
}

const PANE_NAMES: Record<Pane, string> = { code: 'the code', walkthrough: 'Walkthrough', conversation: 'Conversation', commits: 'Commits', spec: 'Spec & plan', visual: 'Visualize' }
type Spot = NonNullable<ReturnType<typeof useStore.getState>['returnTo']>
/** The reviewer's place in a pane: how far it is scrolled and, in the Code pane, the file
 *  under the top of the pane with how far down the pane it starts. Null when the pane is
 *  not on screen: there is no place in it to come back to. */
function whereAmI(pane: Pane): Spot | null {
  const sc = scrollerFor(pane)
  if (!sc || !drawn(sc)) return null
  const here: Spot = { pane, y: sc.scrollTop, top: null, label: PANE_NAMES[pane] }
  if (pane !== 'code') return here
  // the file the tree marks as the current one, when it is known; else the first one that reaches below the top of the pane
  const cur = useStore.getState().currentFile
  const at = cur ? sc.querySelector<HTMLElement>(`[data-gr-file="${cssq(cur)}"]`) : null
  for (const el of at ? [at] : sc.querySelectorAll<HTMLElement>('[data-gr-file]')) {
    const top = topIn(el, sc)
    if (at || top + el.offsetHeight > 24) return { ...here, top, label: baseName(el.dataset.grFile ?? ''), target: { kind: 'file', file: el.dataset.grFile ?? '' } }
  }
  return here
}
/** Whether a jump took the reviewer away from what they were reading in the pane it
 *  landed in: the file they were in (or, in a Guide, the Guide itself) is now about a
 *  pane's height or more from where it was. A shorter hop leaves the old spot on screen
 *  or one scroll away. */
function movedFrom(spot: Spot): boolean {
  const sc = scrollerFor(spot.pane)
  if (!sc) return false
  const el = spot.target && spot.top != null ? find(selectorsFor(spot.target).slice(-1), sc) : null
  const by = el && spot.top != null ? topIn(el, sc) - spot.top : sc.scrollTop - spot.y
  return Math.abs(by) > sc.clientHeight * 0.9
}

/** Run `then` on the first drawn element matching one of the selectors, once there is one
 *  (`pane`: looked for in that pane only, once the pane is on show). */
function whenMounted(sels: string[], then: (el: HTMLElement) => void, pane?: Pane, tries = 25): void {
  const sc = pane ? scrollerFor(pane) : null
  const el = pane ? (sc && drawn(sc) ? find(sels, sc) : null) : find(sels)
  if (el) then(el)
  else if (tries > 0) window.setTimeout(() => whenMounted(sels, then, pane, tries - 1), 40)
}

function flash(el: HTMLElement): void {
  el.classList.remove('gr-flash')
  void el.offsetWidth               // restart the animation on a repeat focus
  el.classList.add('gr-flash')
  window.setTimeout(() => el.classList.remove('gr-flash'), 1000)
}

/** The pane a target is shown in. Code is in the Code pane; the summary and the sections are in the Walkthrough. */
function paneOf(t: FocusTarget): Pane {
  return t.kind === 'file' || t.kind === 'diff' ? 'code' : 'walkthrough'
}
/** How a jump to code treats the narrowing of the Code pane. */
interface JumpOpts {
  /** the reviewer picked the destination themselves (a file in the tree, a box of a diagram): no "Back to …" pill */
  nav?: boolean
  /** the target is put at the top of the pane, to be read from its first line, instead of in its middle */
  top?: boolean
  /** The Guide the jump was made in, when it was made in one: a jump from a Guide to code
   *  is a pick, and the Code pane is narrowed to it. (`end`: the pick is the lines up to there.) */
  from?: Guide | null
  end?: number
  /** leave the narrowing whatever the target (a click in the tree): all the files, at this one */
  all?: boolean
  /** the target is the pick's own code: the narrowing is set already, and stays */
  picked?: boolean
}
/** Take one pane to a target and flash it: a jump. Code is shown in the Code pane and the
 *  Guide beside it does not move; the summary and the sections are shown in the
 *  Walkthrough, which becomes the Guide on show (a section is opened there, and is then
 *  that Guide's pick). Whatever would hide the target gives
 *  way first: a Code pane folded away comes back, a narrowing the target is not part of is
 *  left for all the files, filters that hide the file are lifted, a collapsed file is
 *  opened, and a diff held back as large or generated is loaded.
 *  A jump the reviewer did not aim themselves (a comment in a menu, the session showing
 *  something) leaves a "Back to …" pill when it takes the pane far from where it was. */
export function focusAnchor(t: FocusTarget, opts: JumpOpts = {}): void {
  const st = useStore.getState()
  // from a Guide to code: a pick
  if (opts.from && (t.kind === 'file' || t.kind === 'diff')) {
    showPick(t.kind === 'file' ? { file: t.file } : { file: t.file, side: t.side, line: t.line, end: opts.end }, { from: opts.from })
    return
  }
  // during a tour the way back leads to where the tour started, from whichever stop
  jump(t, opts.nav ? null : st.tour?.origin ?? whereAmI(paneOf(t)), opts)
}
/** Make something the pick and show its code: the Code pane is narrowed to it, taken to its
 *  lines and flashes them, and the Guide it was picked in (`from`; a box and a section say
 *  theirs) does not move and keeps it outlined. A step of the trail unless `how` says
 *  otherwise (see How). A pick is the reviewer's own aim, so it leaves no "Back to …" pill.
 *  Returns false when it has no code to show (a box that is not code, something that is
 *  gone): nothing changes then, except that an address naming such a pick is followed to
 *  no pick. */
export function showPick(pick: CodePick | null, opts: { from?: Guide | null; how?: How; placeOnly?: boolean } = {}): boolean {
  const st = useStore.getState()
  const how = opts.how ?? 'step'
  // (`placeOnly`: it is the pick already, with all the files on show: the code only goes to its place among them)
  if (opts.placeOnly) {
    const at = st.view.commit ? null : narrowingOf(pick, st.loaded)
    const where = at?.file ?? at?.files[0]
    if (!at || !where) return false
    if (at.line != null && at.side === 'new') focusLines(where, at.line, at.end ?? at.line, { nav: true, picked: true })
    else focusAnchor({ kind: 'file', file: where }, { nav: true, top: true, picked: true })
    return true
  }
  if (!pick) { st.pickCode(null, opts); return false }
  // While the Code pane shows one commit only, the page has that commit's files, not the
  // comparison's. An address that names both is followed as it is: the commit is shown,
  // and the pick is kept for when all changes are. A pick the reviewer makes leaves the
  // commit view: the step is made first, so that Back returns to the commit as it was
  // shown, then the comparison is loaded and the pick found in it.
  if (st.view.commit) {
    st.pickCode(pick, opts)
    if (how === 'step') void st.setView({ commit: undefined }).then(() => { if (!useStore.getState().view.commit) showPick(pick, { ...opts, how: 'replace' }) })
    return true
  }
  const to = narrowingOf(pick, st.loaded)
  if (!to) { if (how !== 'step') st.pickCode(null, { how: 'replace' }); return false }
  st.pickCode(pick, opts)
  const file = to.file ?? to.files[0]
  // (a section none of whose files are part of the comparison any more: it is open in the Walkthrough, with no code to show)
  if (!file) { st.toast(`None of the files of ${to.label.replace(/ \(.*$/, '')} are part of this comparison any more, so there is no code to show for it.`, 'info', undefined, { key: 'section-gone' }); return true }
  if (to.line != null && to.side === 'new') focusLines(file, to.line, to.end ?? to.line, { nav: true, picked: true })
  else if (to.line != null) focusAnchor({ kind: 'diff', file, side: 'old', line: to.line }, { nav: true, picked: true })
  else focusAnchor({ kind: 'file', file }, { nav: true, top: true, picked: true })
  return true
}
/** Open a section of the walkthrough: the Walkthrough becomes the Guide on show with that
 *  section open in place, and the section is its pick, so the Code pane is narrowed to the
 *  section's files. `file`: the one of them to go to (else the first not yet viewed).
 *  `keep`: the reviewer is reading that file already (they asked from its header): the
 *  code stays on the line it shows. */
export function openSection(id: string, opts: { file?: string; keep?: boolean; how?: How } = {}): void {
  const st = useStore.getState()
  if (!st.loaded?.state.walkthrough?.sections.some((s) => s.id === id)) return
  const how = opts.how ?? 'step'
  const hold = opts.keep ? holdCodePlace() : null
  // (the Guide comes on show and the section is picked in one step of the trail: the pick makes it)
  st.showGuide('walkthrough', how === 'step' ? 'follow' : how)
  const pick: CodePick = { section: id, ...(opts.file ? { file: opts.file } : {}) }
  if (hold) { useStore.getState().pickCode(pick, { how }); hold.settle() } else showPick(pick, { how })
}
/** Start a tour at one of its stops, remembering where the reviewer was in the code. */
export function startTour(stops: TourStop[], loop?: boolean, idx = 0): void {
  const st = useStore.getState()
  if (!stops[idx]) return
  st.set({ tour: { stops, idx, loop, origin: st.tour?.origin ?? whereAmI('code') ?? undefined } })
  focusAnchor(stops[idx].target)
}
/** `origin`: where to offer the way back to, if the jump takes its pane far from there. */
function jump(t: FocusTarget, origin: Spot | null, opts: JumpOpts = {}): void {
  const top = Boolean(opts.top)
  const st = useStore.getState()
  const loaded = st.loaded
  if (!loaded) return
  const to = paneOf(t)
  // The way back is offered once the jump has landed, if it took its pane far. A place in
  // another pane needs none: that pane has not moved (and a Guide swapped for another is
  // kept as it was). Any other jump makes a remembered spot stale.
  const from = origin?.pane === to ? origin : null
  st.set({ returnTo: null })
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => jump(t, origin, opts)); return }
  // (a step of the trail whoever asked, the reviewer or the session: Back returns to where the reviewer was)
  if (t.kind === 'summary') st.showGuide('walkthrough')
  else if (t.kind === 'section') openSection(t.sectionId)
  else {
    parked = null                     // the Code pane is about to be somewhere else than it was folded away on
    st.revealCode()
    if (st.treeOver) st.set({ treeOver: false })       // (a tree that lies over the code would cover what is being shown)
    const file = loaded.files.find((f) => f.path === t.file || f.oldPath === t.file)
    if (st.diffMode !== 'all') st.set({ diffMode: 'all' })
    if (!opts.picked) {
      // Beside a Guide the pane may be narrowed to the pick (or to the list of files): a
      // target outside that is shown among all the files. A target that is part of it leaves it be.
      if (st.guide != null && !st.showAll && (opts.all || !narrowingOf(st.pick, loaded)?.files.includes(file?.path ?? t.file))) st.showAllFiles(true)
      // (the pick's own files are shown whatever the filters say: only a jump among all the files lifts them)
      if (st.fileQuery) st.set({ fileQuery: '' })
      const lift: Partial<typeof st.filters> = {}
      if (st.filters.hideViewed && file?.viewed === 'viewed') lift.hideViewed = false
      if (st.filters.onlyCommented) lift.onlyCommented = false
      if (file?.excluded && !st.filters.showExcluded) lift.showExcluded = true
      if (Object.keys(lift).length) st.setFilters(lift)
    }
    st.setFileOpen(file?.path ?? t.file, true)
    if (t.kind === 'diff') {
      // a rendered Markdown file shows its new side only: a removed line is in the source diff
      if (t.side === 'old' && file && file.status !== 'deleted') st.setMdSource(file.path, true)
      // a line cannot be shown in a diff that is held back: load it
      st.setFileLoaded(file?.path ?? t.file)
      // a line outside the diff's hunks is fetched and shown in place by its file box
      st.revealLine(file?.path ?? t.file, t.side, t.line)
    }
  }
  const sels = selectorsFor(t)
  let tries = 0
  const tick = (): void => {
    // give the exact selector a few frames to mount before accepting a fallback
    const usable = tries < (t.kind === 'diff' ? 30 : 8) ? sels.slice(0, t.kind === 'diff' ? 2 : 1) : sels
    // (the pane may still be coming on show: a Guide being mounted, the Code pane unfolding)
    const sc = scrollerFor(to)
    const el = sc && drawn(sc) ? find(usable, sc) : null
    if (el && sc) {
      const land = (): void => {
        showInPane(el, top ? 'top' : 'middle')
        arriveAt(el)
      }
      land()
      // once more after late layout (a section opening beside the code changes every height above), unless the reviewer has scrolled since
      if (top) { const y = sc.scrollTop; window.setTimeout(() => { if (el.isConnected && sc.scrollTop === y) land() }, 150) }
      flash(el)
      if (from && movedFrom(from)) useStore.getState().set({ returnTo: from })
      return
    }
    if (tries++ < 45) window.setTimeout(tick, 40)
  }
  window.requestAnimationFrame(tick)
}

/** Show a question asked from a spot where it sits in the Conversation: that Guide comes
 *  on show with the question's message in the middle of it, flashed. Asked from within
 *  the Conversation itself, far from there, it leaves the way back. */
export function focusQuestion(requestId: string): void {
  const st = useStore.getState()
  const m = st.loaded?.state.messages.find((x) => x.role === 'user' && x.requestId === requestId)
  const origin = st.guide === 'conversation' ? whereAmI('conversation') : null
  st.set({ returnTo: null })
  st.showGuide('conversation')
  if (!m) return
  whenMounted([`[data-gr-message="${cssq(m.id)}"]`], (el) => {
    showInPane(el)
    flash(el.querySelector<HTMLElement>('.tl-box') ?? el)
    if (origin && movedFrom(origin)) useStore.getState().set({ returnTo: origin })
  }, 'conversation')
}

/** Return a pane to where it was before a jump: in the Code pane the same file at the
 *  same height, its header flashed so the eye finds it; a Guide scrolled as it was. */
export function goBack(): void {
  const st = useStore.getState()
  const back = st.returnTo
  if (!back) return
  st.set({ returnTo: null })
  if (back.pane === 'code') st.revealCode()
  else st.showGuide(back.pane)
  const sels = back.target ? selectorsFor(back.target).slice(-1) : []
  let tries = 0
  const place = (): HTMLElement | null => {
    const sc = scrollerFor(back.pane)
    if (!sc) return null
    const el = find(sels, sc)
    // put the thing the link sat in back at the same height in the pane
    if (el && back.top != null) sc.scrollBy({ top: topIn(el, sc) - back.top })
    else sc.scrollTo({ top: back.y })
    return el
  }
  const tick = (): void => {
    // a pane that was folded away has to lay out again before the old position exists
    const sc = scrollerFor(back.pane)
    const ready = sc != null && drawn(sc) && sc.scrollHeight - sc.clientHeight >= back.y - sc.clientHeight
    if (!(ready && (find(sels, sc) || !sels.length)) && tries++ < 45) { window.setTimeout(tick, 40); return }
    const el = place()
    window.setTimeout(place, 150)     // once more, after late layout (wrapped lines, highlighting)
    const head = el?.querySelector<HTMLElement>('.file-head') ?? el
    if (head) flash(head)
  }
  window.requestAnimationFrame(tick)
}

/** A thing on show in the Code pane and how far below the top of the pane it is. */
interface Held { sel: string; top: number; el: HTMLElement }
/** What the reviewer is reading in the Code pane, as something that can be found again
 *  after the pane lays out anew: the first diff line under the file header pinned to the
 *  top of the pane (by its address, since switching between split and unified replaces
 *  the rows), or failing that the file box there. Empty while the pane is folded away. */
function readingSpot(): Held[] {
  const sc = codeScroller()
  if (!sc || !drawn(sc)) return []
  const same = asPut<Held[]>(sc)
  if (same && same[0]?.el.isConnected) return same
  const r = sc.getBoundingClientRect()
  let box: Held | null = null
  for (let y = r.top + 44; y < r.bottom; y += 20) {
    const at = document.elementFromPoint(r.left + 80, y)
    const file = at?.closest<HTMLElement>('[data-gr-file]')
    if (file) box ??= { sel: `[data-gr-file="${cssq(file.dataset.grFile ?? '')}"]`, top: topIn(file, sc), el: file }
    const line = at?.closest('.dr-wrap')?.querySelector<HTMLElement>('[data-gr-line]')
    if (line && box) return [{ sel: `[data-gr-line="${cssq(line.dataset.grLine ?? '')}"]`, top: topIn(line, sc), el: line }, box]
  }
  return box ? [box] : []
}
/** What the Code pane showed when it was last folded away (the Guide took the whole
 *  width, or the window shows one pane at a time). It can come back at another width than
 *  it left with, where the same scroll offset is other code: it is put back on the line. */
let parked: { spots: Held[]; y: number } | null = null
/** Note the Code pane's place: it may be about to be folded away. (No-op while it is.) */
export function parkCodePlace(): void {
  const spots = readingSpot()
  if (spots.length) parked = { spots, y: codeScroller()?.scrollTop ?? 0 }
}
/** The Code pane is on show again: put it on the line it was folded away on, now and after
 *  late layout, unless a jump has taken it elsewhere meanwhile. `y`: how far it was
 *  scrolled when it was folded away; if that is not where its place was noted, the
 *  reviewer scrolled in between, and the note is of an older place. */
export function unparkCodePlace(y: number): void {
  const mine = parked
  if (!mine || Math.abs(mine.y - y) > 2) return
  const place = (): void => { if (parked === mine) putBack(mine.spots) }
  place()
  holding(place, true).settle()
}
/** Where a pane was last put by a hold, and how it then was (scrolled how far, how tall,
 *  how wide). While it is still exactly so, nobody has scrolled it and nothing in it was
 *  laid out anew, and the next hold starts from the same line at the same height instead of
 *  reading the pane again: a round trip through another width (to the Conversation and
 *  back, the whole width and back) then ends where it began, not a wrapped line further
 *  on, nor wherever a shorter layout in between could not scroll to. */
const lastPut = new WeakMap<HTMLElement, { spots: unknown; y: number; h: number; w: number }>()
const putAt = (sc: HTMLElement, spots: unknown): void => { lastPut.set(sc, { spots, y: sc.scrollTop, h: sc.scrollHeight, w: sc.clientWidth }) }
function asPut<T>(sc: HTMLElement): T | null {
  const was = lastPut.get(sc)
  return was && Math.abs(was.y - sc.scrollTop) < 1.5 && was.h === sc.scrollHeight && was.w === sc.clientWidth ? (was.spots as T) : null
}
/** Where all the files were last being read, noted when they give way to the pick's code or
 *  to the list of changed files: the list has no line to hold on to, so "Show all files"
 *  from it, or closing the Guide pane while it shows, returns here. */
let allPlace: Held[] | null = null
export function noteAllPlace(): void {
  const st = useStore.getState()
  if (st.guide != null && !st.showAll && !st.view.commit) return     // (narrowed: what is on show is not all the files)
  const spots = readingSpot()
  if (spots.length) allPlace = spots
}
export function returnToAllPlace(): void {
  const mine = allPlace
  if (mine) holding(() => putBack(mine), true).settle()
}
/** Put the Code pane back on what it showed: the line if it is still there, else the file it was in. */
function putBack(spots: Held[]): void {
  const sc = codeScroller()
  if (!sc || !drawn(sc)) return
  for (const spot of spots) {
    const el = spot.el.isConnected ? spot.el : find([spot.sel], sc)
    if (el && drawn(el)) {
      const by = topIn(el, sc) - spot.top
      if (Math.abs(by) >= 1) sc.scrollBy({ top: by })
      putAt(sc, spots)
      return
    }
  }
}
/** The parts of a Guide that can be held on to: the pieces of text, the rows and the boxes of a diagram. */
const GUIDE_PARTS = 'p, li, h1, h2, h3, h4, pre, textarea, [data-gr-node], .dr-wrap, .list-row, .tl-event, .thread-head, .viz-legend'
/** What is at the top of the Guide on show, and how far below the top of its scroller:
 *  the element itself, which is kept when the Guide is laid out for another width (text
 *  wraps anew, the boxes of a diagram move). Null when no Guide is on show or it is at its top. */
function guideSpot(): { sc: HTMLElement; el: Element; top: number } | null {
  const sc = [...document.querySelectorAll<HTMLElement>('[data-gr-guide]')].find(drawn)
  if (!sc) return null
  const same = asPut<{ sc: HTMLElement; el: Element; top: number }>(sc)
  if (same?.el.isConnected) return same
  if (sc.scrollTop < 1) return null
  const line = sc.getBoundingClientRect().top + 4
  for (const el of sc.querySelectorAll(GUIDE_PARTS)) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.bottom > line) return { sc, el, top: topIn(el, sc) }
  }
  return null
}
/** What `hold…Place` hands back. `now` puts the place back at once (each step of a drag);
 *  `settle` puts it back once the change is drawn, and again after late layout (a diagram
 *  laid out anew, a diff gone unified), unless the reviewer has moved on by then. */
interface Hold { now: () => void; settle: () => void }
function holding(put: () => void, any: boolean): Hold {
  return {
    now: put,
    settle: () => {
      if (!any) return
      let live = true
      const stop = (): void => { live = false }
      const moves = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
      for (const m of moves) window.addEventListener(m, stop, { capture: true, passive: true, once: true })
      const place = (): void => { if (live) put() }
      window.requestAnimationFrame(place)
      window.setTimeout(place, 150)
      window.setTimeout(() => { place(); for (const m of moves) window.removeEventListener(m, stop, { capture: true }) }, 420)
    }
  }
}
/** Hold the Code pane on the line it shows while its width changes under it: a Guide
 *  opens, closes or gives way to one of another width, a section opens beside the code.
 *  A narrower pane wraps more lines, and may turn a split diff into a unified one, so
 *  everything above the line changes height. Call it before the change. */
export function holdCodePlace(): Hold {
  const spots = readingSpot()
  return holding(() => putBack(spots), spots.length > 0)
}
/** Hold both panes where they are while the width between them is shared out anew (the
 *  divider is dragged, the Guide takes the whole width or gives it back): the Code pane
 *  on its line, the Guide on what is at its top. Call it before the change. */
export function holdPlaces(): Hold {
  const spots = readingSpot()
  const guide = guideSpot()
  return holding(() => {
    putBack(spots)
    if (guide && guide.el.isConnected && drawn(guide.sc)) {
      const by = topIn(guide.el, guide.sc) - guide.top
      if (Math.abs(by) >= 1) guide.sc.scrollBy({ top: by })
      putAt(guide.sc, guide)
    }
  }, spots.length > 0 || guide != null)
}

/** Show a section's header among the files (the files grouped by section): all the files, at that header. */
export function showSectionHeader(id: string): void {
  useStore.getState().showAllFiles(true)
  whenMounted([`[data-gr-section="${cssq(id)}"]`], (el) => showInPane(el, 'top'), 'code')
}

/** one toast about a changed range at a time */
const CHANGED_KEY = 'changed-range'
/** Go to the lines a resolution says were changed for a comment, and flash all of them.
 *  The numbers are those of the whole comparison when the fix was recorded, and the fix is
 *  shown in the code as it is now, so whatever else is on screen gives way first: a page
 *  whose code is behind (the "this comparison changed" banner is up) folds the new code
 *  in, and a commit view (another diff, where the same numbers are other lines) is left.
 *  The numbers are not re-anchored, so what cannot be shown is said: a file that left the
 *  comparison, lines that are no longer there, a first line that reads differently now.
 *  A jump like any other the reviewer did not aim themselves: `focusAnchor` leaves the
 *  way back. */
export async function focusChanged(r: ChangedRange, from?: Guide | null): Promise<void> {
  const lines = r.end > r.start ? `lines ${r.start}–${r.end}` : `line ${r.start}`
  const was = useStore.getState()
  // Folding in newer code redraws every diff, and with it any comment or reply being
  // written there: that is the reviewer's to decide, with the banner's own button.
  if (was.drift && typing()) { was.toast('The code changed since this page loaded it. Refresh first (the banner at the top) to see these lines: refreshing discards text you have not sent.', 'info', undefined, { key: CHANGED_KEY }); return }
  if (was.view.commit) await was.setView({ commit: undefined })
  else if (was.drift) await was.reload()
  const st = useStore.getState()
  const say = (text: string): void => st.toast(text, 'info', undefined, { key: CHANGED_KEY })
  const file = st.loaded?.files.find((f) => f.path === r.file || f.oldPath === r.file)
  if (!file) { say(`${r.file} is no longer part of this comparison, so ${lines} cannot be shown.`); return }
  // the fix is lines of the source: a Markdown file is shown as its source diff
  st.setMdSource(file.path, true)
  focusAnchor({ kind: 'diff', file: file.path, side: 'new', line: r.start }, { from, end: r.end })
  const first = `[data-gr-line="${cssq(`${file.path}:new:${r.start}`)}"]`
  let tries = 0
  const tick = (): void => {
    if (find([first], codeScroller() ?? document)) {
      // focusAnchor has scrolled to the first line by now, or does at its next look
      window.setTimeout(() => flashRange(file.path, r), 60)
      // a later edit shifted or rewrote the lines
      const now = file.hunks.flatMap((h) => h.lines).find((l) => l.new === r.start)?.text
      if (now !== undefined && now !== r.lineContent) say(`${baseName(file.path)} changed after this fix was recorded: ${lines} may no longer be the fix.`)
    } else if (tries++ < 50) window.setTimeout(tick, 40)
    // focusAnchor has fallen back to the file by now
    else say(`${lines[0].toUpperCase()}${lines.slice(1)} of ${baseName(file.path)} ${r.end > r.start ? 'are' : 'is'} not there any more: the file changed after this fix was recorded.`)
  }
  window.requestAnimationFrame(tick)
}
/** The lines of a file's new side that are in the Code pane, from `start` to `end`. */
function linesOf(file: string, start: number, end: number): HTMLElement[] {
  return [...(codeScroller()?.querySelectorAll<HTMLElement>(`[data-gr-file="${cssq(file)}"] [data-new]`) ?? [])].filter((el) => { const n = Number(el.dataset.new); return n >= start && n <= end })
}
/** Show lines of a changed file in the Code pane and flash all of them: the code a pick
 *  stands for (a box of a diagram, a range a comment was answered with). */
function focusLines(file: string, start: number, end: number, opts: JumpOpts = {}): void {
  // exact lines are asked for: a Markdown file is shown as its source
  if (end > start) useStore.getState().setMdSource(file, true)
  focusAnchor({ kind: 'diff', file, side: 'new', line: start }, opts)
  if (end <= start) return
  // the lines of the range between the hunks are not on the page: have them fetched too
  useStore.getState().revealLine(file, 'new', start, end)
  // flash once every line of the range is on the page (as many as a jump fetches, for a
  // very long one), or after a moment whatever of it is
  const want = Math.min(end - start + 1, 400)
  const have = (): number => new Set(linesOf(file, start, end).map((el) => Number(el.dataset.new))).size
  let tries = 0
  const tick = (): void => {
    if (have() >= want || tries++ > 40) { if (have()) flashRange(file, { file, start, end, lineContent: '' }); return }
    window.setTimeout(tick, 50)
  }
  window.setTimeout(tick, 60)
}
/** Flash every line of a range that is in the Code pane, and bring the range into view
 *  there: centred when it fits, else with its first line near the top. */
function flashRange(file: string, r: ChangedRange): void {
  const sc = codeScroller()
  const els = linesOf(file, r.start, r.end)
  if (!sc || !els.length || !drawn(sc)) return
  const top = topIn(els[0], sc); const bottom = topIn(els[els.length - 1], sc) + els[els.length - 1].getBoundingClientRect().height
  const room = sc.clientHeight
  sc.scrollBy({ top: bottom - top < room * 0.6 ? (top + bottom - room) / 2 : top - room * 0.3 })
  arriveAt(els[0])                    // the file these lines are in is where the reviewer now is
  for (const el of els) {
    el.classList.remove('gr-flash', 'gr-flash-range')
    void el.offsetWidth               // restart the animation on a repeat click
    el.classList.add('gr-flash-range')
    window.setTimeout(() => el.classList.remove('gr-flash-range'), 1800)
  }
}

/** The file the reviewer was just taken to, and where its box then was in the Code pane.
 *  A file is not always under the top of the pane after a jump to it (one near the end
 *  of the list cannot be brought up that far; a line is shown in the middle): until the
 *  reviewer scrolls, it is still the file they are at. */
let arrived: { box: HTMLElement; top: number } | null = null
function arriveAt(el: HTMLElement): void {
  const box = el.closest<HTMLElement>('[data-gr-file]')
  const sc = box && scrollerOf(box)
  if (!box || !sc) return
  arrived = { box, top: topIn(box, sc) }
  useStore.setState({ currentFile: box.dataset.grFile ?? null })
}
/** The file under the top of the Code pane (`sc`: its scroller): the first of `boxes` (the
 *  file boxes, in order) to reach below the top of a file header pinned there. Between two
 *  files, or on a section's header, that is the next file down; past the last one it stays
 *  the last. A binary search: a handful of rectangles are read however many files there
 *  are and however long their diffs (asking the document what lies at a point costs tens
 *  of milliseconds on a long review, and finding the boxes anew walks every line of every
 *  diff). */
function fileAtTop(boxes: HTMLElement[], sc: HTMLElement): HTMLElement | null {
  if (arrived) {
    if (arrived.box.isConnected && Math.abs(topIn(arrived.box, sc) - arrived.top) < 4) return arrived.box
    arrived = null
  }
  if (!boxes.length) return null
  const line = sc.getBoundingClientRect().top + 24
  let lo = 0
  let hi = boxes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (boxes[mid].getBoundingClientRect().bottom > line) hi = mid
    else lo = mid + 1
  }
  return boxes[lo]
}
/** Keep the store's `currentFile` true while the Code pane is on screen (`list`: the
 *  column of file boxes inside the pane's scroller, which the caller follows anew when it
 *  draws other boxes or draws them in another order). Scrolling the pane asks for one
 *  reading on the next frame, however many scroll events arrive before it; so does the
 *  list changing height under a still pane (a file folds, a diff loads) and the pane
 *  itself changing size (the window, the divider). Returns the way to stop. */
export function followFiles(list: HTMLElement): () => void {
  const sc = scrollerOf(list)
  if (!sc) return () => { /* not in a pane: nothing to follow */ }
  // (A file outside the narrowing is kept, hidden: it has no place, and is not one the
  // reviewer can be at. The boxes are taken in the order they are drawn in, which for a
  // section's files is the walkthrough's order, not the list's.)
  const collect = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[data-gr-file]:not([hidden])')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  let boxes = collect()
  let frame = 0
  const read = (): void => {
    frame = 0
    if (!drawn(sc)) return            // folded away: the file the reviewer was at stays the one
    let box = fileAtTop(boxes, sc)
    // drawn again since they were collected (boxes that are gone have no place, so the search ends on one)
    if (box && !box.isConnected) { boxes = collect(); box = fileAtTop(boxes, sc) }
    const file = box?.dataset.grFile
    if (file != null && file !== useStore.getState().currentFile) useStore.setState({ currentFile: file })
  }
  const soon = (): void => { frame ||= window.requestAnimationFrame(read) }
  const ro = new ResizeObserver(soon)
  ro.observe(list)
  ro.observe(sc)
  sc.addEventListener('scroll', soon, { passive: true })
  soon()
  return () => {
    ro.disconnect()
    sc.removeEventListener('scroll', soon)
    if (frame) window.cancelAnimationFrame(frame)
  }
}
