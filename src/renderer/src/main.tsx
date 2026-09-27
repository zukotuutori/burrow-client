import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'
import { Tooltips } from './components/Tooltip'

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <Tooltips />
  </>
)
