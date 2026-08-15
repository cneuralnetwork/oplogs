const baseUrl = process.argv[2] || 'http://127.0.0.1:7437'
const runId = process.argv[3] || '3bc4e4be6ac1'
const runName = process.argv[4] || 'image-model-v7'
const targets = await fetch('http://127.0.0.1:9224/json').then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('No Chrome page target is available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const failures = []
let nextId = 1

socket.addEventListener('message', (message) => {
  const packet = JSON.parse(message.data)
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
await command('Page.navigate', { url: `${baseUrl}/runs/${runId}` })
await new Promise((resolve) => setTimeout(resolve, 1200))

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

await click(exactText('.sidebar .nav-item', 'Artifacts'), 'Artifacts navigation')
if (!String(await evaluate('location.pathname')).startsWith('/artifacts')) failures.push('Artifacts navigation did not change route')
if (!(await evaluate(`document.querySelector('.standard-page h1')?.textContent === 'Artifacts'`))) failures.push('Artifacts view did not render')

await click(exactText('.sidebar .nav-item', 'Runs'), 'Runs navigation')
if (await evaluate(`document.querySelector('.runs-page h1')?.textContent !== 'Runs'`)) failures.push('Runs view did not render')
await click(exactText('.data-table strong', runName, 'tr'), 'run table row')
if (!(await evaluate(`location.pathname.includes(${JSON.stringify(runId)})`))) failures.push('Run row did not open')

const result = {
  failures,
  url: await evaluate('location.href'),
  activeTab: await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim()`),
  consoleErrors: await evaluate(`window.__oplogsSmokeErrors || []`),
}
console.log(JSON.stringify(result, null, 2))
socket.close()
if (failures.length) process.exitCode = 1
