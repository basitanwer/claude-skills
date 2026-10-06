import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { on, onStreamOpen } from './api'
import { isBusy, useStore } from './store'
import { parseHash } from './util'
import { applyStoredTheme, Toasts, TourBar } from './components/common'
import { Dashboard, Hub } from './screens/Home'
import { Review } from './screens/Review'
import './styles.css'

applyStoredTheme()

function App() {
  const route = useStore((s) => s.route)
  // "busy" = something asked of Claude Code for this review is not finished yet
  const busy = useStore(isBusy)

  useEffect(() => {
    onStreamOpen(() => useStore.getState().onStreamOpen())
    const offs = [
      on('session:changed', (m) => useStore.getState().onSessionChanged(m)),
      on('repo:changed', (m) => useStore.getState().onRepoChanged(m)),
      on('ui:action', (m) => useStore.getState().onUiAction(m)),
      on('presence', (m) => useStore.getState().onPresence(m)),
      on('notify', (m) => {
        // only when the reviewer is elsewhere; the open tab already shows the result
        try {
          if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(m.title, { body: m.body })
          }
        } catch { /* notifications unavailable */ }
      })
    ]
    void useStore.getState().boot()
    const onHash = (): void => { void useStore.getState().applyRoute(parseHash(window.location.hash)) }
    window.addEventListener('hashchange', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      for (const off of offs) off()
    }
  }, [])

  return (
    <div className="app" data-gr="app" data-gr-busy={busy ? 'true' : 'false'}>
      {route.name === 'review' ? <Review /> : route.name === 'hub' ? <Hub /> : <Dashboard />}
      <TourBar />
      <Toasts />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
