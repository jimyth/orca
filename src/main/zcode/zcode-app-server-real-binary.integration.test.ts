// Real-binary contract test: drives a built `zcode.cjs app-server --stdio`
// through openZcodeAppServerConnection exactly the way production does. The
// ZCode protocol has no stability promise, so every wire assumption baked into
// zcode-protocol.ts / the connection / the acquire path is re-proved here
// against the actual server. Skipped unless ZCODE_BIN names a built binary and
// the machine carries the credentials the server needs — this suite is the
// standing safety net, never a required gate.
//
// Provider bootstrap (empirically confirmed 2026-09-23): the app-server
// registry loads only builtin templates plus the personal file
// ~/.zcode/v2/provider_config.json. The OAuth `account:*` providers need a
// host-mode `provider/updateAccountConfig` push this stdio client never sends,
// so beforeAll temporarily installs an api-key rule for the `bigmodel-api`
// template (key read from ~/.zcode/cli/config.json, the same key the CLI uses)
// and afterAll restores the original file byte-for-byte. Do not run anything
// else that reads the personal provider file while this suite runs.

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  openZcodeAppServerConnection,
  type ZcodeAppServerConnection
} from './zcode-app-server-connection'
import {
  ZCODE_NOTIFICATION_METHODS,
  zcodeSessionIdFromCreateResult,
  type ZcodeSessionSendParams
} from './zcode-protocol'
import {
  defaultZcodeModelSelection,
  readZcodeModelSelectionEcho
} from './zcode-structured-session-acquire'
import {
  disposeZcodeServerRequest,
  zcodeRuntimePreferencesResponse
} from './zcode-server-request-disposition'

const zcodeBin = process.env.ZCODE_BIN ?? ''
const personalProviderConfigPath = join(homedir(), '.zcode', 'v2', 'provider_config.json')
const cliConfigPath = join(homedir(), '.zcode', 'cli', 'config.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** The key the zcode CLI itself uses for the bigmodel coding plan — the same
 * secret, read from the same file, never logged. */
function readBigmodelApiKey(): string | null {
  if (!existsSync(cliConfigPath)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(cliConfigPath, 'utf8'))
  } catch {
    return null
  }
  const entry = isRecord(parsed) ? parsed.provider : undefined
  const bigmodel = isRecord(entry) ? entry['builtin:bigmodel'] : undefined
  const options = isRecord(bigmodel) ? bigmodel.options : undefined
  const apiKey = isRecord(options) ? options.apiKey : undefined
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null
}

const apiKey = readBigmodelApiKey()
const suiteRunnable =
  zcodeBin !== '' &&
  existsSync(zcodeBin) &&
  existsSync(personalProviderConfigPath) &&
  apiKey !== null

// The connection itself kills a server that stays frame-silent for 30s, so the
// ready budget doubles as the contract: storage readiness is a startup property.
const STORAGE_READY_BUDGET_MS = 30_000
const TURN_BUDGET_MS = 90_000
const REQUEST_TIMEOUT_MS = 60_000

function readEventPhase(params: unknown): string {
  return isRecord(params) && typeof params.phase === 'string' ? params.phase : 'unknown'
}

function readEventType(params: unknown): string {
  return isRecord(params) && typeof params.type === 'string' ? params.type : 'unknown'
}

function readSendAccepted(result: unknown): boolean {
  return isRecord(result) && result.accepted === true
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
        timeoutMs
      ).unref()
    })
  ])
}

describe.skipIf(!suiteRunnable)('zcode app-server (real binary)', () => {
  const harness: {
    connection?: ZcodeAppServerConnection
    workspacePath?: string
    spawnAtMs: number
    readyAfterMs: number | null
    createResult: unknown
    providerSessionId: string | null
    modelSelection: ZcodeSessionSendParams['modelSelection'] | null
    storagePhases: string[]
    eventTypes: string[]
    serverRequestMethods: string[]
  } = {
    spawnAtMs: 0,
    readyAfterMs: null,
    createResult: undefined,
    providerSessionId: null,
    modelSelection: null,
    storagePhases: [],
    eventTypes: [],
    serverRequestMethods: []
  }
  let signalStorageReady: () => void = () => {}
  const storageReady = new Promise<void>((resolve) => {
    signalStorageReady = resolve
  })
  let signalTurnSettled: () => void = () => {}
  const turnSettled = new Promise<void>((resolve) => {
    signalTurnSettled = resolve
  })

  /** The one connection every case shares: contract cases are ordered facts
   * about one live server, not independent scenarios. */
  function server(): ZcodeAppServerConnection {
    if (harness.connection === undefined) {
      throw new Error('beforeAll did not start the real zcode app-server')
    }
    return harness.connection
  }

  beforeAll(async () => {
    harness.workspacePath = await mkdtemp(join(tmpdir(), 'orca-zcode-contract-'))
    // Spike-equivalent personal provider: the template carries baseUrl and the
    // GLM model list; the personal rule only pins the key.
    copyFileSync(personalProviderConfigPath, `${personalProviderConfigPath}.orca-contract-bak`)
    await writeFile(
      personalProviderConfigPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: 'bigmodel-api',
                  templateId: 'bigmodel-api',
                  config: { group: 'standard-personal', access: { type: 'api-key', apiKey } }
                }
              ]
            },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            defaultModelSelection: {
              providerId: 'bigmodel-api',
              modelId: 'GLM-5.3',
              options: { reasoningLevel: 'max' }
            }
          }
        },
        null,
        1
      )}\n`
    )
    harness.spawnAtMs = Date.now()
    harness.connection = await openZcodeAppServerConnection(
      {
        command: zcodeBin,
        args: ['app-server', '--stdio'],
        cwd: harness.workspacePath,
        // zcode.cjs's shebang resolves `node` from PATH; pin vitest's own node
        // so the server runs under the runtime that launched this test.
        env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` }
      },
      {
        onNotification: (method, params) => {
          if (method === ZCODE_NOTIFICATION_METHODS.storageState) {
            const phase = readEventPhase(params)
            harness.storagePhases.push(phase)
            if (phase === 'ready' && harness.readyAfterMs === null) {
              harness.readyAfterMs = Date.now() - harness.spawnAtMs
              signalStorageReady()
            }
            return
          }
          if (method === ZCODE_NOTIFICATION_METHODS.sessionEvent) {
            const type = readEventType(params)
            harness.eventTypes.push(type)
            if (type === 'turn.completed' || type === 'turn.failed') {
              signalTurnSettled()
            }
          }
        },
        onServerRequest: (request) => {
          harness.serverRequestMethods.push(request.method)
          const disposition = disposeZcodeServerRequest(request)
          if (disposition.kind === 'runtime-preferences') {
            // Unanswered, session/create aborts with -32022 after 15s — the
            // contract test replies through the same helper production uses.
            server().respond(request.id, zcodeRuntimePreferencesResponse())
            return
          }
          if (disposition.kind === 'permission-prompt') {
            server().respond(request.id, { decision: 'allow' })
            return
          }
          server().respondWithError(request.id, -32601, 'contract test does not answer')
        }
      }
    )
  }, 60_000)

  afterAll(async () => {
    await harness.connection?.close().catch(() => false)
    if (existsSync(`${personalProviderConfigPath}.orca-contract-bak`)) {
      // Restore before the temp workspace goes: an app-server polling the
      // personal file must not observe the test provider past this suite.
      copyFileSync(`${personalProviderConfigPath}.orca-contract-bak`, personalProviderConfigPath)
      await rm(`${personalProviderConfigPath}.orca-contract-bak`, { force: true }).catch(
        () => undefined
      )
    }
    if (harness.workspacePath !== undefined) {
      await rm(harness.workspacePath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  it(
    'reaches storageState ready within 30s of spawn',
    async () => {
      await withTimeout(
        storageReady,
        `storageState ready (phases seen: ${harness.storagePhases.join(',') || 'none'})`,
        STORAGE_READY_BUDGET_MS + 5_000
      )
      expect(harness.readyAfterMs ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(
        STORAGE_READY_BUDGET_MS
      )
    },
    STORAGE_READY_BUDGET_MS + 15_000
  )

  it(
    'session/create names a session and echoes the live model selection',
    async () => {
      harness.createResult = await server().request(
        'session/create',
        {
          workspace: {
            workspacePath: harness.workspacePath,
            workspaceKey: 'orca-contract-test'
          }
        },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
      harness.providerSessionId = zcodeSessionIdFromCreateResult(harness.createResult)
      expect(harness.providerSessionId).not.toBeNull()
      // The echo is the primary model source for production session/send — its
      // presence in a real create result is itself part of the contract.
      harness.modelSelection = readZcodeModelSelectionEcho(harness.createResult)
      expect(harness.modelSelection).not.toBeNull()
      expect(harness.serverRequestMethods).toContain('session/requestRuntimePreferences')
    },
    REQUEST_TIMEOUT_MS + 30_000
  )

  it(
    'streams session/event through turn.completed for a send',
    async () => {
      const sessionId = harness.providerSessionId
      if (sessionId === null) {
        throw new Error('session/create case did not run first')
      }
      await server().request(
        'session/subscribe',
        { sessionId, deliveryKind: 'desktop-continuous' },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
      const sendResult = await server().request(
        'session/send',
        {
          sessionId,
          content: 'reply with exactly: ok',
          modelSelection: harness.modelSelection ?? defaultZcodeModelSelection()
        },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
      expect(readSendAccepted(sendResult)).toBe(true)
      await withTimeout(
        turnSettled,
        `turn settlement (events seen: ${harness.eventTypes.join(',') || 'none'})`,
        TURN_BUDGET_MS
      )
      expect(harness.eventTypes).toContain('turn.completed')
      expect(harness.eventTypes).not.toContain('turn.failed')
      expect(harness.eventTypes.length).toBeGreaterThan(1)
    },
    TURN_BUDGET_MS + 30_000
  )

  it('close resolves true once the real child has exited', async () => {
    const pid = server().pid
    if (pid === undefined) {
      throw new Error('real zcode app-server spawned without a pid')
    }
    await expect(server().close()).resolves.toBe(true)
    expect(server().closed).toBe(true)
    // No orphaned app-server in the process table: the pid the spawn owned
    // is gone (node reaps before the exit event that close() waits on).
    expect(() => process.kill(pid, 0)).toThrow()
  }, 30_000)
})
