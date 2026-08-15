const expectedRunName = process.argv[2]
if (!expectedRunName) throw new Error('pass the expected run name')

const targets = await fetch('http://127.0.0.1:9224/json').then((response) => response.json())
const target = targets.find((item) => item.type === 'page')
if (!target) throw new Error('No Chrome page target is available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
const consoleErrors = []
let nextId = 1

socket.addEventListener('message', (message) => {
  const packet = JSON.parse(message.data)
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

await command('Runtime.enable')
const initial = await evaluate(`({
  path: location.pathname,
  rows: document.querySelectorAll('.data-table tbody tr').length,
})`)
if (initial.path !== '/projects') throw new Error(`Expected /projects, found ${initial.path}`)

const deadline = Date.now() + 12_000
let retained
while (Date.now() < deadline) {
  retained = await evaluate(`(() => {
    const name = ${JSON.stringify(expectedRunName)}
    const rows = [...document.querySelectorAll('.data-table tbody tr')]
    const row = rows.find((candidate) => candidate.textContent.includes(name))
    return row ? {
      rows: rows.length,
      state: row.querySelector('.run-state')?.textContent.trim(),
      metric: row.querySelector('.metric-cell')?.textContent.trim(),
    } : null
  })()`)
  if (retained) break
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const failures = []
if (!retained) failures.push('completed run did not appear without a page reload')
if (retained?.rows <= initial.rows) failures.push('run ledger row count did not increase')
if (retained?.state !== 'finished') failures.push(`expected finished state, found ${retained?.state}`)
if (!retained?.metric.includes('0.875')) failures.push(`expected retained metric, found ${retained?.metric}`)
failures.push(...consoleErrors.map((error) => `console: ${error}`))

console.log(JSON.stringify({ failures, initial, retained, path: await evaluate('location.pathname') }, null, 2))
socket.close()
if (failures.length) process.exitCode = 1
