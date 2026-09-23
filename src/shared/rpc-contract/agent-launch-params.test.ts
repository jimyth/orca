/**
 * The wire shape of the launch inputs a host cannot derive.
 *
 * Params are validated by the HOST, which makes every closed arm set here a refusal a future client
 * walks into. `launchSource` is the case that matters: it is a telemetry label, and a host that
 * rejected an unfamiliar one would fail the user's launch over bookkeeping.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../protocol-version'
import { AgentLaunch } from './agent-launch-params'

const BASE = { agent: 'claude', target: { kind: 'existing', worktree: 'wt-1' } }

describe('agent.launch params', () => {
  it('keeps agentArgs tri-state: a string, an explicit null, and absent are three answers', () => {
    expect(AgentLaunch.parse({ ...BASE, agentArgs: '--model opus' }).agentArgs).toBe('--model opus')
    expect(AgentLaunch.parse({ ...BASE, agentArgs: null }).agentArgs).toBeNull()
    expect(AgentLaunch.parse(BASE)).not.toHaveProperty('agentArgs')
  })

  it('strips a presentation smuggled into the create payload', () => {
    // A sibling of `create`, so `worktree.create` callers cannot ask for it.
    const create = { repo: 'id:repo-1', name: 'task', presentation: 'background' }
    const parsed = AgentLaunch.parse({ ...BASE, target: { kind: 'create-worktree', create } })
    if (parsed.target.kind !== 'create-worktree') {
      throw new Error('expected a create-worktree target')
    }
    expect(parsed.target.create).not.toHaveProperty('presentation')
    expect(parsed.target.create).not.toHaveProperty('startupPresentation')
  })

  it('accepts a cwd and rejects an empty one', () => {
    expect(AgentLaunch.parse({ ...BASE, cwd: '/repo/packages/api' }).cwd).toBe('/repo/packages/api')
    expect(AgentLaunch.safeParse({ ...BASE, cwd: '' }).success).toBe(false)
  })

  it('accepts a launchSource this build has never heard of', () => {
    // The arm set is open ON PURPOSE. A newer client naming a surface this host predates must still
    // get its agent started; the label is re-checked where it is used and dropped if unknown.
    const parsed = AgentLaunch.safeParse({ ...BASE, launchSource: 'a_surface_added_later' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.launchSource).toBe('a_surface_added_later')
  })

  it('accepts the one arm this method can honour', () => {
    expect(AgentLaunch.parse({ ...BASE, presentation: 'background' }).presentation).toBe(
      'background'
    )
  })

  it('refuses `focused`, which the sibling methods take and this one cannot honour', () => {
    expect(AgentLaunch.safeParse({ ...BASE, presentation: 'focused' }).success).toBe(false)
  })

  it('leaves presentation absent rather than defaulting it', () => {
    // Absent must not read as `background`: every shipped caller relies on the reveal.
    expect(AgentLaunch.parse(BASE)).not.toHaveProperty('presentation')
  })

  it('refuses a presentation it has never heard of', () => {
    expect(AgentLaunch.safeParse({ ...BASE, presentation: 'hidden' }).success).toBe(false)
  })

  it('still parses a payload from a client that sends none of these fields', () => {
    // Rule 1: the fields are optional, so a shipped client that predates them is unaffected.
    const parsed = AgentLaunch.parse(BASE)
    expect(parsed).not.toHaveProperty('cwd')
    expect(parsed).not.toHaveProperty('launchSource')
    expect(parsed).not.toHaveProperty('presentation')
  })
})

describe('the opt-out a caller has to negotiate first', () => {
  it('uses the id a caller codes against', () => {
    expect(AGENT_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY).toBe('agent.launch.presentation.v1')
  })

  it('is advertised by every host that honours the field', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_LAUNCH_PRESENTATION_RUNTIME_CAPABILITY)
  })
})
