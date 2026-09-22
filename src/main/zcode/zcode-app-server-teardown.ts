// Simplified inline teardown for the zcode app-server child: SIGTERM, then
// SIGKILL after a bounded grace. Replaced wholesale by the shared zcode
// process-tree killer once that lands — do not grow this module.

import type { ZcodeAppServerChild } from './zcode-app-server-connection-types'

const SIGTERM_EXIT_MS = 2_000
const SIGKILL_EXIT_MS = 2_000

export type ZcodeChildReaper = {
  /** Signals the child until its exit is observed or both deadlines expire. */
  kill: () => Promise<void>
}

// Inline twin of the codex exit deadline; goes away with the tree killer.
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
  function signalChild(signal: NodeJS.Signals): void {
    try {
      input.child.kill(signal)
    } catch {
      // Already gone; the exit proof is what matters.
    }
  }

  return {
    async kill() {
      signalChild('SIGTERM')
      await waitForExitUntil(input.exitPromise, SIGTERM_EXIT_MS)
      if (!input.hasExited()) {
        signalChild('SIGKILL')
        await waitForExitUntil(input.exitPromise, SIGKILL_EXIT_MS)
      }
    }
  }
}
