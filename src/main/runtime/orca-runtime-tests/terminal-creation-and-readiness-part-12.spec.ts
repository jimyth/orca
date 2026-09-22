import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

function runtimeWithDesktopWindow() {
  const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-revealed' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-launch' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession,
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, revealTerminalSession }
}

describe('OrcaRuntimeService', () => {
  it('bounds retained work for many newline-separated huge ANSI cursor movements', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b[4000GZ\n'.repeat(3000), 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2000 })
    expect(read.latestCursor).toBe('3000')
    expect(read.oldestCursor).not.toBe('0')
    expect(read.tail.length).toBeLessThan(100)
    for (const line of read.tail) {
      expect(line.length).toBeLessThanOrEqual(4000)
      expect(line.endsWith('Z')).toBe(true)
      expect(line).not.toContain('4000G')
    }
  })

  it('applies ANSI erase-from-start line controls in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[3D\x1b[1KXY\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['  XYE'])
    expect(read.tail.join('\n')).not.toContain('ABC')
    expect(read.tail.join('\n')).not.toContain('1K')
  })

  it('applies ANSI stripping for private or intermediate CSI line controls', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[?99DXY\n', 100)
    runtime.onPtyData('pty-1', 'ABCDE\x1b[1$DXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['ABCDEXY', 'ABCDEXY'])
    expect(read.tail.join('\n')).not.toContain('?99D')
    expect(read.tail.join('\n')).not.toContain('1$D')
  })

  it('applies ANSI stripping for unsupported erase-line modes', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Old\x1b[3KNew\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['OldNew'])
    expect(read.tail.join('\n')).not.toContain('3K')
  })

  it('does not retain split ST-terminated string controls as preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Before \x1b_Gi=31337,s=1,', 100)
    runtime.onPtyData('pty-1', 'v=1,a=q,t=d,f=24;AAAA\x1b\\After\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('BeforeAfter')
    expect(retained).not.toContain('Gi=31337')
    expect(retained).not.toContain('AAAA')
  })

  // The gate agent.launch's `presentation: 'background'` lands on; its RPC tests stop at the mock.
  it('reveals an agent terminal to a desktop window by default', async () => {
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow()

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude'
    })

    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ ptyId: 'pty-launch', tabId: created.tabId })
    )
    expect(created.surface).toBe('visible')
  })

  it('skips the reveal for a background agent terminal and still names its pane', async () => {
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow()

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      presentation: 'background'
    })

    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(created.surface).toBe('background')
    // A caller that suppressed the reveal draws the tab itself, so it must learn which pane.
    expect(created.paneKey?.startsWith(`${created.tabId}:`)).toBe(true)
  })
})
