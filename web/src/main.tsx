import { render } from 'preact'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './app.tsx'
import { startTheme } from './lib/theme.ts'

startTheme()
render(<App />, document.getElementById('app') as HTMLElement)
