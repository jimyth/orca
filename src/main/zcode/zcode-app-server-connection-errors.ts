/** The server answered and refused the call, rather than timing out or exiting. */
export class ZcodeAppServerRequestError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string
  ) {
    super(message)
    this.name = 'ZcodeAppServerRequestError'
  }
}

export function isZcodeAppServerRequestError(error: unknown): error is ZcodeAppServerRequestError {
  return error instanceof Error && error.name === 'ZcodeAppServerRequestError'
}

/** One request outlived its deadline; the connection itself stays usable. */
export class ZcodeAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerTimeoutError'
  }
}

/** The server emitted stdout this protocol cannot classify — the transport is dead. */
export class ZcodeAppServerProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerProtocolError'
  }
}
