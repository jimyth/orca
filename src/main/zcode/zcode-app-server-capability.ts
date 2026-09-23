import { CapabilityProbeCache } from '../../shared/capability-probe-cache'
import { isZcodeAppServerMethodNotFoundError } from './zcode-protocol'

// Why: suppress a known-missing app-server surface without pinning it forever —
// an in-place zcode upgrade during a long Orca session self-heals after the
// interval, mirroring GitCapabilityCache's rationale.
export const ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000
export const ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES = 256

/** Execution host that runs the zcode binary. WSL distros are isolated from
 *  the native host and from each other — each can carry a different zcode. */
export type ZcodeAppServerHostKey = 'native' | `wsl:${string}`

export function getZcodeAppServerHostKey(
  host: { kind: 'native' } | { kind: 'wsl'; distro: string }
): ZcodeAppServerHostKey {
  return host.kind === 'wsl' ? `wsl:${host.distro}` : 'native'
}

/** The only absence signal the capability cache may remember: the spawn itself
 *  failed, `zcode app-server` is an unknown subcommand, or the server answered
 *  -32601. Anything else is transient and must not pin the host. */
export class ZcodeAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerUnsupportedError'
  }
}

export function isZcodeAppServerUnsupportedError(error: unknown): boolean {
  // The -32601 arm also matches ZcodeAppServerRequestError, whose numeric code
  // IS the wire error code.
  return (
    error instanceof ZcodeAppServerUnsupportedError || isZcodeAppServerMethodNotFoundError(error)
  )
}

/**
 * Capability cache for the zcode app-server surface. Concurrent launches can
 * probe the same cold host at once; the shared probe dedupe keeps that to one
 * app-server session instead of one per caller.
 */
export class ZcodeAppServerCapabilityCache extends CapabilityProbeCache<ZcodeAppServerHostKey> {
  constructor() {
    super(ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS, ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES)
  }
}

/** Deliberately unwired (FU): codex consumes its cache where a fallback lane
 *  exists (hook trust grant → legacy TOML lane); the zcode structured session
 *  is the only lane, so a 30-min pin would turn a retryable launch failure
 *  into a hard refusal with no consumer to soften it. Wire it into acquire
 *  once zcode gains a fallback lane or a provider-availability surface. */
export const zcodeAppServerCapabilityCache = new ZcodeAppServerCapabilityCache()
