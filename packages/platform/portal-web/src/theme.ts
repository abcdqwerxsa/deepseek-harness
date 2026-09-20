/** Theme preference: explicit choice in localStorage wins, else the system
 *  scheme. Only an explicit toggle persists (chooseTheme) — a system-derived
 *  theme is stamped for the session but never written, so OS scheme changes
 *  keep being honored until the user actually picks a side. */

export type Theme = 'light' | 'dark'

const KEY = 'dsh_theme'

function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null /* storage unavailable (private window etc.) falls through to system */
  }
}

export function currentTheme(): Theme {
  return storedTheme()
    ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}

/** Stamp `data-theme` on the root element; CSS keys off it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Record an explicit user choice: stamp it and persist across visits. */
export function chooseTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* non-fatal: the toggle still works for this session */
  }
}
