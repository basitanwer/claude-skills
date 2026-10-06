import type { FocusTarget } from '@shared/types'
import { useStore } from './store'
import { cssq } from './util'

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

function flash(el: HTMLElement): void {
  el.classList.remove('gr-flash')
  void el.offsetWidth               // restart the animation on a repeat focus
  el.classList.add('gr-flash')
  window.setTimeout(() => el.classList.remove('gr-flash'), 2200)
}

/** Scroll the review to a target and flash it. Whatever would hide the target gives
 *  way first: the tab is switched (code lives in "Files changed", the summary and
 *  the sections in "Conversation"), filters that hide the file are lifted, and a
 *  collapsed file is opened. */
export function focusAnchor(t: FocusTarget): void {
  const st = useStore.getState()
  const loaded = st.loaded
  if (!loaded) return
  // a commit view shows another diff: targets belong to the whole comparison
  if (st.view.commit && (t.kind === 'file' || t.kind === 'diff')) { void st.setView({ commit: undefined }).then(() => focusAnchor(t)); return }
  if (t.kind === 'summary' || t.kind === 'section') {
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
    let el: HTMLElement | null = null
    for (const s of usable) {
      try { el = document.querySelector<HTMLElement>(s) } catch { el = null }
      if (el) break
    }
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'auto' })
      flash(el)
      return
    }
    if (tries++ < 45) window.setTimeout(tick, 40)
  }
  window.requestAnimationFrame(tick)
}
