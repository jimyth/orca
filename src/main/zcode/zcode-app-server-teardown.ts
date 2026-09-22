// Connection adapter over the shared zcode process-tree killer: the connection
// owns the root's exit proof, the killer owns the whole-tree reaping.

import type { ZcodeAppServerChild } from './zcode-app-server-connection-types'
import { killZcodeProcessTree } from './zcode-app-server-process-teardown'

export type ZcodeChildReaper = {
  /** Signals the child's whole tree until exit is observed or the deadlines expire. */
  kill: () => Promise<void>
}

export async function waitForExitUntil(deadline: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([deadline, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export function createZcodeChildReaper(input: {
  child: ZcodeAppServerChild
  exitPromise: Promise<void>
  hasExited: () => boolean
}): ZcodeChildReaper {
  return {
    async kill() {
      await killZcodeProcessTree(input.child, {
        exitPromise: input.exitPromise,
        hasExited: input.hasExited
      })
    }
  }
}
