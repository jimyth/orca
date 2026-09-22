import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import { spawnProcess } from '../../shared/child-process/run-process'
import { openZcodeAppServerConnection } from './zcode-app-server-connection'
import { killZcodeProcessTree } from './zcode-app-server-process-teardown'

/** Above pid_max on every supported POSIX host, so the group signal is a real ESRCH. */
const UNREACHABLE_PGID = 2_147_483_647

function child() {
  return {
    pid: 1234,
    kill: vi.fn(() => true)
  }
}

function descendantRow(pid: number, ppid = 1234) {
  return { pid, ppid, pgid: 1234, startedAt: 'Mon Jul 13 12:54:46 2026' }
}

/** No-op wait seam so graceful windows do not stall unit tests. */
const instantWait = async (): Promise<void> => undefined

describe('killZcodeProcessTree', () => {
  beforeEach(() => {
    resetSelfInitiatedTreeKillLogForTest()
  })

  it('waits for the Windows tree kill before releasing the wrapper', async () => {
    const target = child()
    const release = Promise.withResolvers<void>()
    const terminateWindowsTree = vi.fn(() => release.promise)

    const teardown = killZcodeProcessTree(target, {
      platform: 'win32',
      terminateWindowsTree,
      wait: instantWait
    })
    expect(target.kill).not.toHaveBeenCalled()
    release.resolve()
    await teardown

    expect(terminateWindowsTree).toHaveBeenCalledWith(1234, { site: 'zcode-app-server-teardown' })
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('sweeps the pre-signal snapshot when the root exits on SIGTERM', async () => {
    const target = child()
    const snapshot = { rootPgid: 1234, descendants: [descendantRow(2345)], capturedAtMs: 1 }
    const terminateDescendants = vi.fn(async () => true)

    await expect(
      killZcodeProcessTree(target, {
        platform: 'darwin',
        afterMs: 10,
        isPidPresent: () => false,
        captureDescendants: async () => snapshot,
        terminateDescendants,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(target.kill.mock.calls).toEqual([['SIGTERM']])
    expect(terminateDescendants).toHaveBeenCalledWith(snapshot)
  })

  it('waits for an owned POSIX snapshot before killing the wrapper', async () => {
    const target = child()
    const snapshot = { rootPgid: 1234, descendants: [], capturedAtMs: 1 }
    const freshWalk = Promise.withResolvers<typeof snapshot | null>()

    const teardown = killZcodeProcessTree(target, {
      platform: 'darwin',
      afterMs: 10,
      isPidPresent: () => true,
      captureDescendants: vi
        .fn<() => Promise<typeof snapshot | null>>()
        .mockResolvedValueOnce(snapshot)
        .mockReturnValueOnce(freshWalk.promise),
      terminateDescendants: async () => true,
      wait: instantWait
    })
    await vi.waitFor(() => expect(target.kill).toHaveBeenCalledWith('SIGSTOP'))
    expect(target.kill).not.toHaveBeenCalledWith('SIGKILL')
    freshWalk.resolve(snapshot)
    await teardown

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('falls back to the pre-signal snapshot when the root dies during the grace window', async () => {
    const target = child()
    const preSignal = { rootPgid: 1234, descendants: [descendantRow(2345)], capturedAtMs: 1 }
    const rootlessCapture = { rootPgid: null, descendants: [], capturedAtMs: 2 }
    const terminateDescendants = vi.fn(async () => true)

    await expect(
      killZcodeProcessTree(target, {
        platform: 'darwin',
        afterMs: 10,
        // The exit event has not been observed yet, but the table lost the root.
        hasExited: () => false,
        captureDescendants: vi
          .fn<() => Promise<typeof preSignal | typeof rootlessCapture>>()
          .mockResolvedValueOnce(preSignal)
          .mockResolvedValueOnce(rootlessCapture),
        terminateDescendants,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(terminateDescendants).toHaveBeenCalledWith(preSignal)
    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('never group-signals a root that does not lead its own process group', async () => {
    const target = child()
    const signalProcessGroup = vi.fn()

    await expect(
      killZcodeProcessTree(target, {
        platform: 'darwin',
        afterMs: 10,
        isPidPresent: () => true,
        captureDescendants: async () => ({ rootPgid: 999, descendants: [], capturedAtMs: 1 }),
        terminateDescendants: async () => true,
        signalProcessGroup,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('claims a snapshot group the signal actually reached', async () => {
    const target = child()
    const signalProcessGroup = vi.fn()

    await expect(
      killZcodeProcessTree(target, {
        platform: 'darwin',
        afterMs: 10,
        isPidPresent: () => true,
        captureDescendants: async () => ({ rootPgid: 1234, descendants: [], capturedAtMs: 1 }),
        terminateDescendants: async () => true,
        signalProcessGroup,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(signalProcessGroup).toHaveBeenCalledWith(1234, 'SIGKILL')
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
      expect.objectContaining({
        pid: 1234,
        site: 'zcode-app-server-teardown',
        scope: 'posix-process-group'
      })
    ])
  })

  it('reports an unproven sweep even though the root was force-killed', async () => {
    const target = child()

    await expect(
      killZcodeProcessTree(target, {
        platform: 'linux',
        afterMs: 10,
        isPidPresent: () => true,
        captureDescendants: async () => ({ rootPgid: 1234, descendants: [], capturedAtMs: 1 }),
        terminateDescendants: async () => false,
        wait: instantWait
      })
    ).resolves.toBe(false)

    // The grace expired, so the root dies before the sweep — an unprovable
    // descendant verdict must not soften that.
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
    expect(target.kill).not.toHaveBeenCalledWith('SIGCONT')
  })

  it('kills exact Linux spawn-token PIDs before the recorded wrapper', async () => {
    const target = child()
    const findSpawnTokenProcesses = vi
      .fn<() => Promise<number[] | null>>()
      .mockResolvedValueOnce([1234, 2345, 3456])
    const signalPid = vi.fn()

    await expect(
      killZcodeProcessTree(target, {
        platform: 'linux',
        spawnToken: 'spawn-1',
        findSpawnTokenProcesses,
        signalPid,
        isPidPresent: () => false,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(signalPid.mock.calls).toEqual([
      [2345, 'SIGKILL'],
      [3456, 'SIGKILL']
    ])
    expect(target.kill).toHaveBeenCalledTimes(1)
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('keeps the wrapper reachable when the spawn-token scan cannot enumerate', async () => {
    const target = child()

    await expect(
      killZcodeProcessTree(target, {
        platform: 'linux',
        spawnToken: 'spawn-1',
        findSpawnTokenProcesses: async () => null
      })
    ).resolves.toBe(false)

    expect(target.kill).not.toHaveBeenCalled()
  })

  it('dedupes concurrent teardowns of one child', async () => {
    const target = child()
    const snapshot = { rootPgid: 1234, descendants: [], capturedAtMs: 1 }
    const captureDescendants = vi.fn(async () => snapshot)
    const release = Promise.withResolvers<boolean>()
    const options = {
      platform: 'darwin' as const,
      afterMs: 10,
      isPidPresent: () => true,
      captureDescendants,
      terminateDescendants: () => release.promise,
      wait: instantWait
    }

    const first = killZcodeProcessTree(target, options)
    const second = killZcodeProcessTree(target, options)
    expect(second).toBe(first)
    release.resolve(true)
    await expect(first).resolves.toBe(true)

    // One attempt captures twice by design (pre-signal + forced phase); a
    // second interleaved teardown would double that.
    expect(captureDescendants).toHaveBeenCalledTimes(2)
  })

  /**
   * `selfInitiatedTreeKillCount` decides whether a `render-process-gone` was
   * ours. A group that had already exited was killed by nobody, so crediting it
   * puts a suspect in the five-second window that Orca never issued. Exercised
   * through the real `process.kill(-pgid)` because the swallow being tested
   * lives in the production default, not in an injectable seam.
   */
  it('does not claim a snapshot group that was already gone', async () => {
    const target = { pid: UNREACHABLE_PGID, kill: vi.fn(() => true) }

    await expect(
      killZcodeProcessTree(target, {
        platform: 'darwin',
        afterMs: 10,
        isPidPresent: () => true,
        captureDescendants: async () => ({
          rootPgid: UNREACHABLE_PGID,
          descendants: [],
          capturedAtMs: 1
        }),
        terminateDescendants: async () => true,
        wait: instantWait
      })
    ).resolves.toBe(true)

    expect(target.kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])
  })
})

const RESISTANT_TREE_ROOT = String.raw`
  const { spawn } = require('node:child_process')
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
    stdio: 'ignore'
  })
  process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\n')
  setInterval(() => {}, 60000)
`

const RESISTANT_ZCODE_SERVER = String.raw`
  const { spawn } = require('node:child_process')
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
    stdio: 'ignore'
  })
  send({ method: 'startup/storageState', params: { phase: 'ready', attemptId: 'a1', sequence: 1 } })
  send({ method: 'test/descendant', params: { pid: grandchild.pid } })
  setInterval(() => {}, 60000)
`

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe.runIf(process.platform !== 'win32')('killZcodeProcessTree real processes', () => {
  it('reaps a SIGTERM-resistant root and its grandchild', async () => {
    const root = spawnProcess({ program: process.execPath, args: ['-e', RESISTANT_TREE_ROOT] })
    const rootPid = root.pid ?? 0
    const grandchildPid = await new Promise<number>((resolve) => {
      let buffered = ''
      root.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffered += chunk
        const newline = buffered.indexOf('\n')
        if (newline !== -1) {
          const reported: { grandchildPid?: unknown } = JSON.parse(buffered.slice(0, newline))
          if (typeof reported.grandchildPid === 'number') {
            resolve(reported.grandchildPid)
          }
        }
      })
    })
    // The descendant sweep only escalates identities born before the capture
    // second, so let the grandchild clear ps lstart's one-second resolution.
    await sleep(1_200)
    const exit = new Promise<void>((resolve) => root.on('exit', () => resolve()))

    await expect(
      killZcodeProcessTree(root, {
        afterMs: 150,
        exitPromise: exit,
        hasExited: () => root.exitCode !== null || root.signalCode !== null
      })
    ).resolves.toBe(true)

    expect(processExists(rootPid)).toBe(false)
    expect(processExists(grandchildPid)).toBe(false)
  }, 20_000)

  it('connection close() reaps the resistant descendant tree', async () => {
    const descendant = Promise.withResolvers<number>()
    const connection = await openZcodeAppServerConnection(
      { command: process.execPath, args: ['-e', RESISTANT_ZCODE_SERVER] },
      {
        onNotification: (method, params) => {
          if (
            method === 'test/descendant' &&
            typeof params === 'object' &&
            params !== null &&
            'pid' in params &&
            typeof params.pid === 'number'
          ) {
            descendant.resolve(params.pid)
          }
        }
      }
    )
    const rootPid = connection.pid ?? 0
    const descendantPid = await descendant.promise

    await expect(connection.close()).resolves.toBe(true)

    expect(processExists(rootPid)).toBe(false)
    expect(processExists(descendantPid)).toBe(false)
  }, 20_000)
})
