import { render } from 'preact'
import './styles/tokens.css'
import './styles/app.css'
import { App } from './app.tsx'
import { applyTheme, theme } from './lib/theme.ts'

applyTheme(theme.value)
render(<App />, document.getElementById('app') as HTMLElement)
