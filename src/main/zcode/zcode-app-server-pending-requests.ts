import { ZcodeAppServerTimeoutError } from './zcode-app-server-connection-errors'

export type ZcodePendingRequest = {
  id: number
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeoutMs: number
  /** Deadline budget already spent, excluding spans paused by a storage sequence. */
  consumedMs: number
  runningSince: number | null
  timer: ReturnType<typeof setTimeout> | null
}

export type ZcodePendingRequests = {
  add: (waiter: ZcodePendingRequest) => void
  /** Removes and disarms one waiter, returning it for settlement. */
  take: (id: number) => ZcodePendingRequest | undefined
  delete: (id: number) => void
  fail: (error: Error) => void
  /** While a storage sequence is moving, in-flight deadlines stop burning down. */
  pauseTimers: () => void
  resumeTimers: () => void
}

export function createZcodePendingRequests(): ZcodePendingRequests {
  const pending = new Map<number, ZcodePendingRequest>()

  function clearTimer(waiter: ZcodePendingRequest): void {
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer)
      waiter.timer = null
    }
  }

  function armTimer(waiter: ZcodePendingRequest): void {
    // Per request, not per session: a chat session outlives every call, so only
    // the individual call can carry a deadline.
    waiter.timer = setTimeout(
      () => {
        waiter.timer = null
        pending.delete(waiter.id)
        waiter.reject(
          new ZcodeAppServerTimeoutError(
            `zcode app-server ${waiter.method} exceeded ${waiter.timeoutMs}ms`
          )
        )
      },
      Math.max(waiter.timeoutMs - waiter.consumedMs, 0)
    )
  }

  return {
    add: (waiter) => {
      armTimer(waiter)
      pending.set(waiter.id, waiter)
    },
    take: (id) => {
      const waiter = pending.get(id)
      if (waiter === undefined) {
        return undefined
      }
      pending.delete(id)
      clearTimer(waiter)
      return waiter
    },
    delete: (id) => {
      const waiter = pending.get(id)
      if (waiter !== undefined) {
        clearTimer(waiter)
      }
      pending.delete(id)
    },
    fail: (error) => {
      for (const waiter of pending.values()) {
        clearTimer(waiter)
        waiter.reject(error)
      }
      pending.clear()
    },
    pauseTimers: () => {
      for (const waiter of pending.values()) {
        if (waiter.runningSince !== null) {
          waiter.consumedMs += Date.now() - waiter.runningSince
          waiter.runningSince = null
        }
        clearTimer(waiter)
      }
    },
    resumeTimers: () => {
      for (const waiter of pending.values()) {
        if (waiter.runningSince !== null) {
          continue
        }
        waiter.runningSince = Date.now()
        armTimer(waiter)
      }
    }
  }
}
