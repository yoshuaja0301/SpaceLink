import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
// KaTeX ships the glyph metrics as CSS; without it math renders as
// unpositioned spans instead of typeset formulae.
import 'katex/dist/katex.min.css'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('SpaceFore: #root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
