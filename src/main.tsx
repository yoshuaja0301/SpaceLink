import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
// KaTeX ships the glyph metrics as CSS; without it math renders as
// unpositioned spans instead of typeset formulae.
import 'katex/dist/katex.min.css'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('SpaceFore: #root element is missing from index.html')

// Registered only in a built app: it makes SpaceFore installable, and lets it
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
