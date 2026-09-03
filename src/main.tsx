import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { adoptRenamedStorage } from './core/renamedStorage'
// KaTeX ships the glyph metrics as CSS; without it math renders as
// unpositioned spans instead of typeset formulae.
import './styles/app.css'

// Before anything reads a setting: this app used to file everything under
// `spacefore.` and now files it under `spacelink.`. See core/renamedStorage.
adoptRenamedStorage()

const container = document.getElementById('root')
if (!container) throw new Error('SpaceLink: #root element is missing from index.html')

// Registered only in a built app: it makes SpaceLink installable, and lets it
// open instantly on a slow connection. It never caches the vault — see
// public/sw.js. A failure here is not worth interrupting anyone over.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
