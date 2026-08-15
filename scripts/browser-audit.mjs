import { writeFile } from 'node:fs/promises'

const [, , url, output = '/tmp/oplogs-browser-audit.png', widthArg = '1440', heightArg = '1000'] = process.argv
const selectedTab = process.argv[6]
const width = Number(widthArg)
const height = Number(heightArg)
const targets = await fetch('http://127.0.0.1:9224/json').then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('No Chrome page target is available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const events = []
let nextId = 1
let resolveLoad

socket.addEventListener('message', (message) => {
  const packet = JSON.parse(message.data)
  if (packet.id && pending.has(packet.id)) {
    const { resolve, reject } = pending.get(packet.id)
    pending.delete(packet.id)
    if (packet.error) reject(new Error(packet.error.message))
    else resolve(packet.result)
    return
  }
  if (packet.method === 'Runtime.consoleAPICalled' || packet.method === 'Runtime.exceptionThrown') {
    events.push(packet)
  }
  if (packet.method === 'Page.loadEventFired') resolveLoad?.()
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

await Promise.all([
  command('Page.enable'),
  command('Runtime.enable'),
  command('Network.enable'),
  command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 }),
])
const loaded = new Promise((resolve) => { resolveLoad = resolve })
await command('Page.navigate', { url })
let loadTimer
await Promise.race([
  loaded,
  new Promise((_, reject) => {
    loadTimer = setTimeout(() => reject(new Error('Page load timed out')), 15_000)
  }),
])
clearTimeout(loadTimer)

const deadline = Date.now() + 15_000
let state
do {
  await new Promise((resolve) => setTimeout(resolve, 250))
  state = await evaluate(`({
    ready: document.readyState,
    text: document.querySelector('main')?.innerText?.slice(0, 1200) || document.body.innerText.slice(0, 1200),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollY,
    tabs: [...document.querySelectorAll('[role="tab"]')].map((node) => ({name: node.textContent, selected: node.getAttribute('aria-selected')})),
    navigation: [...document.querySelectorAll('.sidebar nav .nav-item')].map((node) => { const box = node.getBoundingClientRect(); return {name: node.textContent.trim(), left: box.left, right: box.right, width: box.width}; }),
  })`)
} while (Date.now() < deadline && /Connecting to the local store|Loading run/.test(state.text))

await evaluate('scrollTo(0, 0)')
state.scrollY = await evaluate('scrollY')
if (selectedTab) {
  const tabRect = await evaluate(`(() => { const node = [...document.querySelectorAll('[role="tab"]')].find((item) => item.textContent.trim() === ${JSON.stringify(selectedTab)}); if (!node) return null; const box = node.getBoundingClientRect(); return {x: box.x + box.width / 2, y: box.y + box.height / 2}; })()`)
  if (!tabRect) throw new Error(`Tab not found: ${selectedTab}`)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: tabRect.x, y: tabRect.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tabRect.x, y: tabRect.y, button: 'left', clickCount: 1 })
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await writeFile(output, Buffer.from(screenshot.data, 'base64'))

const result = {
  url: await evaluate('location.href'),
  title: await evaluate('document.title'),
  state,
  console: events.map((event) => ({
    method: event.method,
    text: event.params?.args?.map((arg) => arg.value ?? arg.description).join(' ') ?? event.params?.exceptionDetails?.text,
  })),
  output,
}
console.log(JSON.stringify(result, null, 2))
socket.close()
