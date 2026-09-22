import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  isZcodeAppServerRequestError,
  openZcodeAppServerConnection,
  type ZcodeAppServerConnection,
  type ZcodeAppServerConnectionHandlers,
  type ZcodeAppServerSpawn
} from './zcode-app-server-connection'

/**
 * A real `node -e` child speaking the same LF-framed JSON the zcode app-server
 * does. Slower than a stub, but it is the only thing that proves the spawn, the
 * environment, and both traffic directions actually work end to end.
 * FAKE_ZCODE_STARTUP picks which startup/storageState sequence it emits.
 */
const FAKE_ZCODE_SERVER = String.raw`
  const send = (p) => process.stdout.write(JSON.stringify(p) + '\n')
  let buf = ''
  const startup = process.env.FAKE_ZCODE_STARTUP ?? 'ready'
  if (startup === 'ready') {
    send({ method: 'startup/storageState', params: { phase: 'checking', attemptId: 'a1', sequence: 1 } })
    send({ method: 'startup/storageState', params: { phase: 'ready', attemptId: 'a1', sequence: 2 } })
  } else if (startup === 'slow-ready') {
    send({ method: 'startup/storageState', params: { phase: 'checking', attemptId: 'a1', sequence: 1 } })
    setTimeout(() => {
      send({ method: 'startup/storageState', params: { phase: 'ready', attemptId: 'a1', sequence: 2 } })
    }, 300)
  } else if (startup === 'failed') {
    send({ method: 'startup/storageState', params: { phase: 'failed', attemptId: 'a1', sequence: 1, errorCode: 'SQLITE_BUSY' } })
  } else if (startup === 'garbage') {
    process.stdout.write('not json\n')
  }
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line)
      if (m.method === 'session/create') {
        send({ id: m.id, result: { session: { sessionId: 'sess_1' } } })
        continue
      }
      if (m.method === 'test/notify') {
        send({ method: 'session/event', params: { type: 'turn.started' } })
        send({ id: m.id, result: {} })
        continue
      }
      if (m.method === 'test/ask') {
        send({ id: 99, method: 'interaction/requestPermission', params: { requestId: 'r1', options: [] } })
        continue
      }
      if (m.method === 'test/no-reply') continue
      if (m.method === 'test/refuse') {
        send({ id: m.id, error: { code: -32602, message: 'bad params' } })
        continue
      }
      if (m.id === 99) {
        send({ method: 'test/answered', params: m })
        continue
      }
      send({ id: m.id, result: {} })
    }
  })
`

async function openFakeServer(
  handlers: ZcodeAppServerConnectionHandlers = {},
  startup = 'ready'
): Promise<ZcodeAppServerConnection> {
  return openZcodeAppServerConnection(
    {
      command: process.execPath,
      args: ['-e', FAKE_ZCODE_SERVER],
      env: { FAKE_ZCODE_STARTUP: startup }
    },
    handlers
  )
}

/** The stub's duplex streams double as the writable side a real child would own. */
type StubChild = NodeJS.EventEmitter & {
  pid: number
  kill: (signal?: NodeJS.Signals) => boolean
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function stubChild(options: { exitOnStdinEnd?: boolean } = {}): {
  child: StubChild
  spawnImpl: ZcodeAppServerSpawn
  written: Record<string, unknown>[]
} {
  const child: StubChild = Object.assign(new EventEmitter(), {
    // Keep the synthetic pid outside any real process table so teardown never
    // mistakes an unrelated process for this stub.
    pid: 9_999_999,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  const written: Record<string, unknown>[] = []
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) {
        continue
      }
      const parsed: unknown = JSON.parse(line)
      if (isFrameObject(parsed)) {
        written.push(parsed)
      }
    }
  })
  if (options.exitOnStdinEnd !== false) {
    child.stdin.on('finish', () => child.emit('exit', 0, null))
  }
  return { child, spawnImpl: () => child, written }
}

function storageLine(
  phase: 'checking' | 'ready' | 'failed',
  attemptId: string,
  sequence: number,
  errorCode?: string
): string {
  const params =
    errorCode === undefined
      ? { phase, attemptId, sequence }
      : { phase, attemptId, sequence, errorCode }
  return `${JSON.stringify({ method: 'startup/storageState', params })}\n`
}

function notificationLine(method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ method, params })}\n`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const isFrameObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Stream writes land a tick later, so the stderr tail is only complete here. */
async function flushStreams(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected the call to reject')
    },
    (error: Error) => error
  )
}

describe('openZcodeAppServerConnection', () => {
  it('gates requests until storageState reports ready', async () => {
    const connection = await openFakeServer({}, 'slow-ready')

    const gated = connection.request('session/create')
    let settled = false
    void gated.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await sleep(120) // the fake reports ready at ~300ms
    expect(settled).toBe(false)

    await expect(gated).resolves.toEqual({ session: { sessionId: 'sess_1' } })
    await connection.close()
  }, 10_000)

  it('resolves session/create results over a live connection', async () => {
    const connection = await openFakeServer()

    await expect(connection.request('session/create')).resolves.toEqual({
      session: { sessionId: 'sess_1' }
    })
    expect(connection.pid).toBeGreaterThan(0)
    expect(connection.closed).toBe(false)

    await expect(connection.close()).resolves.toBe(true)
    expect(connection.closed).toBe(true)
  }, 10_000)

  it('delivers notifications to onNotification', async () => {
    const notifications: { method: string; params: unknown }[] = []
    const connection = await openFakeServer({
      onNotification: (method, params) => notifications.push({ method, params })
    })

    await connection.request('test/notify')

    expect(notifications).toContainEqual({
      method: 'session/event',
      params: { type: 'turn.started' }
    })
    await connection.close()
  }, 10_000)

  it('surfaces server requests and delivers respond()', async () => {
    const requests: { id: number | string; method: string }[] = []
    let resolveAnswered: (params: unknown) => void = () => {}
    const answered = new Promise<unknown>((resolve) => {
      resolveAnswered = resolve
    })
    const connection = await openFakeServer({
      onServerRequest: (request) => {
        requests.push({ id: request.id, method: request.method })
        connection.respond(request.id, { decision: 'allow' })
      },
      onNotification: (method, params) => {
        if (method === 'test/answered') {
          resolveAnswered(params)
        }
      }
    })

    // The fake never answers this call; it is rejected when close fails pending.
    void connection.request('test/ask').catch(() => undefined)

    expect(await answered).toEqual({ id: 99, result: { decision: 'allow' } })
    expect(requests).toEqual([{ id: 99, method: 'interaction/requestPermission' }])
    await connection.close()
  }, 10_000)

  it('resolves close true once the child exits on stdin EOF', async () => {
    const connection = await openFakeServer()

    await expect(connection.close()).resolves.toBe(true)
  }, 10_000)

  it('closes the connection when a frame cannot be parsed', async () => {
    const exits: string[] = []
    const connection = await openFakeServer(
      { onExit: (error) => exits.push(error.message) },
      'garbage'
    )

    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 5_000 })
    expect(exits[0]).toContain('protocol_parse_error')
    expect(connection.closed).toBe(true)
    await connection.close()
  }, 10_000)

  it('rejects gated requests when storage startup fails', async () => {
    const connection = await openFakeServer({}, 'failed')

    const error = await rejection(connection.request('session/create'))

    expect(error.message).toContain('SQLite startup failed: SQLITE_BUSY')
    expect(connection.closed).toBe(true)
    await connection.close()
  }, 10_000)

  it('times out one request without ending the connection', async () => {
    const connection = await openFakeServer()

    const error = await rejection(
      connection.request('test/no-reply', undefined, { timeoutMs: 100 })
    )

    expect(error.name).toBe('ZcodeAppServerTimeoutError')
    expect(connection.closed).toBe(false)
    await expect(connection.request('session/create')).resolves.toEqual({
      session: { sessionId: 'sess_1' }
    })
    await connection.close()
  }, 10_000)

  it('rejects with the server error code when the call is refused', async () => {
    const connection = await openFakeServer()

    const error = await rejection(connection.request('test/refuse'))
    if (!isZcodeAppServerRequestError(error)) {
      throw new Error(`expected a request error, got ${error.name}`)
    }

    expect(error.message).toContain('bad params')
    expect(error.code).toBe(-32602)
    await connection.close()
  }, 10_000)

  it('pauses between coalesced frames and resumes the retained remainder', async () => {
    const { child, spawnImpl } = stubChild()
    const notifications: string[] = []
    let connection: ZcodeAppServerConnection
    connection = await openZcodeAppServerConnection(
      { command: 'zcode', args: ['app-server'] },
      {
        onNotification: (method) => {
          notifications.push(method)
          if (notifications.length === 1) {
            connection.pauseReading()
          }
        }
      },
      spawnImpl
    )

    child.stdout.write(
      storageLine('ready', 'a1', 1) +
        notificationLine('session/event', { type: 'turn.started' }) +
        notificationLine('session/event', { type: 'turn.completed' })
    )
    await vi.waitFor(() => expect(notifications).toEqual(['startup/storageState']))
    await sleep(50) // prove the retained frames stay held while paused
    expect(notifications).toEqual(['startup/storageState'])

    connection.resumeReading()
    await vi.waitFor(() => expect(notifications).toHaveLength(3))
    expect(notifications).toEqual(['startup/storageState', 'session/event', 'session/event'])
    await connection.close()
  })

  it('pauses in-flight request deadlines while a storage sequence is in progress', async () => {
    const { child, spawnImpl, written } = stubChild()
    const connection = await openZcodeAppServerConnection(
      { command: 'zcode', args: ['app-server'] },
      {},
      spawnImpl
    )

    child.stdout.write(storageLine('ready', 'a1', 1))
    const slow = rejection(connection.request('test/no-reply', undefined, { timeoutMs: 120 }))
    await vi.waitFor(() =>
      expect(written.some((frame) => frame.method === 'test/no-reply')).toBe(true)
    )

    child.stdout.write(storageLine('checking', 'a2', 1))
    let observed: Error | undefined
    void slow.then((error) => {
      observed = error
    })
    await sleep(300) // past the 120ms budget, but the deadline is paused
    expect(observed).toBeUndefined()

    child.stdout.write(storageLine('ready', 'a2', 2))
    const error = await slow
    expect(error.name).toBe('ZcodeAppServerTimeoutError')
    await connection.close()
  })

  it('fails in-flight requests and reports an unexpected exit once', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    const exits: string[] = []
    const connection = await openZcodeAppServerConnection(
      { command: 'zcode', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    child.stdout.write(storageLine('ready', 'a1', 1))
    const inFlight = rejection(connection.request('session/create'))
    child.stderr.write('zcode crashed\n')
    await flushStreams()
    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect((await inFlight).message).toContain('zcode crashed')
    expect(exits).toHaveLength(1)
    await expect(connection.close()).resolves.toBe(true)
  })
})
