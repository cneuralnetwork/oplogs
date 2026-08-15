import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'uplot/dist/uPlot.min.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

