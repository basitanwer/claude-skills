import type { ChangedRange, FocusTarget, TourStop } from '@shared/types'
import { typing, useStore, type How } from './store'
import { baseName, cssq, narrowingOf, newId, PANES_SETTLED, pickKey, type CodePick, type Guide, type Pane } from './util'

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
/** How much of the foot of a pane lies under the tour's bar (which floats over the page), in px. */
function underTour(sc: HTMLElement): number {
  const bar = document.querySelector('[data-gr="tour"]')
  if (!bar) return 0
  const b = bar.getBoundingClientRect(); const s = sc.getBoundingClientRect()
  return b.right <= s.left || b.left >= s.right || b.bottom <= s.top ? 0 : Math.max(0, s.bottom - b.top)
}
/** The height of a pane that can be read: what the tour's bar does not lie over. */
const roomIn = (sc: HTMLElement): number => sc.clientHeight - underTour(sc)
/** Bring an element into view by scrolling the pane it is in, and only that: to the top of
 *  the pane, or to its middle (an element taller than the pane is shown from its top).
 *  While a tour's bar lies over the foot of the pane, the middle is that of what is left
 *  above the bar; where that is little (a short window, the panes stacked), the element
 *  goes just under the file header pinned to the top, so that the lines after it show too. */
export function showInPane(el: HTMLElement, at: 'top' | 'middle' = 'middle'): void {
  const sc = scrollerOf(el)
  if (!sc) return
  const h = el.getBoundingClientRect().height
  const room = roomIn(sc)
  const middle = room === sc.clientHeight ? room / 2 - h / 2 : Math.min(room / 2 - h / 2, Math.max(44, room - h - 80))
  sc.scrollBy({ top: at === 'top' || h > room - 16 ? topIn(el, sc) - 8 : topIn(el, sc) - middle })
}

/** Scroll an element's pane by the least that brings the element into view (nothing, when it is). */
function keepInView(el: Element): void {
  const sc = scrollerOf(el)
  if (!sc || !drawn(el)) return
  const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect()
  if (r.bottom > s.bottom - 8) sc.scrollBy({ top: Math.min(r.bottom - s.bottom + 8, r.top - s.top - 8) })
  else if (r.top < s.top + 8) sc.scrollBy({ top: r.top - s.top - 8 })
}
/** A box that has just opened in a pane (a comment being written): the pane is scrolled by
 *  the least that shows the whole of it, its buttons too. */
export const showWhole = (el: Element): void => keepInView(el)
/** A Guide that was scrolled to keep its pick in view while the sheet with the pick's code
 *  is up (a phone-width window: the sheet leaves the Guide the upper third). `y`: how far
 *  the Guide was scrolled before the sheet went up, and `by` how far it has been scrolled
 *  for the sheet since (`carry` of it for earlier picks); `el`: the pick, and `home` how far
 *  below the top of the Guide it was before it was brought into view; `put`: where the
 *  Guide was scrolled to. */
export interface Lift { sc: HTMLElement; el: Element | null; home: number; carry: number; by: number; y: number; put: number }
/** Whether a Guide is still where it was put for the sheet: the reviewer has not scrolled it since. */
export function liftHolds(lift: Lift): boolean {
  const { sc } = lift
  // (a Guide that got its whole height back cannot be scrolled as far as it was)
  return drawn(sc) && Math.abs(sc.scrollTop - Math.min(lift.put, sc.scrollHeight - sc.clientHeight)) <= 2
}
/** The sheet is up over the Guide on show (`sc`: its scroller): scroll the Guide by the
 *  least that keeps the pick in view above the sheet. `was`: what an earlier call for the
 *  same pick handed back (it is called again after late layout); `from`: what the Guide
 *  had been scrolled by for the sheet already, and from where, when this pick was made. */
export function liftPick(sc: HTMLElement, was: Lift | null, from: { by: number; y: number }): Lift {
  const el = pickIn(sc)
  const lift = was && was.el === el ? was : { sc, el, home: el ? topIn(el, sc) : 0, carry: from.by, by: from.by, y: from.y, put: 0 }
  if (el) {
    keepInView(el)
    // (how far the pick now is above where it was: the same however often this is called for it)
    lift.by = lift.carry + lift.home - topIn(el, sc)
  }
  lift.put = sc.scrollTop
  return lift
}
/** The link to code that was last pressed. The same line can be linked from several places
 *  in a Guide (a question and its answer), and all of them are marked as the pick: the one
 *  that was pressed is the one to keep in view. */
let pressedLink: HTMLElement | null = null
/** The pick as it is drawn in a Guide (`sc`: the Guide's scroller): the outlined box, the open section's row, the marked link. */
function pickIn(sc: HTMLElement): HTMLElement | null {
  const pick = useStore.getState().pick
  if (pick && pressedLink && sc.contains(pressedLink) && pressedLink.matches('.picked') && drawn(pressedLink)) return pressedLink
  const mine = !pick ? [] : 'box' in pick ? ['[data-gr-pick]'] : 'section' in pick ? ['[data-gr-open="true"] > .sec-item-head'] : ['.link-chip.picked']
  return pick ? find([...mine, '[data-gr-pick], .link-chip.picked, .link.picked'], sc) : null
}
/** A pick made while the Guide had the whole width (the whole height, where the panes are
 *  stacked) brings the Code pane back, and the Guide is left with less room: it is scrolled
 *  by the least that keeps the pick in view (nothing, when it still is), once the panes are
 *  laid out anew, unless the reviewer has moved on by then. */
function keepPickInView(guide: Guide): void {
  holding(() => { const sc = scrollerFor(guide); const el = sc && drawn(sc) ? pickIn(sc) : null; if (el) keepInView(el) }, true).settle()
}
/** The sheet is down again: the Guide goes back to where it was, unless the reviewer has scrolled it since. */
export function lowerPick(was: Lift): void {
  const { sc } = was
  if (!liftHolds(was)) return
  // (from where the lift put it, not from where it is: with its whole height back the Guide
  // cannot be scrolled as far as that, and has been brought up to its end already)
  sc.scrollTop = was.put - was.by
  if (Math.abs(sc.scrollTop - was.y) < 2) sc.scrollTop = was.y
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
  /** The session asked for the jump (`gr focus`, a tour): it is a step of the trail, so that
   *  Back returns to what was on show before it and to where the Code pane was scrolled. (A
   *  jump the reviewer makes inside the Code pane, a click in the tree, is not one.) */
  how?: 'step'
  /** the tour the jump is a stop of: a whole tour is one step, which each later stop rewrites */
  tour?: string
}
/** Take one pane to a target and flash it: a jump. Code is shown in the Code pane and the
 *  Guide beside it does not move; the summary and the sections are shown in the
 *  Walkthrough, which becomes the Guide on show (a section is opened there, and is then
 *  that Guide's pick). Whatever would hide the target gives
 *  way first: a Code pane folded away comes back, a narrowing the target is not part of is
 *  left for all the files, filters that hide the file are lifted, a collapsed file is
 *  opened, and a diff held back as large or generated is loaded. The way back from a jump
 *  is the trail: a pick, a change of Guide and a jump the session asked for are steps of it.
 *  A link to a section in another Guide than the Walkthrough (a plan row, a note's "section
 *  …") is a pick in that Guide: the Code pane is narrowed to the section's files, the Guide
 *  stays, and the Walkthrough's own open section is left as it is. */
export function focusAnchor(t: FocusTarget, opts: JumpOpts = {}): void {
  // from a Guide to code: a pick
  if (opts.from && (t.kind === 'file' || t.kind === 'diff')) {
    showPick(t.kind === 'file' ? { file: t.file } : { file: t.file, side: t.side, line: t.line, end: opts.end }, { from: opts.from })
    return
  }
  if (opts.from && opts.from !== 'walkthrough' && t.kind === 'section') { showPick({ section: t.sectionId }, { from: opts.from }); return }
  jump(t, opts)
}
/** Go to a stop of the tour that is on. The whole tour is one step of the trail: Back
 *  returns to what was on show before it started. */
export function tourStop(idx: number): void {
  const tour = useStore.getState().tour
  if (!tour?.stops[idx]) return
  if (idx !== tour.idx) useStore.getState().set({ tour: { ...tour, idx } })
  focusAnchor(tour.stops[idx].target, { how: 'step', tour: tour.id })
}
/** Make something the pick and show its code: the Code pane is narrowed to it, taken to its
 *  lines and flashes them, and the Guide it was picked in (`from`; a box and a section say
 *  theirs) does not move and keeps it outlined. A step of the trail unless `how` says
 *  otherwise (see How). Returns false when it has no code to show (a box that is not code, something that is
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
    if (at.line != null && at.side === 'new') focusLines(where, at.line, at.end ?? at.line, { picked: true })
    else focusAnchor({ kind: 'file', file: where }, { top: true, picked: true })
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
  if (to.line != null && to.side === 'new') focusLines(file, to.line, to.end ?? to.line, { picked: true })
  else if (to.line != null) focusAnchor({ kind: 'diff', file, side: 'old', line: to.line }, { picked: true })
  else focusAnchor({ kind: 'file', file }, { top: true, picked: true })
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
/** Start a tour at one of its stops. */
export function startTour(stops: TourStop[], loop?: boolean, idx = 0): void {
  if (!stops[idx]) return
  useStore.getState().set({ tour: { stops, idx, loop, id: newId('tour') } })
  tourStop(idx)
}
function jump(t: FocusTarget, opts: JumpOpts = {}): void {
  const top = Boolean(opts.top)
  const st = useStore.getState()
  const loaded = st.loaded
  if (!loaded) return
  const to = paneOf(t)
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => jump(t, opts)); return }
  // A jump to code the session asked for, and every stop of a tour, is a step of the trail,
  // made before anything moves: the place the Code pane is left at is noted for the way
  // back, and what the jump then changes (all the files, the Guide) goes into its step.
  const stepped = opts.how === 'step' && (to === 'code' || opts.tour != null)
  if (stepped) { notePlace(); st.jumpStep(t, opts.tour) }
  // (a step of the trail whoever asked, the reviewer or the session: Back returns to where the reviewer was)
  if (t.kind === 'summary') st.showGuide('walkthrough', stepped ? 'replace' : 'step')
  else if (t.kind === 'section') openSection(t.sectionId, stepped ? { how: 'replace' } : {})
  else {
    parked = null                     // the Code pane is about to be somewhere else than it was folded away on
    // (a pick made with the Guide at whole width: the Guide is about to have less room)
    if (opts.picked && st.guideWide && st.guide) keepPickInView(st.guide)
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
      return
    }
    if (tries++ < 45) window.setTimeout(tick, 40)
  }
  window.requestAnimationFrame(tick)
}

/** Show a question asked from a spot where it sits in the Conversation: that Guide comes
 *  on show with the question's message in the middle of it, flashed. */
export function focusQuestion(requestId: string): void {
  const st = useStore.getState()
  const m = st.loaded?.state.messages.find((x) => x.role === 'user' && x.requestId === requestId)
  st.showGuide('conversation')
  if (!m) return
  whenMounted([`[data-gr-message="${cssq(m.id)}"]`], (el) => {
    showInPane(el)
    flash(el.querySelector<HTMLElement>('.tl-box') ?? el)
  }, 'conversation')
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
/** Where the Code pane was, by the step of the trail it was on show at (that step's address;
 *  the last steps only), whatever it was narrowed to: Back or Forward to a step that showed
 *  all the files returns to where they were left, and Back from a jump the session made
 *  returns to the line the reviewer was on. */
const placeAt = new Map<string, Held[]>()
/** Note where the Code pane is, for the step of the trail the page is at (`at`: its address). */
export function notePlace(at: string = window.location.hash): void {
  const st = useStore.getState()
  const spots = readingSpot()
  if (!spots.length) return
  if (st.guide == null || st.showAll || st.view.commit) allPlace = spots     // (not narrowed: what is on show is all the files)
  placeAt.delete(at)
  placeAt.set(at, spots)
  if (placeAt.size > 40) for (const old of placeAt.keys()) { placeAt.delete(old); break }
}
/** Whether the place of the Code pane at a step of the trail is remembered. */
export const hasPlace = (at: string): boolean => placeAt.has(at)
/** Put the Code pane back where it was: at a step of the trail (`at`, its address), or,
 *  without one, where all the files were last read. Returns whether there was a place to
 *  go back to. */
export function backToPlace(at?: string): boolean {
  const mine = at == null ? allPlace : placeAt.get(at)
  if (!mine) return false
  holding(() => putBack(mine), true).settle()
  return true
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

// ── the place, when the window changes size ───────────────────
// A window that is turned, or dragged across one of the widths where the layout changes
// (side by side, stacked, the sheet), wraps every line anew before anything on the page
// hears of it: by then the same scroll offset is other code, and what was on show can no
// longer be read off the panes. So the place is noted while the reviewer reads (after a
// scroll, after anything the page does), and put back when the window's size changes: the
// Code pane on its line, the Guide on its pick when that was in view, else on what was at
// its top. By the line and the element, never by an offset.
/** What the Guide on show is held by: its pick (`pick`), when that is in view, or what is at its top. */
interface GuideHeld { sc: HTMLElement; el: Element; top: number; pick?: boolean }
/** What the Code pane shows, as far as the store decides it: a place noted for other files is not put back. */
const codeShows = (): string => { const st = useStore.getState(); return JSON.stringify([st.guide == null, st.showAll, pickKey(st.pick), st.view.commit ?? '', st.diffMode]) }
let seen: { code: Held[]; shows: string; guide: GuideHeld | null } = { code: [], shows: '', guide: null }
/** What the Guide on show is to be held by, as it is now. */
function guideHeld(): GuideHeld | null {
  const sc = [...document.querySelectorAll<HTMLElement>('[data-gr-guide]')].find(drawn)
  if (!sc) return null
  const same = asPut<GuideHeld>(sc)
  if (same?.el.isConnected) return same
  const el = pickIn(sc)
  if (el && drawn(el)) {
    const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect()
    if (r.bottom > s.top && r.top < s.bottom) return { sc, el, top: topIn(el, sc), pick: true }
  }
  return guideSpot()
}
/** Note where both panes are. A Code pane that is folded away keeps the place it was noted at, while it still holds the same files. */
function noteSeen(): void {
  const shows = codeShows()
  const code = readingSpot()
  seen = { code: code.length || shows !== seen.shows ? code : seen.code, shows, guide: guideHeld() }
}
/** Put a Guide back on what it was held by; its pick is then kept in view, in a pane that is shorter now. */
function putGuide(g: GuideHeld): void {
  if (!drawn(g.sc)) return
  // (a diagram laid out anew for the width draws its boxes again: the pick is found afresh)
  const el = g.el.isConnected ? g.el : g.pick ? pickIn(g.sc) : null
  if (!el || !drawn(el)) return
  const by = topIn(el, g.sc) - g.top
  if (Math.abs(by) >= 1) g.sc.scrollBy({ top: by })
  if (g.pick) keepInView(el)
  putAt(g.sc, g)
}
/** The line the Code pane is held by was the one showing under the file header pinned to
 *  the top, often by the last of the rows it wrapped to. In a wider window it is one row,
 *  and would lie behind that header: it is brought out from under it. (The pane still
 *  counts as put on that line where it was, so the way back ends where it began.) */
function showHeldLine(spots: Held[]): void {
  const sc = codeScroller()
  const spot = spots[0]
  if (!sc || !drawn(sc) || !spot?.sel.startsWith('[data-gr-line')) return
  const el = spot.el.isConnected ? spot.el : find([spot.sel], sc)
  if (!el || !drawn(el)) return
  const top = topIn(el, sc)
  if (top + el.getBoundingClientRect().height >= 52) return
  sc.scrollBy({ top: top - 40 })
  putAt(sc, spots)
}
/** A field that is being typed in stays in view: where a pane is too short now for both
 *  what it is held by and the field (a phone on its side leaves the code 125px; a keyboard
 *  that takes its room from the window), the field wins. (The pane still counts as put
 *  where it was held, as above.) */
function showTypedIn(): void {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || !el.matches('textarea, input')) return
  const sc = scrollerOf(el)
  if (!sc || !drawn(sc)) return
  const held = asPut<unknown>(sc)       // (what the pane was put on just now, if it was)
  keepInView(el)
  if (held) putAt(sc, held)
}
/** Keep the place in both panes while the window changes size (it is turned, dragged
 *  narrower or wider): to be called once, by the workspace; hands back how to stop. */
export function watchPlaces(): () => void {
  let noting = 0
  let sizing: { was: typeof seen; at: string; timers: number[] } | null = null
  const note = (): void => {
    if (sizing) return
    window.clearTimeout(noting)
    noting = window.setTimeout(noteSeen, 180)
  }
  const done = (): void => { if (sizing) { sizing.timers.forEach((t) => window.clearTimeout(t)); sizing = null } }
  const put = (): void => {
    if (!sizing) return
    // (the page has gone to another step meanwhile, a jump the session made: that is where the panes belong)
    if (window.location.hash !== sizing.at) { done(); return }
    const { was } = sizing
    if (was.code.length && was.shows === codeShows()) { putBack(was.code); showHeldLine(was.code) }
    if (was.guide) putGuide(was.guide)
    showTypedIn()
  }
  const resized = (): void => {
    // (the first of a run: what was noted before it is what is held to, whatever the panes pass through on the way)
    if (!sizing) { window.clearTimeout(noting); sizing = { was: seen, at: window.location.hash, timers: [] } }
    sizing.timers.forEach((t) => window.clearTimeout(t))
    put()
    window.requestAnimationFrame(put)
    // (again once the layout for the new size is drawn, and after what is laid out late: a diff gone unified, a diagram drawn anew)
    sizing.timers = [150, 420, 900].map((ms) => window.setTimeout(put, ms))
    sizing.timers.push(window.setTimeout(() => { put(); done(); noteSeen() }, 1300))
  }
  // (the reviewer moves on: nothing is put back under them)
  const moves = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
  // (which of several links to the same code was pressed: see `pickIn`)
  const pressed = (e: Event): void => { const link = e.target instanceof Element ? e.target.closest<HTMLElement>('.link-chip, .link') : null; if (link) pressedLink = link }
  document.addEventListener('click', pressed, true)
  const stop = useStore.subscribe(note)
  document.addEventListener('scroll', note, { capture: true, passive: true })
  window.addEventListener(PANES_SETTLED, note)
  window.addEventListener('resize', resized)
  for (const m of moves) window.addEventListener(m, done, { capture: true, passive: true })
  note()
  return () => {
    stop(); done(); window.clearTimeout(noting)
    document.removeEventListener('click', pressed, true)
    document.removeEventListener('scroll', note, { capture: true })
    window.removeEventListener(PANES_SETTLED, note)
    window.removeEventListener('resize', resized)
    for (const m of moves) window.removeEventListener(m, done, { capture: true })
  }
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
  const room = roomIn(sc)
  sc.scrollBy({ top: bottom - top < room * 0.6 ? (top + bottom - room) / 2 : top - room * 0.3 })
  arriveAt(els[0])                    // the file these lines are in is where the reviewer now is
  // (lines still flashing for the pick before this one stop: only what is picked now is lit)
  for (const el of sc.querySelectorAll('.gr-flash-range')) if (!els.includes(el as HTMLElement)) el.classList.remove('gr-flash-range')
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
