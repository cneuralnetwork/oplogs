import { writeFile } from 'node:fs/promises'

const baseUrl = process.argv[2] || 'http://127.0.0.1:4173/oplogs/'
const expectedCnnPath = new URL('guides/cnn/', baseUrl).pathname
const desktopOutput = process.argv[3] || '/tmp/oplogs-docs-desktop.png'
const mobileOutput = process.argv[4] || '/tmp/oplogs-docs-mobile.png'
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
    consoleErrors.push(packet.params?.exceptionDetails?.text ?? 'Uncaught browser exception')
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

async function contrastAudit() {
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
    return ['body', '.article .lead', '.article p', '.nav-group a[aria-current="page"]', '.code-block code'].map((selector) => {
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
await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('[data-journal-lab]'))`, 'overview')

const failures = []
const darkContrast = await contrastAudit()
for (const item of darkContrast) if (item.ratio < 4.5) failures.push(`dark contrast ${item.selector}: ${item.ratio.toFixed(2)}`)
const desktop = await evaluate(`({
  title: document.title,
  heading: document.querySelector('h1')?.textContent,
  navLinks: document.querySelectorAll('.sidebar .nav-group a').length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  bannerLoaded: document.querySelector('.signature-banner img')?.complete,
  imageWidth: document.querySelector('.signature-banner img')?.naturalWidth,
})`)
if (desktop.title !== 'overview · oplogs') failures.push(`unexpected title: ${desktop.title}`)
if (desktop.heading !== 'oplogs') failures.push(`unexpected heading: ${desktop.heading}`)
if (desktop.navLinks !== 15) failures.push(`expected 15 navigation links, found ${desktop.navLinks}`)
if (desktop.overflow > 0) failures.push(`desktop overflows by ${desktop.overflow}px`)
if (!desktop.bannerLoaded || desktop.imageWidth < 1000) failures.push('banner did not load at full resolution')

await click('[data-journal-kind="media"]')
await waitFor(`document.querySelector('[data-journal-status]')?.textContent.includes('media')`, 'media journal specimen')
if (!(await evaluate(`document.querySelector('[data-journal-status]')?.textContent.includes('media')`))) {
  failures.push('journal specimen did not switch to media')
}

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
if ((await evaluate(`document.querySelector('h1')?.textContent`)) !== 'quickstart') failures.push('quickstart navigation did not render')
if ((await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')) > 0) failures.push('quickstart overflows')

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

console.log(JSON.stringify({ failures, consoleErrors, desktop, darkContrast, lightContrast, search, menu, desktopOutput, mobileOutput }, null, 2))
socket.close()
if (failures.length || consoleErrors.length) process.exitCode = 1
