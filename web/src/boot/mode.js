// Runs in <head>, before the styles are applied and before the first frame: the mode the person chose (or the
// system's) is on <html> from the start, so the web never shows a frame in the wrong mode. A plain script of its
// own file (the CSP allows no inline script); lib/mode.ts keeps the mode current afterwards.
;(() => {
  let choice = 'system'
  try {
    const v = localStorage.getItem('rscb.theme')
    if (v === 'light' || v === 'dark' || v === 'contrast') choice = v
  } catch {
    // A blocked storage: the system's mode.
  }
  const mm = (q) => window.matchMedia?.(q)
  const mode =
    choice !== 'system'
      ? choice
      : mm('(prefers-contrast: more)')?.matches
        ? 'contrast'
        : mm('(prefers-color-scheme: dark)')?.matches
          ? 'dark'
          : 'light'
  document.documentElement.setAttribute('data-theme', mode)
  document.documentElement.setAttribute('data-mode-choice', choice)
})()
