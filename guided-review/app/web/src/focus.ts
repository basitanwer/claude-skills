import type { FocusTarget } from '@shared/types'
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
 *  their place. `nav`: they picked the destination from a list of files — no pill. */
export function focusAnchor(t: FocusTarget, opts: { nav?: boolean } = {}): void {
  const st = useStore.getState()
  // stepping through a tour keeps the spot remembered when the tour started
  jump(t, opts.nav || st.tour ? null : whereAmI(st.tab), Boolean(st.tour))
}
/** `origin`: where to offer the way back to, if the jump moves the reviewer. `keep`: leave
 *  an already remembered spot alone. */
function jump(t: FocusTarget, origin: Spot | null, keep: boolean): void {
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
  // a jump that leaves the current tab remembers where the reviewer was at once; one that
  // stays is remembered when it lands, if it went far. Any other jump makes the remembered
  // spot stale.
  const leaves = !beside && (t.kind === 'summary' || t.kind === 'section' ? 'conversation' : 'files') !== st.tab
  if (!keep) st.set({ returnTo: leaves ? origin : null })
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => jump(t, origin, keep || leaves)); return }
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
      el.scrollIntoView({ block: 'center', behavior: 'auto' })
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
