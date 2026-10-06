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
/** The reviewer's current position: the tab, the scroll position and, among the files,
 *  the file under the top of the window with how far down the window it starts. */
function whereAmI(tab: Tab): NonNullable<ReturnType<typeof useStore.getState>['returnTo']> {
  const here = { tab, y: window.scrollY, top: null as number | null, label: TAB_NAMES[tab] }
  if (tab !== 'files') return here
  for (const el of document.querySelectorAll<HTMLElement>('[data-gr-file]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom > 160) return { ...here, top: r.top, label: baseName(el.dataset.grFile ?? ''), target: { kind: 'file', file: el.dataset.grFile ?? '' } }
  }
  return here
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
 *  the sections in "Conversation"), filters that hide the file are lifted, and a
 *  collapsed file is opened. */
export function focusAnchor(t: FocusTarget): void {
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
  // a jump that leaves the current tab remembers where the reviewer was, so they can
  // return to that exact spot; any other jump makes the remembered spot stale
  const leaves = !beside && (t.kind === 'summary' || t.kind === 'section' ? 'conversation' : 'files') !== st.tab
  st.set({ returnTo: leaves && !st.tour ? whereAmI(st.tab) : null })
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => focusAnchor(t)); return }
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
    // a line outside the diff's hunks is fetched and shown in place by its file box
    if (t.kind === 'diff') st.revealLine(file?.path ?? t.file, t.side, t.line)
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
      return
    }
    if (tries++ < 45) window.setTimeout(tick, 40)
  }
  window.requestAnimationFrame(tick)
}

/** Return to where the reviewer was before a jump to another tab: the same tab, the same
 *  file at the same height in the window, its header flashed so the eye finds it. */
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

/** Open a walkthrough section beside the code (null closes it). Where the panel is a
 *  column of its own, opening or closing it changes the width of the diff and so the
 *  height of everything above: the line under the top of the window is put back where
 *  it was, so the reviewer does not lose their place. */
export function showSection(id: string | null): void {
  const st = useStore.getState()
  if (st.sectionPanel === id) return
  const list = document.querySelector('.files-list')?.getBoundingClientRect()
  const at = list ? document.elementFromPoint(list.left + 80, 180)?.closest<HTMLElement>('.code, .ln, .file-head, [data-gr-file]') : null
  const top = at?.getBoundingClientRect().top
  st.set({ sectionPanel: id })
  if (at && top != null) window.requestAnimationFrame(() => { if (at.isConnected) window.scrollBy({ top: at.getBoundingClientRect().top - top }) })
}
