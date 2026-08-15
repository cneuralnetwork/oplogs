import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { oplogsMarkUrl } from './brand'
import { ThemeProvider } from './theme'
import 'uplot/dist/uPlot.min.css'
import './styles.css'

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link')
favicon.rel = 'icon'
favicon.type = 'image/png'
favicon.href = oplogsMarkUrl
if (!favicon.isConnected) document.head.append(favicon)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
