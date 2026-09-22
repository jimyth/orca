// Whole-tree teardown for one zcode app-server launch: a graceful SIGTERM
// ladder in front of the codex-proven descendant sweep, so a well-behaved
// server can flush its SQLite state before anything is forced.

import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { findAgentSessionSpawnTokenProcesses } from '../runtime/agent-session-spawn-token-process-scan'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import type { ZcodeAppServerChild } from './zcode-app-server-connection-types'

const SIGTERM_GRACE_MS = 2_000
const SIGKILL_EXIT_MS = 2_000
const TOKEN_PROCESS_EXIT_TIMEOUT_MS = 3_500
const TOKEN_PROCESS_POLL_MS = 25
const activeTeardowns = new WeakMap<object, Promise<boolean>>()

type TeardownChild = Pick<ZcodeAppServerChild, 'pid' | 'kill'>

export type ZcodeProcessTreeKillOptions = {
  /** SIGTERM grace before the forced tree kill. */
  afterMs?: number
  platform?: NodeJS.Platform
  spawnToken?: string
  /** Root exit proof owned by the connection; absent degrades to a pid probe. */
  exitPromise?: Promise<void>
  hasExited?: () => boolean
  /** Diagnostic/recovery injection only; never used by the primary teardown. */
  findSpawnTokenProcesses?: (spawnToken: string) => Promise<number[] | null>
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
  terminateWindowsTree?: (rootPid: number, deps?: { site?: string }) => Promise<void>
  signalPid?: (pid: number, signal: NodeJS.Signals) => void
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
  isPidPresent?: (pid: number) => boolean
  wait?: (ms: number) => Promise<void>
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // An already-gone exact PID is the desired outcome.
  }
}

function isPidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function diagnosticTokenFallback(
  rootPid: number,
  spawnToken: string,
  options: ZcodeProcessTreeKillOptions
): Promise<boolean> {
  const find = options.findSpawnTokenProcesses ?? findAgentSessionSpawnTokenProcesses
  const signal = options.signalPid ?? sendSignal
  const pidPresent = options.isPidPresent ?? isPidPresent
  const delay =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + TOKEN_PROCESS_EXIT_TIMEOUT_MS
  const signalled = new Set<number>()
  while (Date.now() < deadline) {
    const pids = await find(spawnToken).catch(() => null)
    if (pids === null) {
      return false
    }
    for (const pid of pids.filter((candidate) => candidate !== rootPid)) {
      signalled.add(pid)
      signal(pid, 'SIGKILL')
    }
    if ([...signalled].every((pid) => !pidPresent(pid))) {
      return true
    }
    await delay(TOKEN_PROCESS_POLL_MS)
  }
  return false
}

async function killOnce(
  child: TeardownChild,
  options: ZcodeProcessTreeKillOptions
): Promise<boolean> {
  const rootPid = child.pid
  if (!rootPid) {
    child.kill('SIGKILL')
    return false
  }
  const delay =
    options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const signalChild = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal)
    } catch {
      // Already gone; the exit proof is what matters.
    }
  }
  const rootExited = (): boolean =>
    options.hasExited ? options.hasExited() : !(options.isPidPresent ?? isPidPresent)(rootPid)
  const waitForExit = async (ms: number): Promise<void> => {
    if (!options.exitPromise) {
      await delay(ms)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
    try {
      await Promise.race([options.exitPromise, timeout])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }
  const capture = options.captureDescendants ?? captureDescendantSnapshot
  // Why strict identity: both sweeps may run after the root's death, which opens
  // a PID-reuse window on the snapshotted pids — every signal must revalidate
  // identity first (the Claude close-proof precedent for post-owner signalling).
  const terminate =
    options.terminateDescendants ??
    ((snapshot: DescendantSnapshot) =>
      terminateDescendantSnapshotAndWait(snapshot, { requireIdentityBeforeSignal: true }))

  if ((options.platform ?? process.platform) === 'win32') {
    const terminateTree = options.terminateWindowsTree ?? terminateWindowsProcessTree
    await terminateTree(rootPid, { site: 'zcode-app-server-teardown' })
    // taskkill owns the tree; this preserves the prior direct-child fallback when it fails.
    signalChild('SIGKILL')
    await waitForExit(SIGKILL_EXIT_MS)
    return true
  }

  // Kept only for explicit recovery callers/tests; token enumeration is
  // evidence, never the owner of orphan-reaping decisions.
  if (options.spawnToken && options.findSpawnTokenProcesses) {
    const reaped = await diagnosticTokenFallback(rootPid, options.spawnToken, options)
    if (reaped) {
      child.kill('SIGKILL')
      return true
    }
    return false
  }

  // The snapshot must precede every signal: once the root dies, its survivors
  // reparent to pid 1 and a ppid walk can no longer find them.
  const preSignal = await capture(rootPid).catch(() => null)

  signalChild('SIGTERM')
  await waitForExit(options.afterMs ?? SIGTERM_GRACE_MS)
  if (rootExited()) {
    // The root died on its own terms; only its survivors may still need the sweep.
    if (!preSignal) {
      return true
    }
    return terminate(preSignal)
  }

  // Forced phase. Freeze the root so it cannot fork during the fresh walk, then
  // kill it BEFORE sweeping: a descendant that dies under a stopped root zombies
  // (the root cannot waitpid), so its identity row never leaves the process
  // table and the exit proof cannot converge. Killing the root first reparents
  // those deaths to init, which reaps them.
  signalChild('SIGSTOP')
  const fresh = await capture(rootPid).catch(() => null)
  // A walk that lost the root row says nothing about its survivors; the
  // pre-signal identities still do, and the sweep revalidates them.
  const snapshot = fresh?.root ? fresh : preSignal
  signalChild('SIGKILL')
  if (!snapshot) {
    await waitForExit(SIGKILL_EXIT_MS)
    return true
  }
  const descendantsExited = await terminate(snapshot)
  if (!descendantsExited) {
    return false
  }
  if (snapshot.rootPgid === rootPid) {
    // A detached launch leads its own process group; group signalling reaches
    // grandchildren even after they reparent. The equality guard keeps an
    // ordinary non-detached child — sharing Orca's own group — out of the sweep.
    const signalGroup =
      options.signalProcessGroup ??
      ((pgid: number, signal: NodeJS.Signals) => process.kill(-pgid, signal))
    let groupSignalled = false
    try {
      signalGroup(snapshot.rootPgid, 'SIGKILL')
      groupSignalled = true
    } catch {
      // Already-gone is still the desired outcome, but nothing here killed it,
      // and a crumb for a kill we never landed is a false render-process-gone suspect.
    }
    if (groupSignalled) {
      recordSelfInitiatedTreeKill({
        pid: snapshot.rootPgid,
        site: 'zcode-app-server-teardown',
        scope: 'posix-process-group'
      })
    }
  }
  await waitForExit(SIGKILL_EXIT_MS)
  return true
}

/**
 * Stops every process owned by one zcode app-server launch. True only after
 * the descendant sweep proved every snapshotted descendant gone and the root
 * was force-killed; an unprovable sweep returns false. Never rejects.
 */
export function killZcodeProcessTree(
  child: TeardownChild,
  options: ZcodeProcessTreeKillOptions = {}
): Promise<boolean> {
  const active = activeTeardowns.get(child)
  if (active) {
    return active
  }
  const attempt = killOnce(child, options).catch(() => false)
  activeTeardowns.set(child, attempt)
  void attempt.then(() => {
    if (activeTeardowns.get(child) === attempt) {
      activeTeardowns.delete(child)
    }
  })
  return attempt
}
