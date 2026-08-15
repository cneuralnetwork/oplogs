const baseUrl = process.argv[2] || 'http://127.0.0.1:7437'
const runId = process.argv[3] || '3bc4e4be6ac1'
const runName = process.argv[4] || 'image-model-v7'
const targets = await fetch('http://127.0.0.1:9224/json').then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('No Chrome page target is available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const failures = []
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

async function click(expression, label) {
  const rect = await evaluate(`(() => { const node = ${expression}; if (!node) return null; const box = node.getBoundingClientRect(); return {x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height}; })()`)
  if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`${label} is not visible`)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  await new Promise((resolve) => setTimeout(resolve, 180))
}

function exactText(selector, text, closest = '') {
  return `([...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim() === ${JSON.stringify(text)}))${closest ? `?.closest(${JSON.stringify(closest)})` : ''}`
}

await command('Runtime.enable')
await command('Page.enable')
await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
const loaded = new Promise((resolve) => { resolveLoad = resolve })
await command('Page.navigate', { url: `${baseUrl}/runs/${runId}` })
let loadTimer
await Promise.race([
  loaded,
  new Promise((_, reject) => {
    loadTimer = setTimeout(() => reject(new Error('Page load timed out')), 15_000)
  }),
])
clearTimeout(loadTimer)
const renderDeadline = Date.now() + 15_000
while (
  Date.now() < renderDeadline
  && !(await evaluate(`[...document.querySelectorAll('[role="tab"]')].some((node) => node.textContent.trim() === 'Overview')`))
) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
if (Date.now() >= renderDeadline) throw new Error('Run tabs did not render')

for (const tabName of ['Samples', 'Logs', 'System', 'Traces', 'Files', 'Source', 'Overview']) {
  await click(exactText('[role="tab"]', tabName), `${tabName} tab`)
  const selected = await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()`)
  if (selected !== tabName) failures.push(`${tabName} tab did not activate`)
  const expected = {
    Samples: '.media-grid img, .rich-samples article',
    Logs: '.console code',
    System: '.chart, .chart-empty',
    Traces: '.trace-list article, .tab-empty',
    Files: '.data-table tbody tr',
    Source: '.source-view pre',
    Overview: '.chart-panel',
  }[tabName]
  if (!(await evaluate(`Boolean(document.querySelector(${JSON.stringify(expected)}))`))) {
    failures.push(`${tabName} content did not render`)
  }
}

for (const [label, path] of [
  ['Projects', '/projects'],
  ['Artifacts', '/artifacts'],
  ['Sweeps', '/sweeps'],
  ['Registry', '/registry'],
  ['Reports', '/reports'],
  ['Traces', '/traces'],
  ['Settings', '/settings'],
]) {
  await click(exactText('.sidebar .nav-item', label), `${label} navigation`)
  if (await evaluate('location.pathname') !== path) failures.push(`${label} navigation did not change route`)
  if (!(await evaluate(`document.querySelector('.standard-page h1')?.textContent === ${JSON.stringify(label)}`))) {
    failures.push(`${label} view did not render`)
  }
}

await click(exactText('.sidebar .nav-item', 'Runs'), 'Runs navigation')
if (await evaluate(`document.querySelector('.runs-page h1')?.textContent !== 'Runs'`)) failures.push('Runs view did not render')
await click(`document.querySelector('.command-search input')`, 'command search')
await command('Input.insertText', { text: runId })
await new Promise((resolve) => setTimeout(resolve, 180))
if (await evaluate(`document.querySelectorAll('.data-table tbody tr').length`) !== 1) failures.push('command search did not filter runs')
await click(exactText('.data-table strong', runName, 'tr'), 'run table row')
if (!(await evaluate(`location.pathname.includes(${JSON.stringify(runId)})`))) failures.push('Run row did not open')

const result = {
  failures,
  url: await evaluate('location.href'),
  activeTab: await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()`),
  consoleErrors,
}
console.log(JSON.stringify(result, null, 2))
socket.close()
if (failures.length || consoleErrors.length) process.exitCode = 1
