import { writeFile } from 'node:fs/promises'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/oplogs/'
const expectedCnnPath = new URL('guides/cnn/', baseUrl).pathname
const expectedApiPath = new URL('reference/api/', baseUrl).pathname
const expectedRunLogPath = new URL('reference/api/run-log/', baseUrl).pathname
const desktopOutput = process.argv[3] || '/tmp/oplogs-docs-desktop.png'
const mobileOutput = process.argv[4] || '/tmp/oplogs-docs-mobile.png'
const apiDesktopOutput = process.argv[5] || '/tmp/oplogs-docs-api-desktop.png'
const apiMobileOutput = process.argv[6] || '/tmp/oplogs-docs-api-mobile.png'
const symbolDesktopOutput = process.argv[7] || '/tmp/oplogs-docs-symbol-desktop.png'
const symbolMobileOutput = process.argv[8] || '/tmp/oplogs-docs-symbol-mobile.png'
const targets = await fetch('http://127.0.0.1:9224/json').then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('No Chrome page target is available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const consoleErrors = []
let nextId = 1
let resolveLoad

socket.addEventListener('message', (message) => {
  const packet = JSON.parse(message.data)
  if (packet.method === 'Page.loadEventFired') resolveLoad?.()
  if (packet.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(packet.params?.exceptionDetails?.exception?.description ?? packet.params?.exceptionDetails?.text ?? 'Uncaught browser exception')
  }
  if (packet.method === 'Runtime.consoleAPICalled' && packet.params?.type === 'error') {
    consoleErrors.push(packet.params.args?.map((argument) => argument.value ?? argument.description).join(' ') ?? 'Console error')
  }
  if (!packet.id || !pending.has(packet.id)) return
  const { resolve, reject } = pending.get(packet.id)
  pending.delete(packet.id)
  if (packet.error) reject(new Error(packet.error.message))
  else resolve(packet.result)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

function command(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

async function navigate(url) {
  const loaded = new Promise((resolve) => { resolveLoad = resolve })
  await command('Page.navigate', { url })
  let timer
  await Promise.race([
    loaded,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Page load timed out: ${url}`)), 15_000)
    }),
  ])
  clearTimeout(timer)
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`)
  await waitFor(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`, `${selector} visibility`)
  const rect = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height }; })()`)
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`not visible: ${selector}`)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

async function capture(destination) {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(destination, Buffer.from(screenshot.data, 'base64'))
}

async function waitFor(expression, label) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function contrastAudit(selectors = ['body', '.article .lead', '.article p', '.nav-group a[aria-current="page"]', '.code-block code']) {
  return evaluate(`(() => {
    const parse = (value) => {
      const channels = (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
      return value.startsWith('color(srgb') ? channels.map((channel) => channel * 255) : channels
    }
    const luminance = (value) => {
      const channels = parse(value).map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }
    const background = (node) => {
      let candidate = node
      while (candidate) {
        const value = getComputedStyle(candidate).backgroundColor
        if (value && !value.endsWith(', 0)') && value !== 'transparent') return value
        candidate = candidate.parentElement
      }
      return getComputedStyle(document.body).backgroundColor
    }
    return ${JSON.stringify(selectors)}.map((selector) => {
      const node = document.querySelector(selector)
      const foreground = getComputedStyle(node).color
      const surface = background(node)
      const bright = luminance(foreground)
      const dark = luminance(surface)
      return { selector, foreground, background: surface, ratio: (Math.max(bright, dark) + 0.05) / (Math.min(bright, dark) + 0.05) }
    })
  })()`)
}

await Promise.all([command('Page.enable'), command('Runtime.enable'), command('Network.enable')])
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await navigate(baseUrl)
await waitFor(`document.readyState === 'complete' && document.querySelector('h1')?.textContent === 'oplogs'`, 'overview')

const failures = []
const darkContrast = await contrastAudit()
for (const item of darkContrast) if (item.ratio < 4.5) failures.push(`dark contrast ${item.selector}: ${item.ratio.toFixed(2)}`)
const desktop = await evaluate(`({
  title: document.title,
  heading: document.querySelector('h1')?.textContent,
  navLinks: document.querySelectorAll('.sidebar .nav-group a').length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  github: document.querySelector('.header-actions a')?.href,
  removedControls: document.querySelectorAll('[data-journal-lab], [data-copy-link], .reference-count').length,
})`)
if (desktop.title !== 'Overview · oplogs') failures.push(`unexpected title: ${desktop.title}`)
if (desktop.heading !== 'oplogs') failures.push(`unexpected heading: ${desktop.heading}`)
if (desktop.navLinks !== 14) failures.push(`expected 14 navigation links, found ${desktop.navLinks}`)
if (desktop.overflow > 0) failures.push(`desktop overflows by ${desktop.overflow}px`)
if (desktop.github !== 'https://github.com/cneuralnetwork/oplogs') failures.push(`unexpected GitHub link: ${desktop.github}`)
if (desktop.removedControls !== 0) failures.push(`found ${desktop.removedControls} removed controls`)

await click('[data-theme-toggle]')
if ((await evaluate('document.documentElement.dataset.theme')) !== 'light') failures.push('theme control did not select light')
const lightContrast = await contrastAudit()
for (const item of lightContrast) if (item.ratio < 4.5) failures.push(`light contrast ${item.selector}: ${item.ratio.toFixed(2)}`)
await click('[data-theme-toggle]')

await click('[data-search]')
await command('Input.insertText', { text: 'vram' })
await waitFor(`document.querySelectorAll('.search-result').length > 0`, 'search results')
const search = await evaluate(`({
  expanded: document.querySelector('[data-search]')?.getAttribute('aria-expanded'),
  count: document.querySelectorAll('.search-result').length,
  first: document.querySelector('.search-result')?.getAttribute('href'),
})`)
if (search.expanded !== 'true' || search.count < 1 || !search.first) failures.push('search did not expose a result')
if (search.first !== expectedCnnPath) failures.push(`search ranked an unexpected vram result: ${search.first}`)

await navigate(new URL('getting-started/', baseUrl).href)
if ((await evaluate(`document.querySelector('h1')?.textContent`)) !== 'Quickstart') failures.push('quickstart navigation did not render')
if ((await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')) > 0) failures.push('quickstart overflows')

await navigate(new URL('reference/api/', baseUrl).href)
await waitFor(`document.querySelectorAll('.reference-entry').length === 16`, 'api directory')
const apiDirectory = await evaluate(`({
  heading: document.querySelector('h1')?.textContent,
  entries: document.querySelectorAll('.reference-entry').length,
  sidebarLinks: document.querySelectorAll('.sidebar .nav-group a').length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
})`)
if (apiDirectory.heading !== 'API directory') failures.push('api directory heading did not render')
if (apiDirectory.entries !== 16) failures.push(`expected 16 api entries, found ${apiDirectory.entries}`)
if (apiDirectory.sidebarLinks !== 14) failures.push(`expected 14 concise sidebar links, found ${apiDirectory.sidebarLinks}`)
if (apiDirectory.overflow > 0) failures.push(`api directory overflows by ${apiDirectory.overflow}px`)
const apiDarkContrast = await contrastAudit(['.reference-entry > strong', '.reference-entry > small'])
for (const item of apiDarkContrast) if (item.ratio < 4.5) failures.push(`dark api contrast ${item.selector}: ${item.ratio.toFixed(2)}`)
await click('[data-theme-toggle]')
const apiLightContrast = await contrastAudit(['.reference-entry > strong', '.reference-entry > small'])
for (const item of apiLightContrast) if (item.ratio < 4.5) failures.push(`light api contrast ${item.selector}: ${item.ratio.toFixed(2)}`)
await click('[data-theme-toggle]')
await capture(apiDesktopOutput)

await click('[data-search]')
await command('Input.insertText', { text: 'Run.log' })
await waitFor(`document.querySelectorAll('.search-result').length > 0`, 'api search results')
const apiSearch = await evaluate(`({
  count: document.querySelectorAll('.search-result').length,
  first: document.querySelector('.search-result')?.getAttribute('href'),
})`)
if (apiSearch.first !== expectedRunLogPath) failures.push(`search ranked an unexpected Run.log result: ${apiSearch.first}`)
let apiSymbol = null
if (apiSearch.first === expectedRunLogPath) {
  await click(`.search-result[href="${expectedRunLogPath}"]`)
  await waitFor(`location.pathname === ${JSON.stringify(expectedRunLogPath)} && document.querySelector('.symbol-title')?.textContent.trim() === 'Run.log'`, 'Run.log navigation')
  if ((await evaluate(`document.querySelector('.symbol-title')?.textContent`)).trim() !== 'Run.log') failures.push('Run.log reference did not render')
  apiSymbol = await evaluate(`({
    heading: document.querySelector('.symbol-title')?.textContent.trim(),
    signature: document.querySelector('.code-block code')?.textContent,
    parameterRows: document.querySelectorAll('table tbody tr').length,
    copyButtons: document.querySelectorAll('[data-copy-code]').length,
    sourceHref: document.querySelector('.symbol-meta a')?.href,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })`)
  if (!apiSymbol.signature?.includes('values: dict[str, Any]')) failures.push('Run.log signature is incomplete')
  if (apiSymbol.parameterRows < 10) failures.push(`Run.log reference is missing value rows: ${apiSymbol.parameterRows}`)
  if (apiSymbol.copyButtons < 2) failures.push('Run.log code copy controls are missing')
  if (apiSymbol.sourceHref !== 'https://github.com/cneuralnetwork/oplogs/blob/main/src/oplogs/sdk.py') failures.push(`Run.log source does not link to GitHub: ${apiSymbol.sourceHref}`)
  if (apiSymbol.overflow > 0) failures.push(`Run.log reference overflows by ${apiSymbol.overflow}px`)
  await click('.code-block [data-copy-code]')
  await waitFor(`document.querySelector('.code-block [data-copy-code]')?.textContent === 'copied'`, 'code copy confirmation')
  if ((await evaluate(`document.querySelector('.code-block [data-copy-code]')?.textContent`)) !== 'copied') failures.push('code copy control did not confirm')
  await capture(symbolDesktopOutput)
}

await navigate(baseUrl)
await capture(desktopOutput)
await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await navigate(baseUrl)
await click('[data-menu-toggle]')
await waitFor(`document.querySelector('.sidebar')?.getBoundingClientRect().left >= -1`, 'mobile menu transition')
const menu = await evaluate(`({
  open: document.body.classList.contains('sidebar-open'),
  expanded: document.querySelector('[data-menu-toggle]')?.getAttribute('aria-expanded'),
  sidebarLeft: document.querySelector('.sidebar')?.getBoundingClientRect().left,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
})`)
if (!menu.open || menu.expanded !== 'true' || menu.sidebarLeft < -1) failures.push('mobile menu did not open')
if (menu.overflow > 0) failures.push(`mobile overflows by ${menu.overflow}px`)
const backdropPoint = await evaluate(`(() => { const box = document.querySelector('[data-sidebar-backdrop]').getBoundingClientRect(); return { x: box.right - 10, y: box.top + box.height / 2 }; })()`)
await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: backdropPoint.x, y: backdropPoint.y, button: 'left', clickCount: 1 })
await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: backdropPoint.x, y: backdropPoint.y, button: 'left', clickCount: 1 })
await waitFor(`!document.body.classList.contains('sidebar-open')`, 'mobile menu close')
if (await evaluate(`document.body.classList.contains('sidebar-open')`)) failures.push('mobile menu backdrop did not close the menu')
await waitFor(`document.querySelector('.sidebar')?.getBoundingClientRect().right <= 1`, 'mobile menu closing transition')
await capture(mobileOutput)

await navigate(new URL('reference/api/', baseUrl).href)
await waitFor(`document.querySelectorAll('.reference-entry').length === 16`, 'mobile api directory')
if ((await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')) > 0) failures.push('mobile api directory overflows')
await capture(apiMobileOutput)

await navigate(new URL('reference/api/run-log/', baseUrl).href)
await waitFor(`document.querySelector('.symbol-title')?.textContent.trim() === 'Run.log'`, 'mobile Run.log reference')
if ((await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')) > 0) failures.push('mobile Run.log reference overflows')
await capture(symbolMobileOutput)

await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
const indexedPages = await fetch(new URL('search-index.json', baseUrl)).then((response) => response.json())
const routeAudit = { count: indexedPages.length, failures: [] }
for (const item of indexedPages) {
  await navigate(new URL(item.url, baseUrl).href)
  await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('main'))`, `${item.url} document`)
  const state = await evaluate(`({
    heading: document.querySelector('h1')?.textContent.trim(),
    main: Boolean(document.querySelector('main')),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })`)
  if (!state.main || !state.heading || state.overflow > 0) {
    routeAudit.failures.push({ url: item.url, ...state })
  }
}
if (routeAudit.count !== 41) failures.push(`expected 41 rendered routes, found ${routeAudit.count}`)
if (routeAudit.failures.length) failures.push(`rendered route audit failed for ${routeAudit.failures.length} pages`)

console.log(JSON.stringify({ failures, consoleErrors, desktop, darkContrast, lightContrast, search, apiDirectory, apiDarkContrast, apiLightContrast, apiSearch, apiSymbol, menu, routeAudit, desktopOutput, mobileOutput, apiDesktopOutput, apiMobileOutput, symbolDesktopOutput, symbolMobileOutput }, null, 2))
socket.close()
if (failures.length || consoleErrors.length) process.exitCode = 1
