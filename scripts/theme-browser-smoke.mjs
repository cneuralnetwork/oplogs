import { writeFile } from 'node:fs/promises'

const baseUrl = process.argv[2] || 'http://127.0.0.1:7437/'
const runId = process.argv[3]
const desktopOutput = process.argv[4] || '/tmp/oplogs-dark-desktop.png'
const mobileOutput = process.argv[5] || '/tmp/oplogs-dark-mobile.png'
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
  await waitFor(`document.readyState === 'complete' && Boolean(document.querySelector('.theme-toggle'))`, 'dashboard shell')
  await waitFor(`!document.querySelector('.page-loading')`, 'dashboard data')
}

async function waitFor(expression, label) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function selectRoute(path) {
  await evaluate(`(() => {
    history.pushState({}, '', ${JSON.stringify(path)})
    dispatchEvent(new PopStateEvent('popstate'))
  })()`)
  await waitFor(`location.pathname === ${JSON.stringify(path)} && Boolean(document.querySelector('.theme-toggle'))`, `${path} route`)
  await new Promise((resolve) => setTimeout(resolve, 400))
}

async function click(selector) {
  const rect = await evaluate(`(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)})
    if (nodes.length !== 1) return { count: nodes.length }
    const box = nodes[0].getBoundingClientRect()
    return { count: 1, x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height }
  })()`)
  if (rect.count !== 1 || rect.width <= 0 || rect.height <= 0) throw new Error(`${selector} is not uniquely visible`)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
}

async function capture(path) {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path, Buffer.from(screenshot.data, 'base64'))
}

async function auditPage(path) {
  await selectRoute(path)
  return evaluate(`(() => {
    const root = document.documentElement
    const body = document.body
    const shell = document.querySelector('.app-shell')
    const main = document.querySelector('.main-content')
    const shellBox = shell?.getBoundingClientRect()
    const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
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
        if (value && value !== 'transparent' && !value.endsWith(', 0)')) return value
        candidate = candidate.parentElement
      }
      return getComputedStyle(document.body).backgroundColor
    }
    const ratios = ['body', '.page-header p', '.data-table td', '.data-table th']
      .map((selector) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const foreground = getComputedStyle(node).color
        const surface = background(node)
        const a = luminance(foreground)
        const b = luminance(surface)
        return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
      })
      .filter(Boolean)
    return {
      path: location.pathname,
      theme: document.documentElement.dataset.theme,
      toggle: document.querySelector('.theme-toggle')?.getAttribute('aria-label'),
      fontFamily: getComputedStyle(body).fontFamily,
      fontLoaded: document.fonts.check('15px "Geist UI"'),
      heading: document.querySelector('.page-header h1, .run-header h1')?.textContent?.trim(),
      navLabels: [...document.querySelectorAll('.sidebar .nav-item')].map((node) => node.getAttribute('aria-label')),
      overflow: root.scrollWidth - root.clientWidth,
      outerScrollRange: Math.max(root.scrollHeight - root.clientHeight, body.scrollHeight - body.clientHeight, 0),
      shell: shellBox ? { top: shellBox.top, bottom: shellBox.bottom, viewport: innerHeight } : null,
      mainScrollRange: main ? Math.max(main.scrollHeight - main.clientHeight, 0) : null,
      mainScrollbar: main ? {
        standard: getComputedStyle(main).scrollbarWidth,
        webkit: getComputedStyle(main, '::-webkit-scrollbar').display,
      } : null,
      ratios,
    }
  })()`)
}

async function verifyInternalScroll(path) {
  await selectRoute(path)
  const before = await evaluate(`(() => {
    const main = document.querySelector('.main-content')
    return { range: main.scrollHeight - main.clientHeight, top: main.scrollTop }
  })()`)
  if (before.range <= 0) return { ...before, moved: false }
  await evaluate(`document.querySelector('.main-content').scrollTop = 200`)
  const after = await evaluate(`document.querySelector('.main-content').scrollTop`)
  await evaluate(`document.querySelector('.main-content').scrollTop = 0`)
  return { ...before, after, moved: after > 0 }
}

await Promise.all([command('Page.enable'), command('Runtime.enable'), command('Network.enable')])
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await navigate(new URL('/projects', baseUrl).href)
await evaluate(`localStorage.setItem('oplogs-theme', 'light')`)
await navigate(new URL('/projects', baseUrl).href)

const failures = []
const initial = await auditPage('/projects')
if (initial.theme !== 'light' || initial.toggle !== 'Use dark mode') failures.push('light theme did not initialize')
if (!initial.fontLoaded || !initial.fontFamily.includes('Geist UI')) failures.push(`Geist UI did not load: ${initial.fontFamily}`)
if (initial.heading !== 'Projects') failures.push(`professional page casing is missing: ${initial.heading}`)
if (initial.navLabels.some((label) => label && label !== 'oplogs home' && label[0] !== label[0].toUpperCase())) failures.push('navigation labels are not professionally cased')

await click('.theme-toggle')
await waitFor(`document.documentElement.dataset.theme === 'dark'`, 'dark theme')
const switched = await evaluate(`({
  theme: document.documentElement.dataset.theme,
  stored: localStorage.getItem('oplogs-theme'),
  toggle: document.querySelector('.theme-toggle')?.getAttribute('aria-label'),
  pressed: document.querySelector('.theme-toggle')?.getAttribute('aria-pressed'),
  themeColor: document.querySelector('meta[name="theme-color"]')?.content,
})`)
if (switched.stored !== 'dark' || switched.toggle !== 'Use light mode' || switched.pressed !== 'true' || switched.themeColor !== '#0a0d0b') {
  failures.push('dark theme state was not reflected or persisted')
}

await navigate(new URL('/projects', baseUrl).href)
if ((await evaluate(`document.documentElement.dataset.theme`)) !== 'dark') failures.push('dark theme did not survive navigation')

const routePaths = ['/', '/projects', '/artifacts', '/sweeps', '/registry', '/reports', '/traces', '/settings']
if (runId) routePaths.push(`/runs/${runId}`)
const routes = []
for (const path of routePaths) {
  const audit = await auditPage(path)
  routes.push(audit)
  if (audit.theme !== 'dark') failures.push(`${path}: dark theme was lost`)
  if (audit.toggle !== 'Use light mode') failures.push(`${path}: theme control label is wrong`)
  if (!audit.fontLoaded || !audit.fontFamily.includes('Geist UI')) failures.push(`${path}: Geist UI is not active`)
  if (audit.overflow > 0) failures.push(`${path}: overflows by ${audit.overflow}px`)
  if (audit.outerScrollRange > 0) failures.push(`${path}: document scrolls vertically by ${audit.outerScrollRange}px`)
  if (!audit.shell || audit.shell.top < -0.5 || audit.shell.bottom > audit.shell.viewport + 0.5) failures.push(`${path}: shell does not fit the viewport`)
  if (audit.mainScrollbar?.standard !== 'none' || audit.mainScrollbar?.webkit !== 'none') failures.push(`${path}: content scrollbar is visible`)
  for (const item of audit.ratios) if (item.ratio < 4.5) failures.push(`${path}: low contrast ${item.selector} ${item.ratio.toFixed(2)}`)
}

const desktopScroll = runId ? await verifyInternalScroll(`/runs/${runId}`) : null
if (desktopScroll && desktopScroll.range > 0 && !desktopScroll.moved) failures.push('desktop: long content cannot scroll internally')

await selectRoute('/projects')
await capture(desktopOutput)

await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
const mobile = await auditPage('/projects')
if (mobile.overflow > 0) failures.push(`mobile: overflows by ${mobile.overflow}px`)
if (mobile.outerScrollRange > 0) failures.push(`mobile: document scrolls vertically by ${mobile.outerScrollRange}px`)
if (!mobile.shell || mobile.shell.top < -0.5 || mobile.shell.bottom > mobile.shell.viewport + 0.5) failures.push('mobile: shell does not fit the viewport')
if (mobile.mainScrollbar?.standard !== 'none' || mobile.mainScrollbar?.webkit !== 'none') failures.push('mobile: content scrollbar is visible')
await capture(mobileOutput)
const mobileScroll = runId ? await verifyInternalScroll(`/runs/${runId}`) : null
if (mobileScroll && mobileScroll.range > 0 && !mobileScroll.moved) failures.push('mobile: long content cannot scroll internally')

if (consoleErrors.length) failures.push(...consoleErrors.map((error) => `console: ${error}`))
socket.close()

console.log(JSON.stringify({ failures, initial, switched, routes, desktopScroll, mobile, mobileScroll, desktopOutput, mobileOutput }, null, 2))
if (failures.length) process.exitCode = 1
