#!/usr/bin/env node
// scripts/spike/zcode-app-server-transcript.mjs — drive `zcode app-server --stdio` over stdio
// NDJSON and dump every frame both directions to a transcript file. Protocol facts:
// frames are LF-delimited, envelope discriminated by result/error before method.
// Permission server-requests are auto-allowed so the turn runs its tool calls to completion.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const ZCODE_BIN = process.env.ZCODE_BIN ?? 'zcode'
const outPath = process.argv[2] ?? 'transcript.ndjson'
await mkdir(dirname(outPath), { recursive: true })
const out = createWriteStream(outPath)
const log = (direction, frame) => out.write(JSON.stringify({ direction, ...frame }) + '\n')

const child = spawn(ZCODE_BIN, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
let nextId = 1
const pending = new Map()
const waiters = []
let stdoutBuffer = ''

const send = (frame) => {
  log('out', frame)
  child.stdin.write(JSON.stringify(frame) + '\n')
}
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, method })
    send({ id, method, params })
  })
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = (predicate, label, timeoutMs) =>
  new Promise((resolve, reject) => {
    const waiter = { predicate, resolve }
    waiters.push(waiter)
    setTimeout(() => {
      const i = waiters.indexOf(waiter)
      if (i < 0) return
      waiters.splice(i, 1)
      reject(new Error(`timeout waiting for ${label}`))
    }, timeoutMs)
  })
const dispatch = (frame) => {
  for (const w of [...waiters]) {
    if (w.predicate(frame)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(frame)
    }
  }
}

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk
  let i
  while ((i = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, i).replace(/\r$/, '')
    stdoutBuffer = stdoutBuffer.slice(i + 1)
    if (!line.trim()) continue
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      console.error(`[spike] unparseable frame: ${line.slice(0, 200)}`)
      continue
    }
    log('in', frame)
    handleFrame(frame)
  }
})
child.stderr.on('data', (c) => process.stderr.write(`[zcode stderr] ${c}`))
child.on('exit', (code) => console.error(`app-server exited ${code}`))

function handleFrame(frame) {
  if ('result' in frame && pending.has(frame.id)) {
    pending.get(frame.id).resolve(frame.result)
    dispatch(frame)
    return
  }
  if ('error' in frame && pending.has(frame.id)) {
    pending
      .get(frame.id)
      .reject(new Error(`request ${pending.get(frame.id).method} failed: ${JSON.stringify(frame.error)}`))
    dispatch(frame)
    return
  }
  if (frame.method === 'session/requestRuntimePreferences') {
    // server-initiated request during session/create; unanswered it times out after 15s
    // and fails session/create with code -32022
    send({
      id: frame.id,
      result: {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: true,
        modelContextBudgetStrategy: 'preflight-v1',
      },
    })
  }
  if (frame.method === 'interaction/requestPermission') {
    // CLI re-sends the same requestId every 1s until answered; allow so the turn completes
    send({ id: frame.id, result: { decision: 'allow' } })
  }
  dispatch(frame)
}

const main = async () => {
  // 1. wait for startup/storageState phase=ready (all requests are gated on it)
  const storage = await waitFor(
    (f) => f.method === 'startup/storageState' && f.params?.phase === 'ready',
    'storageState phase=ready',
    60_000,
  )
  console.error(`storageState ready: ${JSON.stringify(storage.params).slice(0, 300)}`)

  // 2. create a session in a scratch workspace
  const created = await request('session/create', {
    workspace: { workspacePath: '/tmp/zcode-spike-ws', workspaceKey: 'spike' },
  })
  console.error(`session/create result: ${JSON.stringify(created).slice(0, 400)}`)
  const sessionId = created?.session?.sessionId ?? created?.sessionId
  if (!sessionId) throw new Error('no sessionId in session/create result: ' + JSON.stringify(created))

  // 3. subscribe BEFORE sending so no event is missed
  await request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' })

  // 4. send a prompt that exercises tools + a permission prompt. modelSelection is
  // required: without it the turn fails at model_creation with "Select a model before continuing"
  await request('session/send', {
    sessionId,
    content: 'Create a file named spike.txt with the text hi, then read it back.',
    modelSelection: {
      providerId: process.env.ZCODE_PROVIDER_ID ?? 'bigmodel-api',
      modelId: process.env.ZCODE_MODEL_ID ?? 'GLM-5.3',
      // reasoningLevel is mandatory when the model declares reasoning variants
      options: { reasoningLevel: process.env.ZCODE_REASONING_LEVEL ?? 'max' },
    },
  })

  // 5. let the turn run to completion (permission requests are auto-allowed in handleFrame)
  await waitFor(
    (f) => f.method === 'session/event' && f.params?.type === 'turn.completed',
    'turn.completed',
    180_000,
  ).catch((e) => console.error(`[spike] ${e.message}; continuing`))

  // 6. resume probe
  const resumed = await request('session/resume', { sessionId })
  console.error(`session/resume result: ${JSON.stringify(resumed).slice(0, 400)}`)
  await waitMs(2000)

  child.stdin.end()
  await waitMs(2500)
  child.kill('SIGKILL')
  out.end()
  process.exit(0)
}

main().catch((e) => {
  console.error(`[spike] fatal: ${e.stack ?? e}`)
  out.end()
  child.kill('SIGKILL')
  process.exit(1)
})
