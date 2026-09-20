import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyTheme, currentTheme } from './theme'
import './style.css'

// Stamp the theme before first paint so dark-preference users get no white flash.
applyTheme(currentTheme())

createRoot(document.getElementById('root') ?? document.body).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
