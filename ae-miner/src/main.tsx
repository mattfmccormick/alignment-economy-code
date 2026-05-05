import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// HashRouter (not BrowserRouter) is critical for the packaged Electron build:
// it loads from file:///.../app.asar/dist/index.html, and BrowserRouter
// reads the file path as the route, which doesn't match any configured route
// and renders the page blank. Hash routing (#/path) is protocol-agnostic.
import { HashRouter } from 'react-router-dom'
import { initTheme } from './lib/theme'
import './index.css'
import App from './App'

initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
)
