// The gap between spawning `zcode app-server` and publishing the session it
// belongs to. ZCode talks during that gap — storageState chatter, an early
// session event, even a permission request the CLI fires before session/create
// resolves — and those frames belong to the session still being acquired, so
// they wait here instead of arriving before anything can route them. Mirrors
// the codex acquisition window; the gap is bounded so a provider cannot pin
// closures, and a failed acquisition discards the buffer along with the child.

import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import { ZcodePromptRegistry } from './zcode-prompt-registry'

/** Pre-publication buffering is bounded so a provider cannot pin closures. */
export const MAX_ZCODE_ACQUISITION_BUFFER_OPERATIONS = 1024
export const MAX_ZCODE_ACQUISITION_BUFFER_BYTES = 4 * 1024 * 1024

export class ZcodeAcquisitionWindow {
  readonly prompts = new ZcodePromptRegistry()
  /** Null until the spawn resolves; the CLI can already emit frames. */
  connection: ZcodeAppServerConnection | null = null
  private readonly buffered: (() => void)[] = []
  private retainedBytes = 0
  private open = true
  private overflowed = false

  get isOverflowed(): boolean {
    return this.overflowed
  }

  /** Returns false once the session is published, which is the caller's cue to
   *  deliver live rather than buffer. */
  buffer(event: () => void, retainedBytes = 256): boolean {
    if (!this.open) {
      return false
    }
    const bytes = Number.isFinite(retainedBytes) && retainedBytes > 0 ? Math.ceil(retainedBytes) : 1
    if (
      this.buffered.length >= MAX_ZCODE_ACQUISITION_BUFFER_OPERATIONS ||
      this.retainedBytes + bytes > MAX_ZCODE_ACQUISITION_BUFFER_BYTES
    ) {
      // Refuse the acquisition rather than dropping an event and continuing.
      this.overflowed = true
      this.open = false
      this.buffered.length = 0
      this.retainedBytes = 0
      return false
    }
    this.buffered.push(event)
    this.retainedBytes += bytes
    return true
  }

  /** Closes the window and hands back what arrived while it was open, in order. */
  drain(): (() => void)[] {
    this.open = false
    this.retainedBytes = 0
    return this.buffered.splice(0)
  }
}
