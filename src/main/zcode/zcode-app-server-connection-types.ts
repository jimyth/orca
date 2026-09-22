import type { Readable, Writable } from 'node:stream'
import type { ZcodeProtocolServerRequest } from './zcode-protocol'

export type ZcodeAppServerLaunch = {
  command: string
  args: string[]
  /** Overlay on the inherited environment. */
  env?: Record<string, string>
  /** Working directory used by the server process itself. */
  cwd?: string
}

export type ZcodeAppServerConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (request: ZcodeProtocolServerRequest) => void
  onExit?: (error: Error) => void
}

export type ZcodeAppServerConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
  /** Answers a server-initiated request; not gated on storage readiness. */
  respond: (id: number | string, result: unknown) => void
  /** Rejects a server-initiated request the host will not or cannot answer. */
  respondWithError: (id: number | string, code: number, message: string) => void
  /** Stops server stdout at a frame boundary while a durable sink drains. */
  pauseReading: () => void
  /** Continues with any frames retained from the chunk that triggered the pause. */
  resumeReading: () => void
  /** Resolves true only after the child emitted `exit` or `close`; false is unproven. */
  close: () => Promise<boolean>
}

/** Structural spawn surface so tests (and future supervisors) can inject a child. */
export type ZcodeAppServerChild = NodeJS.EventEmitter & {
  readonly pid?: number | undefined
  kill: (signal?: NodeJS.Signals) => boolean
  stdin: Writable
  stdout: Readable
  stderr: Readable
}

export type ZcodeAppServerSpawn = (spec: {
  program: string
  args: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}) => ZcodeAppServerChild
