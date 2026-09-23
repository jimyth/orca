// Total-budget watchdog over the app-server startup/storageState sequence.
// The connection's first-frame timer proves liveness; this module proves the
// sequence converges.

/** Total budget for reaching storageState ready. Per-request deadlines pause
 *  while a non-terminal phase runs (a slow migration keeps its budget); this
 *  watchdog never pauses — its job is to bound a sequence that stalls, like a
 *  second zcode instance holding the SQLite lock in waiting_for_lock. */
export const STORAGE_SEQUENCE_TOTAL_TIMEOUT_MS = 120_000

export type ZcodeStorageSequenceWatchdog = {
  /** Records the newest phase for the expiry message. */
  observePhase: (phase: string) => void
  /** Disarms the budget; the gate settled or the transport went terminal. */
  clear: () => void
}

export function armZcodeStorageSequenceWatchdog(
  onExpire: (detail: string) => void
): ZcodeStorageSequenceWatchdog {
  let lastPhase: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    onExpire(
      `storage not ready within ${STORAGE_SEQUENCE_TOTAL_TIMEOUT_MS}ms ` +
        `(last phase: ${lastPhase ?? 'none'})`
    )
  }, STORAGE_SEQUENCE_TOTAL_TIMEOUT_MS)
  return {
    observePhase: (phase) => {
      lastPhase = phase
    },
    clear: () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
