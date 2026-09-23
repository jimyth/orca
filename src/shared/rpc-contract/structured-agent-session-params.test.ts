/**
 * The zcode arms of the `agentSession.*` create lane.
 *
 * Params are validated by the HOST, so a closed enum here is a refusal every zcode client walks
 * into before any adapter runs. The widened arms are exactly the create surface: intent, support,
 * and the attach provider tag. `ProviderHandle` stays claude/codex on purpose — a client-supplied
 * zcode handle names a conversation this host cannot resume yet (the adapter creates and mints the
 * durable identity itself), so that union stays closed until resume lands.
 */

import { describe, expect, it } from 'vitest'
import {
  AccountHome,
  AttachParams,
  CreateIntentParams,
  CreateSupportParams
} from './structured-agent-session-params'

const ENVELOPE = {
  sessionId: 'session-1',
  clientOperationId: 'op-1',
  expectedRuntimeFence: null,
  payloadFingerprint: 'a'.repeat(64)
}

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree' as const
}

describe('structured agent-session params zcode arms', () => {
  it('accepts zcode on a create intent', () => {
    expect(
      CreateIntentParams.safeParse({
        envelope: ENVELOPE,
        worktree: 'id:workspace-1',
        agent: 'zcode'
      }).success
    ).toBe(true)
  })

  it('accepts zcode on a create-support probe', () => {
    expect(
      CreateSupportParams.safeParse({ worktree: 'id:workspace-1', agent: 'zcode' }).success
    ).toBe(true)
  })

  it('accepts zcode as the attach provider tag', () => {
    const parsed = AttachParams.safeParse({
      envelope: ENVELOPE,
      location: LOCATION,
      provider: 'zcode',
      agent: 'zcode',
      accountHome: { variable: 'ZCODE_HOME', path: '/home/dev/.zcode' },
      runtimeKind: 'native',
      providerHandle: { kind: 'claude', sessionId: 'provider-session-1', leafUuid: null }
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.provider).toBe('zcode')
  })

  it('accepts ZCODE_HOME as an account-home variable', () => {
    expect(
      AccountHome.safeParse({ variable: 'ZCODE_HOME', path: '/home/dev/.zcode' }).success
    ).toBe(true)
  })

  it('keeps the client-supplied provider handle union closed to claude and codex', () => {
    expect(
      AttachParams.safeParse({
        envelope: ENVELOPE,
        location: LOCATION,
        provider: 'zcode',
        agent: 'zcode',
        accountHome: { variable: 'ZCODE_HOME', path: '/home/dev/.zcode' },
        runtimeKind: 'native',
        providerHandle: { kind: 'zcode', sessionId: 'provider-session-1' }
      }).success
    ).toBe(false)
  })
})
