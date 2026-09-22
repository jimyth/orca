// LF-only stdout framing for the zcode app-server connection. The shared
// NDJSON framer only splits (indexOf('\n')); classification belongs to Task 3's
// protocol parser, and a line it cannot classify is fatal — upstream client
// semantics, unlike the codex connection which keeps such lines non-fatal.

import type { Readable } from 'node:stream'
import {
  createIncrementalNdjsonFramer,
  type NdjsonRejectedRecord
} from '../../shared/main-process-ndjson-framer'
import { ZcodeAppServerProtocolError } from './zcode-app-server-connection-errors'
import { parseZcodeProtocolFrame, type ZcodeProtocolFrame } from './zcode-protocol'

const FRAME_DETAIL_MAX_CHARS = 400

type ReaderStream = Pick<Readable, 'on' | 'pause' | 'resume' | 'setEncoding'>

export type ZcodeFrameReader = {
  pause: () => void
  resume: () => void
}

export function createZcodeFrameReader(input: {
  stdout: ReaderStream
  onFrame: (frame: ZcodeProtocolFrame) => void
  onFatal: (error: Error) => void
  /** Frames arriving after this returns true are dropped, not dispatched. */
  isDead: () => boolean
}): ZcodeFrameReader {
  let paused = false

  function failParse(detail: string): void {
    input.onFatal(new ZcodeAppServerProtocolError(`protocol_parse_error: ${detail}`))
  }

  const framer = createIncrementalNdjsonFramer(
    (_record: unknown, line: string) => {
      if (input.isDead()) {
        return
      }
      const frame = parseZcodeProtocolFrame(line)
      if (frame === null) {
        failParse(`unclassifiable frame: ${line.slice(0, FRAME_DETAIL_MAX_CHARS)}`)
        return
      }
      input.onFrame(frame)
    },
    (rejected: NdjsonRejectedRecord) => {
      failParse(
        rejected.kind === 'invalid-json'
          ? `invalid JSON frame: ${rejected.line.slice(0, FRAME_DETAIL_MAX_CHARS)}`
          : `frame exceeded the ${rejected.maxLineBytes}-byte limit`
      )
    },
    { maxLineBytes: Number.POSITIVE_INFINITY, shouldPause: () => paused }
  )

  input.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    try {
      framer.feed(chunk)
    } catch (error) {
      // A handler throwing synchronously is as terminal as a parse failure.
      input.onFatal(error instanceof Error ? error : new Error(String(error)))
    }
  })

  return {
    pause: () => {
      paused = true
      input.stdout.pause()
    },
    resume: () => {
      if (!paused) {
        return
      }
      paused = false
      framer.resume()
      if (!paused) {
        input.stdout.resume()
      }
    }
  }
}
