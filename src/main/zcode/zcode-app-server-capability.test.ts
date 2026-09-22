import { describe, expect, it, vi } from 'vitest'
import { ZcodeAppServerRequestError } from './zcode-app-server-connection-errors'
import {
  ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES,
  ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS,
  ZcodeAppServerCapabilityCache,
  ZcodeAppServerUnsupportedError,
  getZcodeAppServerHostKey,
  isZcodeAppServerUnsupportedError
} from './zcode-app-server-capability'

const unsupportedError = new ZcodeAppServerUnsupportedError('unsupported')

describe('ZcodeAppServerCapabilityCache', () => {
  it('retries a host after the compatibility interval', () => {
    const cache = new ZcodeAppServerCapabilityCache()
    cache.rememberUnsupported('native', 1_000)

    expect(
      cache.shouldTry('native', 1_000 + ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS - 1)
    ).toBe(false)
    expect(cache.shouldTry('native', 1_000 + ZCODE_APP_SERVER_CAPABILITY_RETRY_INTERVAL_MS)).toBe(
      true
    )
  })

  it('falls back on the first unsupported probe and skips the probe on later calls', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    const firstPreferred = vi.fn(() => Promise.reject(unsupportedError))
    await expect(
      cache.runWithFallback(
        'native',
        firstPreferred,
        () => Promise.resolve('first-fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('first-fallback')
    expect(firstPreferred).toHaveBeenCalledTimes(1)

    const laterPreferred = vi.fn(() => Promise.resolve('unexpected-preferred'))
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('cached-fallback')
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('isolates capability state per execution host', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    cache.rememberUnsupported('wsl:Ubuntu', 1_000)

    expect(cache.shouldTry('wsl:Ubuntu', 1_001)).toBe(false)
    expect(cache.shouldTry('native', 1_001)).toBe(true)
    expect(cache.shouldTry('wsl:Debian', 1_001)).toBe(true)

    const nativePreferred = vi.fn(() => Promise.resolve('native-result'))
    await expect(
      cache.runWithFallback(
        'native',
        nativePreferred,
        () => Promise.resolve('unexpected'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('native-result')
    expect(nativePreferred).toHaveBeenCalledTimes(1)
  })

  it('bounds host capability state during WSL distro churn', () => {
    const cache = new ZcodeAppServerCapabilityCache()
    cache.rememberUnsupported('native', 1_000)
    for (let index = 0; index < ZCODE_APP_SERVER_CAPABILITY_MAX_ENTRIES + 4; index += 1) {
      cache.rememberUnsupported(`wsl:distro-${index}`, 1_000)
    }

    expect(cache.shouldTry('native', 1_001)).toBe(true)
  })

  it('drops known support when a later call reports the capability unsupported', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.resolve('supported'),
        () => Promise.resolve('unexpected'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('supported')
    expect(cache.isKnownSupported('native')).toBe(true)

    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.reject(unsupportedError),
        () => Promise.resolve('fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('fallback')
    expect(cache.isKnownSupported('native')).toBe(false)

    const laterPreferred = vi.fn(() => Promise.resolve('unexpected-preferred'))
    await expect(
      cache.runWithFallback(
        'native',
        laterPreferred,
        () => Promise.resolve('cached-fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('cached-fallback')
    expect(laterPreferred).not.toHaveBeenCalled()
  })

  it('rethrows transient errors without marking the host unsupported', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    const transient = new Error('spawn ETIMEDOUT')
    await expect(
      cache.runWithFallback(
        'native',
        () => Promise.reject(transient),
        () => Promise.resolve('unexpected-fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).rejects.toBe(transient)
    expect(cache.shouldTry('native', 2)).toBe(true)
  })

  // Why: two pane launches can reach a cold host at once; without dedupe each
  // one pays its own app-server session against a zcode with no such surface.
  it('dedupes concurrent probes on one host to a single app-server session', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    let releaseProbe!: (error: unknown) => void
    const preferred = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          releaseProbe = reject
        })
    )
    const first = cache.runWithFallback(
      'native',
      preferred,
      () => Promise.resolve('fallback'),
      isZcodeAppServerUnsupportedError
    )
    const second = cache.runWithFallback(
      'native',
      preferred,
      () => Promise.resolve('fallback'),
      isZcodeAppServerUnsupportedError
    )
    await Promise.resolve()
    releaseProbe(unsupportedError)

    await expect(first).resolves.toBe('fallback')
    await expect(second).resolves.toBe('fallback')
    expect(preferred).toHaveBeenCalledTimes(1)
  })

  it('lets a waiter run its own work once the in-flight probe reports support', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    let releaseProbe!: (value: string) => void
    const firstPreferred = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseProbe = resolve
        })
    )
    const secondPreferred = vi.fn(() => Promise.resolve('second'))
    const first = cache.runWithFallback(
      'native',
      firstPreferred,
      () => Promise.resolve('fallback'),
      isZcodeAppServerUnsupportedError
    )
    const second = cache.runWithFallback(
      'native',
      secondPreferred,
      () => Promise.resolve('fallback'),
      isZcodeAppServerUnsupportedError
    )
    await Promise.resolve()
    releaseProbe('first')

    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
    expect(secondPreferred).toHaveBeenCalledTimes(1)
  })

  it('isolates in-flight probes per host so a cold WSL distro never waits on native', async () => {
    const cache = new ZcodeAppServerCapabilityCache()
    const nativePreferred = vi.fn(() => new Promise<string>(() => {}))
    void cache.runWithFallback(
      'native',
      nativePreferred,
      () => Promise.resolve('fallback'),
      isZcodeAppServerUnsupportedError
    )
    const wslPreferred = vi.fn(() => Promise.resolve('wsl-result'))
    await expect(
      cache.runWithFallback(
        'wsl:Ubuntu',
        wslPreferred,
        () => Promise.resolve('fallback'),
        isZcodeAppServerUnsupportedError
      )
    ).resolves.toBe('wsl-result')
  })

  it('builds host keys that keep WSL distros apart', () => {
    expect(getZcodeAppServerHostKey({ kind: 'native' })).toBe('native')
    expect(getZcodeAppServerHostKey({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getZcodeAppServerHostKey({ kind: 'wsl', distro: 'Debian' })).toBe('wsl:Debian')
  })
})

describe('isZcodeAppServerUnsupportedError', () => {
  it('accepts only the dedicated unsupported error class', () => {
    expect(isZcodeAppServerUnsupportedError(unsupportedError)).toBe(true)
    expect(isZcodeAppServerUnsupportedError(new Error('spawn ENOENT'))).toBe(false)
    expect(isZcodeAppServerUnsupportedError(new ZcodeAppServerRequestError('x', null, 'y'))).toBe(
      false
    )
  })

  it('reads a -32601 answer as unsupported without the class', () => {
    expect(isZcodeAppServerUnsupportedError({ code: -32601, message: 'no such method' })).toBe(true)
    expect(
      isZcodeAppServerUnsupportedError(
        new ZcodeAppServerRequestError('session/create', -32601, 'method not found')
      )
    ).toBe(true)
    expect(
      isZcodeAppServerUnsupportedError(new ZcodeAppServerRequestError('x', -32602, 'bad params'))
    ).toBe(false)
  })
})
