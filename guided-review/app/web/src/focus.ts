import type { ChangedRange, FocusTarget, TourStop } from '@shared/types'
import { useStore } from './store'
import { baseName, cssq, type Tab } from './util'

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
        `${file} [data-${t.side}="${t.line}"]`,
        file
      ]
    }
  }
}

/** The first of these selectors that matches something. */
function find(sels: string[]): HTMLElement | null {
  for (const s of sels) {
    try { const el = document.querySelector<HTMLElement>(s); if (el) return el } catch { /* not a valid selector for this id */ }
  }
  return null
}

const TAB_NAMES: Record<Tab, string> = { conversation: 'Conversation', commits: 'Commits', spec: 'Spec & plan', files: 'Files changed' }
type Spot = NonNullable<ReturnType<typeof useStore.getState>['returnTo']>
/** The reviewer's current position: the tab, the scroll position and, among the files,
 *  the file under the top of the window with how far down the window it starts. */
function whereAmI(tab: Tab): Spot {
  const here = { tab, y: window.scrollY, top: null as number | null, label: TAB_NAMES[tab] }
  if (tab !== 'files') return here
  for (const el of document.querySelectorAll<HTMLElement>('[data-gr-file]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > 160) return { ...here, top: r.top, label: baseName(el.dataset.grFile ?? ''), target: { kind: 'file', file: el.dataset.grFile ?? '' } }
  }
  return here
}
/** Whether a jump that stayed on the tab took the reviewer away from what they were
 *  reading: the file they were in (or, elsewhere, the page) is now about a window or more
 *  from where it was. A shorter hop leaves the old spot on screen or one scroll away. */
function movedFrom(spot: Spot): boolean {
  const el = spot.target && spot.top != null ? find(selectorsFor(spot.target).slice(-1)) : null
  const by = el && spot.top != null ? el.getBoundingClientRect().top - spot.top : window.scrollY - spot.y
  return Math.abs(by) > window.innerHeight * 0.9
}

/** Run `then` on the first element matching one of the selectors, once it is mounted. */
function whenMounted(sels: string[], then: (el: HTMLElement) => void, tries = 25): void {
  const el = find(sels)
  if (el) then(el)
  else if (tries > 0) window.setTimeout(() => whenMounted(sels, then, tries - 1), 40)
}

function flash(el: HTMLElement): void {
  el.classList.remove('gr-flash')
  void el.offsetWidth               // restart the animation on a repeat focus
  el.classList.add('gr-flash')
  window.setTimeout(() => el.classList.remove('gr-flash'), 1000)
}

/** Scroll the review to a target and flash it. Whatever would hide the target gives
 *  way first: the tab is switched (code lives in "Files changed", the summary and
 *  the sections in "Conversation"), filters that hide the file are lifted, a
 *  collapsed file is opened, and a diff held back as large or generated is loaded.
 *  A jump the reviewer did not aim themselves (a link in the text, a comment in a menu,
 *  the session showing something) leaves a "Back to …" pill when it takes them away from
 *  their place. `nav`: they picked the destination from a list of files — no pill.
 *  `top`: the target is put under the toolbar, to be read from its first line, instead of
 *  in the middle of the window (where a file taller than the window shows its middle). */
export function focusAnchor(t: FocusTarget, opts: { nav?: boolean; top?: boolean } = {}): void {
  const st = useStore.getState()
  // during a tour the way back leads to where the tour started, from whichever stop
  jump(t, opts.nav ? null : st.tour?.origin ?? whereAmI(st.tab), false, opts.top)
}
/** Start a tour at one of its stops, remembering where the reviewer was. */
export function startTour(stops: TourStop[], loop?: boolean, idx = 0): void {
  const st = useStore.getState()
  if (!stops[idx]) return
  st.set({ tour: { stops, idx, loop, origin: st.tour?.origin ?? whereAmI(st.tab) } })
  focusAnchor(stops[idx].target)
}
/** `origin`: where to offer the way back to, if the jump moves the reviewer. `keep`: leave
 *  an already remembered spot alone. `top`: see focusAnchor. */
function jump(t: FocusTarget, origin: Spot | null, keep: boolean, top = false): void {
  const st = useStore.getState()
  const loaded = st.loaded
  if (!loaded) return
  // A section asked for while reading code opens beside the code instead of taking the
  // reviewer to another tab (grouped by section, its header is already on this tab).
  const beside = t.kind === 'section' && st.tab === 'files'
  if (beside && !(st.filters.bySection && loaded.state.walkthrough)) {
    showSection(t.sectionId)
    whenMounted([`[data-gr-section-panel="${cssq(t.sectionId)}"]`], flash)
    return
  }
  // a jump to another tab than the one the reviewer was on remembers that place at once;
  // one within it is remembered when it lands, if it went far. Any other jump makes the
  // remembered spot stale.
  const to = beside ? st.tab : t.kind === 'summary' || t.kind === 'section' ? 'conversation' : 'files'
  const leaves = Boolean(origin) && origin?.tab !== to
  if (!keep) st.set({ returnTo: leaves ? origin : null })
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => jump(t, origin, keep || leaves, top)); return }
  if (beside) {
    // nothing to switch or open
  } else if (t.kind === 'summary' || t.kind === 'section') {
    st.setTab('conversation')
    if (t.kind === 'section') st.setSectionOpen(t.sectionId, true)
  } else {
    st.setTab('files')
    const file = loaded.files.find((f) => f.path === t.file || f.oldPath === t.file)
    if (st.diffMode !== 'all') st.set({ diffMode: 'all' })
    if (st.fileQuery) st.set({ fileQuery: '' })
    const lift: Partial<typeof st.filters> = {}
    if (st.filters.hideViewed && file?.viewed === 'viewed') lift.hideViewed = false
    if (st.filters.onlyCommented) lift.onlyCommented = false
    if (file?.excluded && !st.filters.showExcluded) lift.showExcluded = true
    if (Object.keys(lift).length) st.setFilters(lift)
    st.setFileOpen(file?.path ?? t.file, true)
    if (t.kind === 'diff') {
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
    const usable = tries < (t.kind === 'diff' ? 30 : 8) ? sels.slice(0, 1) : sels
    const el = find(usable)
    if (el) {
      const land = (): void => {
        if (top) window.scrollBy({ top: el.getBoundingClientRect().top - pinnedHeight() - 8 })
        else el.scrollIntoView({ block: 'center', behavior: 'auto' })
        arriveAt(el)
      }
      land()
      // once more after late layout (a section opening beside the code changes every height above), unless the reviewer has scrolled since
      if (top) { const y = window.scrollY; window.setTimeout(() => { if (el.isConnected && window.scrollY === y) land() }, 150) }
      flash(el)
      if (origin && !leaves && !keep && movedFrom(origin)) useStore.getState().set({ returnTo: origin })
      return
    }
    if (tries++ < 45) window.setTimeout(tick, 40)
  }
  window.requestAnimationFrame(tick)
}

/** Show a question asked from a spot where it sits in the Conversation tab: its message,
 *  centred and flashed, with the way back to the spot. */
export function focusQuestion(requestId: string): void {
  const st = useStore.getState()
  const m = st.loaded?.state.messages.find((x) => x.role === 'user' && x.requestId === requestId)
  const origin = whereAmI(st.tab)
  const leaves = st.tab !== 'conversation'
  st.set({ returnTo: leaves ? origin : null })
  st.setTab('conversation')
  if (!m) return
  whenMounted([`[data-gr-message="${cssq(m.id)}"]`], (el) => {
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    flash(el.querySelector<HTMLElement>('.tl-box') ?? el)
    if (!leaves && movedFrom(origin)) useStore.getState().set({ returnTo: origin })
  })
}

/** Return to where the reviewer was before a jump: the same tab, the same file at the
 *  same height in the window, its header flashed so the eye finds it. */
export function goBack(): void {
  const st = useStore.getState()
  const back = st.returnTo
  if (!back) return
  st.set({ returnTo: null })
  st.setTab(back.tab)
  const sels = back.target ? selectorsFor(back.target).slice(-1) : []
  let tries = 0
  const place = (): HTMLElement | null => {
    const el = find(sels)
    // put the thing the link sat in back at the same height in the window
    if (el && back.top != null) window.scrollBy({ top: el.getBoundingClientRect().top - back.top })
    else window.scrollTo({ top: back.y })
    return el
  }
  const tick = (): void => {
    // the tab has to lay out again before the old position exists
    const ready = document.documentElement.scrollHeight - window.innerHeight >= back.y - window.innerHeight
    if (!(ready && (find(sels) || !sels.length)) && tries++ < 45) { window.setTimeout(tick, 40); return }
    const el = place()
    window.setTimeout(place, 150)     // once more, after late layout (wrapped lines, highlighting)
    const head = el?.querySelector<HTMLElement>('.file-head') ?? el
    if (head) flash(head)
  }
  window.requestAnimationFrame(tick)
}

/** What the reviewer is reading in Files changed, as something that can be found again
 *  after the page lays out anew: the first diff line under everything pinned to the top
 *  of the window (by its address, since switching between split and unified replaces
 *  the rows), or failing that the file box there. `top`: where it is in the window. */
function readingSpot(): { sel: string; top: number }[] {
  const list = document.querySelector('.files-list')?.getBoundingClientRect()
  if (!list) return []
  const strip = document.querySelector('.req-strip')?.getBoundingClientRect().height ?? 0
  let box: { sel: string; top: number } | null = null
  for (let y = strip + 96; y < window.innerHeight; y += 20) {
    const at = document.elementFromPoint(list.left + 80, y)
    const file = at?.closest<HTMLElement>('[data-gr-file]')
    if (file) box ??= { sel: `[data-gr-file="${cssq(file.dataset.grFile ?? '')}"]`, top: file.getBoundingClientRect().top }
    const line = at?.closest('.dr-wrap')?.querySelector<HTMLElement>('[data-gr-line]')
    if (line && box) return [{ sel: `[data-gr-line="${cssq(line.dataset.grLine ?? '')}"]`, top: line.getBoundingClientRect().top }, box]
  }
  return box ? [box] : []
}

/** Open a walkthrough section beside the code (null closes it). Where the panel is a
 *  column of its own, opening or closing it changes the width of the diff (and may hide
 *  the file tree, or turn a split diff into a unified one) and so the height of
 *  everything above: the line under the top of the window is put back where it was, so
 *  the reviewer does not lose their place. */
export function showSection(id: string | null): void {
  const st = useStore.getState()
  if (st.sectionPanel === id) return
  const spots = readingSpot()
  st.set({ sectionPanel: id })
  if (!spots.length) return
  const place = (): void => {
    // the line if it is still on the page, else the file it was in
    for (const spot of spots) {
      const el = find([spot.sel])
      if (el) { window.scrollBy({ top: el.getBoundingClientRect().top - spot.top }); return }
    }
  }
  window.requestAnimationFrame(place)
  window.setTimeout(place, 150)       // once more, after late layout
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
export async function focusChanged(r: ChangedRange): Promise<void> {
  const lines = r.end > r.start ? `lines ${r.start}–${r.end}` : `line ${r.start}`
  const was = useStore.getState()
  if (was.view.commit) await was.setView({ commit: undefined })
  else if (was.drift) await was.reload()
  const st = useStore.getState()
  const say = (text: string): void => st.toast(text, 'info', undefined, { key: CHANGED_KEY })
  const file = st.loaded?.files.find((f) => f.path === r.file || f.oldPath === r.file)
  if (!file) { say(`${r.file} is no longer part of this comparison, so ${lines} cannot be shown.`); return }
  focusAnchor({ kind: 'diff', file: file.path, side: 'new', line: r.start })
  const first = `[data-gr-line="${cssq(`${file.path}:new:${r.start}`)}"]`
  let tries = 0
  const tick = (): void => {
    if (find([first])) {
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
/** Flash every line of a range that is on the page, and bring the range into the window:
 *  centred when it fits, else with its first line near the top. */
function flashRange(file: string, r: ChangedRange): void {
  const els = [...document.querySelectorAll<HTMLElement>(`[data-gr-file="${cssq(file)}"] [data-new]`)].filter((el) => { const n = Number(el.dataset.new); return n >= r.start && n <= r.end })
  if (!els.length) return
  const top = els[0].getBoundingClientRect().top; const bottom = els[els.length - 1].getBoundingClientRect().bottom
  const room = window.innerHeight
  window.scrollBy({ top: bottom - top < room * 0.6 ? (top + bottom - room) / 2 : top - room * 0.3 })
  for (const el of els) {
    el.classList.remove('gr-flash', 'gr-flash-range')
    void el.offsetWidth               // restart the animation on a repeat click
    el.classList.add('gr-flash-range')
    window.setTimeout(() => el.classList.remove('gr-flash-range'), 1800)
  }
}

/** Take the reviewer to a walkthrough section: it opens beside the code, and the code
 *  moves to the first of its files not yet marked Viewed (the first one, when all are).
 *  This is their own step through the walkthrough, so it leaves no "Back to …" pill, and
 *  unlike showSection it does not hold the page where it was: the page is meant to move. */
export function goToSection(id: string): void {
  const st = useStore.getState()
  const section = st.loaded?.state.walkthrough?.sections.find((s) => s.id === id)
  if (!section) return
  st.set({ sectionPanel: id })
  const files = section.files.map((p) => st.loaded?.files.find((f) => f.path === p))
  const file = (files.find((f) => f && f.viewed !== 'viewed') ?? files[0])?.path ?? section.files[0]
  if (file) focusAnchor({ kind: 'file', file }, { nav: true, top: true })
}

/** How much of the top of the window stays covered in Files changed: the requests strip
 *  and the toolbar, which stick there. */
function pinnedHeight(): number {
  const h = (sel: string): number => document.querySelector<HTMLElement>(sel)?.offsetHeight ?? 0
  return h('.req-strip') + h('.files-toolbar')
}
/** The file the reviewer was just taken to, and where its box then was in the window.
 *  A file is not always under the top of the window after a jump to it (one near the end
 *  of the page cannot be brought up that far; a line is shown in the middle): until the
 *  reviewer scrolls, it is still the file they are at. */
let arrived: { box: HTMLElement; top: number } | null = null
function arriveAt(el: HTMLElement): void {
  const box = el.closest<HTMLElement>('[data-gr-file]')
  if (!box) return
  arrived = { box, top: box.getBoundingClientRect().top }
  useStore.setState({ currentFile: box.dataset.grFile ?? null })
}
/** The file under the top of the window in Files changed: the first of `boxes` (the file
 *  boxes, in page order) to reach below what is pinned there — the requests strip, the
 *  toolbar, the top of a sticky file header. Between two files, or on a section's header,
 *  that is the next file down; past the last one it stays the last. A binary search: a
 *  handful of rectangles are read however many files there are and however long their
 *  diffs (asking the document what lies at a point costs tens of milliseconds on a long
 *  review, and finding the boxes anew walks every line of every diff). */
function fileAtTop(boxes: HTMLElement[]): HTMLElement | null {
  if (arrived) {
    if (arrived.box.isConnected && Math.abs(arrived.box.getBoundingClientRect().top - arrived.top) < 4) return arrived.box
    arrived = null
  }
  if (!boxes.length) return null
  const line = Math.max(document.querySelector('.files-toolbar')?.getBoundingClientRect().bottom ?? 0, 0) + 24
  let lo = 0
  let hi = boxes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (boxes[mid].getBoundingClientRect().bottom > line) hi = mid
    else lo = mid + 1
  }
  return boxes[lo]
}
/** Keep the store's `currentFile` true while Files changed is on screen (`list`: the
 *  column of file boxes, which the caller follows anew when it draws other boxes or
 *  draws them in another order). Scrolling asks for one reading on the next frame,
 *  however many scroll events arrive before it; so does the list changing height under
 *  a still window (a file folds, a diff loads). Returns the way to stop. */
export function followFiles(list: HTMLElement): () => void {
  const collect = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[data-gr-file]')]
  let boxes = collect()
  let frame = 0
  const read = (): void => {
    frame = 0
    let box = fileAtTop(boxes)
    // drawn again since they were collected (boxes that are gone have no place, so the search ends on one)
    if (box && !box.isConnected) { boxes = collect(); box = fileAtTop(boxes) }
    const file = box?.dataset.grFile
    if (file != null && file !== useStore.getState().currentFile) useStore.setState({ currentFile: file })
  }
  const soon = (): void => { frame ||= window.requestAnimationFrame(read) }
  const ro = new ResizeObserver(soon)
  ro.observe(list)
  window.addEventListener('scroll', soon, { passive: true })
  window.addEventListener('resize', soon)
  soon()
  return () => {
    ro.disconnect()
    window.removeEventListener('scroll', soon)
    window.removeEventListener('resize', soon)
    if (frame) window.cancelAnimationFrame(frame)
  }
}
