// Persistent stdio connection to a ZCode app-server child: LF-framed JSON
// traffic (see the frame reader), per-request deadlines, backpressure via
// pause/resume, and a storage-readiness gate in front of every request — the
// server's own startup/storageState sequence replaces an initialize handshake.
// Mirrors the codex app-server connection shape.

import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import { ZcodeAppServerRequestError } from './zcode-app-server-connection-errors'
import { createZcodeFrameReader } from './zcode-app-server-frame-reader'
import { createZcodePendingRequests } from './zcode-app-server-pending-requests'
import { createZcodeChildReaper, waitForExitUntil } from './zcode-app-server-teardown'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers,
  ZcodeAppServerLaunch,
  ZcodeAppServerSpawn
} from './zcode-app-server-connection-types'
import { ZCODE_NOTIFICATION_METHODS, type ZcodeProtocolFrame } from './zcode-protocol'

export type {
  ZcodeAppServerChild,
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers,
  ZcodeAppServerLaunch,
  ZcodeAppServerSpawn
} from './zcode-app-server-connection-types'
export {
  ZcodeAppServerProtocolError,
  ZcodeAppServerRequestError,
  ZcodeAppServerTimeoutError,
  isZcodeAppServerRequestError
} from './zcode-app-server-connection-errors'

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000
const STORAGE_FIRST_FRAME_TIMEOUT_MS = 30_000
const STDERR_TAIL_MAX_BYTES = 8192
const EXIT_DETAIL_MAX_CHARS = 400
// EOF grace before signalling; SIGTERM/SIGKILL deadlines live in the reaper.
const GRACEFUL_EXIT_MS = 1_800

const isParamsObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export async function openZcodeAppServerConnection(
  launch: ZcodeAppServerLaunch,
  handlers: ZcodeAppServerConnectionHandlers = {},
  spawnImpl: ZcodeAppServerSpawn = spawnProcess
): Promise<ZcodeAppServerConnection> {
  const child = spawnImpl({
    program: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env }
  })

  let stderrTail = ''
  let nextRequestId = 1
  let exitObserved = false
  let closing = false
  let exitReported = false
  const exitProof = new RetryableProcessExitProof()
  /** First terminal cause, or null while the transport is still usable. Set
   * once: the same death reaches us through several listeners, and the first
   * cause is the one worth reporting. */
  let terminalError: Error | null = null
  const requests = createZcodePendingRequests()

  let resolveExit = (): void => undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const reaper = createZcodeChildReaper({
    child,
    exitPromise,
    hasExited: () => exitObserved
  })

  let openGate = (): void => undefined
  let closeGate = (_error: Error): void => undefined
  const storageGate = new Promise<void>((resolve, reject) => {
    openGate = resolve
    closeGate = reject
  })
  // The gate can reject before the first request ever awaits it.
  void storageGate.catch(() => undefined)
  let gateSettled = false

  let firstFrameTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    firstFrameTimer = null
    markTerminal(
      new Error(`zcode app-server sent no frames within ${STORAGE_FIRST_FRAME_TIMEOUT_MS}ms`)
    )
    void reaper.kill()
  }, STORAGE_FIRST_FRAME_TIMEOUT_MS)

  function clearFirstFrameTimer(): void {
    if (firstFrameTimer !== null) {
      clearTimeout(firstFrameTimer)
      firstFrameTimer = null
    }
  }

  function observeExit(): void {
    exitObserved = true
    resolveExit()
  }

  function buildExitError(cause?: Error): Error {
    const tail = stderrTail.trim().slice(0, EXIT_DETAIL_MAX_CHARS)
    const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
    return new Error(`zcode app-server connection ended${detail}`)
  }

  /** A terminal cause fails every waiter and — once the execution host has
   *  observed `exit`/`close` — tells the owner, once. */
  function markTerminal(error: Error): void {
    clearFirstFrameTimer()
    if (terminalError === null) {
      terminalError = error
      if (!gateSettled) {
        gateSettled = true
        closeGate(error)
      }
      requests.fail(error)
    }
    if (exitObserved && !closing && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError)
    }
  }

  function handleUnexpectedEnd(cause?: Error): void {
    markTerminal(buildExitError(cause))
  }

  child.on('exit', () => {
    observeExit()
    handleUnexpectedEnd()
  })
  child.on('error', (error) => {
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    observeExit()
    handleUnexpectedEnd()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
  })
  child.stdin.on('error', (error) => {
    // A broken pipe is terminal, not one failed write: every later request can
    // only error or time out. During a close the reap is already under way.
    if (closing) {
      requests.fail(error)
      return
    }
    handleUnexpectedEnd(error)
    void reaper.kill()
  })

  function handleStorageStateNotification(params: unknown): void {
    if (!isParamsObject(params) || typeof params.phase !== 'string') {
      return
    }
    if (params.phase === 'ready') {
      requests.resumeTimers()
      if (!gateSettled) {
        gateSettled = true
        openGate()
      }
      return
    }
    if (params.phase === 'failed') {
      const errorCode = typeof params.errorCode === 'string' ? params.errorCode : 'unknown'
      markTerminal(new Error(`SQLite startup failed: ${errorCode}`))
      void reaper.kill()
      return
    }
    // checking / waiting_for_lock / migrating — the sequence is still moving.
    requests.pauseTimers()
  }

  function dispatchFrame(frame: ZcodeProtocolFrame): void {
    clearFirstFrameTimer()
    if (frame.kind === 'response' || frame.kind === 'error') {
      // Our request ids are numbers; a string id can only be the server's own.
      if (typeof frame.id !== 'number') {
        return
      }
      const waiter = requests.take(frame.id)
      if (waiter === undefined) {
        return
      }
      if (frame.kind === 'response') {
        waiter.resolve(frame.result)
        return
      }
      waiter.reject(
        new ZcodeAppServerRequestError(
          waiter.method,
          frame.error.code,
          `zcode app-server ${waiter.method} failed: ${frame.error.message}`
        )
      )
      return
    }
    if (frame.kind === 'server-request') {
      handlers.onServerRequest?.(frame)
      return
    }
    if (frame.method === ZCODE_NOTIFICATION_METHODS.storageState) {
      handleStorageStateNotification(frame.params)
    }
    handlers.onNotification?.(frame.method, frame.params)
  }

  const frameReader = createZcodeFrameReader({
    stdout: child.stdout,
    onFrame: dispatchFrame,
    onFatal: (error) => {
      markTerminal(error)
      void reaper.kill()
    },
    isDead: () => terminalError !== null
  })

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function writeResponse(payload: Record<string, unknown>): void {
    if (exitObserved || terminalError !== null || child.stdin.destroyed || !child.stdin.writable) {
      return
    }
    try {
      sendLine(payload)
    } catch {
      // The flow that asked is already gone with the child.
    }
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (closing) {
      return Promise.reject(new Error(`zcode app-server connection is closed (${method})`))
    }
    if (terminalError !== null) {
      return Promise.reject(terminalError)
    }
    if (exitObserved) {
      return Promise.reject(buildExitError())
    }
    // The deadline only starts once the storage gate is open.
    return storageGate.then(() => {
      if (closing) {
        throw new Error(`zcode app-server connection is closed (${method})`)
      }
      if (terminalError !== null) {
        throw terminalError
      }
      if (exitObserved) {
        throw buildExitError()
      }
      const id = nextRequestId++
      return new Promise<unknown>((resolve, reject) => {
        requests.add({
          id,
          method,
          resolve,
          reject,
          timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          consumedMs: 0,
          runningSince: Date.now(),
          timer: null
        })
        try {
          sendLine(params === undefined ? { method, id } : { method, id, params })
        } catch (error) {
          requests.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  }

  function close(): Promise<boolean> {
    if (exitObserved) {
      return Promise.resolve(true)
    }
    closing = true
    if (!gateSettled) {
      gateSettled = true
      closeGate(new Error('zcode app-server connection closed'))
    }
    return exitProof.run(async () => {
      try {
        child.stdin.end()
      } catch {
        // Already destroyed; the reap below still runs.
      }
      if (!exitObserved) {
        await waitForExitUntil(exitPromise, GRACEFUL_EXIT_MS)
        if (!exitObserved) {
          await reaper.kill()
        }
      }
      requests.fail(new Error('zcode app-server connection closed'))
      return exitObserved
    })
  }

  return {
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || exitObserved || terminalError !== null
    },
    request,
    respond: (id, result) => writeResponse({ id, result }),
    respondWithError: (id, code, message) => writeResponse({ id, error: { code, message } }),
    pauseReading: frameReader.pause,
    resumeReading: frameReader.resume,
    close
  }
}
