/**
 * The wire shape of `agent.launch`, mirroring `AgentLaunchIntent`.
 *
 * A caller states WHERE the agent lands and WHAT it should say; it never names a mode. There is
 * deliberately no `structured` / `terminal` field and no startup-agent field on the create
 * payload — the host decides, and `withoutReservedAgentCreateFields` strips a stale one out of a
 * payload a caller migrated over from `worktree.create`.
 *
 * Shared rather than main-side because every field resolves to a shared schema: a remote client
 * that sends this method needs `RpcSendParams<'agent.launch'>` to exist, and a method missing from
 * the catalog can only be sent through the raw request port.
 */

import { z } from 'zod'
import { parseAgentSessionOperationTimestamp } from '../agent-session-host-authority'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import { WorktreeCreate } from './worktree-create-params'

const LaunchAgent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (!isTuiAgent(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown TUI agent' })
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the superRefine above rejects anything isTuiAgent refuses, so the transform only ever runs on a TuiAgent.
  .transform((value): TuiAgent => value as TuiAgent)

export const AgentLaunch = z.object({
  agent: LaunchAgent,
  /**
   * Names this launch so a retry replays instead of starting a second agent.
   *
   * Optional, and optional forever: shipped mobile sends none, and a host that required one would
   * refuse every live client. Its absence is not a silent downgrade to a weaker guarantee — it is
   * the caller declining the guarantee, and the host must never mint an id on a caller's behalf
   * after an ambiguous launch, because an id minted on the retry is a brand new operation.
   */
  operationId: z
    .string()
    .refine(
      (value) => parseAgentSessionOperationTimestamp(value) !== null,
      'Malformed launch operation id'
    )
    .optional(),
  target: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('existing'),
      /** Any selector the runtime resolves, the same as every other worktree-addressed method. */
      worktree: z.string().min(1, 'Missing worktree selector')
    }),
    z.object({
      kind: z.literal('create-worktree'),
      /** The `worktree.create` request verbatim, so a caller migrating to this method keeps its
       *  existing payload; the agent fields in it are stripped rather than honoured. */
      create: WorktreeCreate
    })
  ]),
  prompt: z
    .object({
      text: z.string(),
      delivery: z.enum(['submit', 'draft'])
    })
    .optional(),
  /** Only the seedable string options a structured create accepts; a terminal launch ignores them. */
  sessionOptions: z.record(z.string(), z.string()).optional(),
  reuseTerminal: z.object({ handle: z.string().min(1, 'Missing terminal handle') }).optional(),
  /** Nullable on purpose: `null` is "no arguments", absent is "use the settings default". */
  agentArgs: z.string().nullable().optional(),
  /** A start directory other than the workspace root. Terminal-only, and the host downgrades a
   *  structured launch that carries one rather than ignoring it. */
  cwd: z.string().min(1, 'Empty launch cwd').optional(),
  /**
   * Telemetry attribution, deliberately `z.string()` rather than the closed `launchSourceSchema`.
   *
   * Params are validated by the HOST, so a closed enum here is a version claim pointing the wrong
   * way: a newer client naming a launch surface an older host has never heard of would have its
   * whole launch refused over a label nothing reads as behaviour. Bookkeeping must not gate a user
   * action, so the arm set stays open here and the host parses it leniently at the point it is
   * actually used — the same `safeParse`-and-skip the PTY spawn already does.
   */
  launchSource: z.string().optional(),
  /**
   * Who presents the surface this launch creates — never where it goes. `background` means the
   * caller draws the tab itself from the `paneKey` the outcome reports, so the host skips its
   * reveal. Absent is NOT `background`: it keeps the reveal every shipped caller relies on.
   *
   * One arm, deliberately narrower than the `background | focused` its siblings take. On this
   * method `focused` flips the routing at orca-runtime-create-terminal.ts:18-25 onto the
   * renderer-backed create, which reports no `paneKey` — the field this feature is built on — and
   * forwards no `telemetry`, so `agent_started` never fires. A literal rather than a one-member
   * enum so widening cannot be a one-word append.
   *
   * WIDENING THIS ARM SET REINTRODUCES BOTH DEFECTS, and this schema is the only guard: unlike
   * `terminal.create` and `agentSession.create` there is no authority clamp behind it, so a second
   * arm is immediately reachable by a remote caller. Fix that routing first.
   *
   * A caller must read `AGENT_LAUNCH_SURFACE_OWNERSHIP_RUNTIME_CAPABILITY` before relying on the
   * opt-out: an older host strips this key and reveals anyway, which is the second tab it exists
   * to prevent.
   *
   * Placement stays off this wire: no group, anchor, order, focus target or navigation. Terminal
   * surfaces only — a structured launch's tab is published by the host, and the caller learns
   * which surface it got from `outcome.kind`.
   */
  presentation: z.literal('background').optional()
})

export type AgentLaunchParams = z.infer<typeof AgentLaunch>

// A distinct method prevents an older receiver from silently dropping the replay requirement.
export const AgentLaunchReplay = AgentLaunch.required({ operationId: true })
