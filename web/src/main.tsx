import { render } from 'preact'
import './styles/shared.css'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './app.tsx'
import { startRail } from './lib/rail.ts'
import { startTheme } from './lib/theme.ts'

startTheme()
startRail()
// The first screen is drawn in a task of its own, after the code is read: reading it and drawing the screen
// never add up to one long task that blocks the page (spec B6 CA6).
setTimeout(() => render(<App />, document.getElementById('app') as HTMLElement), 0)
