import { describe, expect, it } from 'vitest'
import { getString } from '@desktop/cli/args'
import type { VaultTarget } from '@desktop/cli/vault-target'
import { createTargetResolver, describeTarget, targetWarnings, toParsedArgs } from '../src/target'

describe('toParsedArgs', () => {
  it('hands the shared resolver exactly the flags that were given', () => {
    const args = toParsedArgs({ server: 'https://n.example', token: 't' })
    expect(getString(args, 'server')).toBe('https://n.example')
    expect(getString(args, 'token')).toBe('t')
    expect(getString(args, 'vault')).toBeUndefined()
    expect(toParsedArgs({}).flags.size).toBe(0)
  })
})

describe('createTargetResolver', () => {
  it('keeps the first target that resolves and retries after a failure', async () => {
    const outcomes: Array<Error | VaultTarget> = [
      new Error('not yet'),
      { kind: 'local', root: '/a' },
      { kind: 'local', root: '/b' }
    ]
    let calls = 0
    const resolve = createTargetResolver({}, {}, async () => {
      const next = outcomes[calls++]
      if (next instanceof Error) throw next
      return next
    })
    await expect(resolve()).rejects.toThrow('not yet')
    expect(await resolve()).toEqual({ kind: 'local', root: '/a' })
    expect(await resolve()).toEqual({ kind: 'local', root: '/a' })
    expect(calls).toBe(2)
  })

  it('resolves a server URL and token through the shared resolver', async () => {
    const resolve = createTargetResolver(
      { server: 'https://notes.example.com/', token: 'abc' },
      { ZENNOTES_CONFIG_DIR: '/nonexistent-zennotes-config' }
    )
    expect(await resolve()).toEqual({
      kind: 'remote',
      name: '',
      baseUrl: 'https://notes.example.com',
      authToken: 'abc'
    })
  })
})

describe('describeTarget and targetWarnings', () => {
  const remote = (baseUrl: string, authToken: string | null): VaultTarget => ({
    kind: 'remote',
    name: '',
    baseUrl,
    authToken
  })

  it('never prints the token', () => {
    const line = describeTarget(remote('https://n.example', 'super-secret'))
    expect(line).toContain('https://n.example')
    expect(line).toContain('with an auth token')
    expect(line).not.toContain('super-secret')
  })

  it('warns about a token sent over plain http off this machine only', () => {
    expect(targetWarnings(remote('http://192.168.1.4:7878', 't'), {})).toHaveLength(1)
    expect(targetWarnings(remote('https://n.example', 't'), {})).toEqual([])
    expect(targetWarnings(remote('http://127.0.0.1:7878', 't'), {})).toEqual([])
    expect(targetWarnings(remote('http://localhost:7878', 't'), {})).toEqual([])
    expect(targetWarnings(remote('http://192.168.1.4:7878', null), {})).toEqual([])
  })

  it('warns when a token is given for a local folder', () => {
    expect(targetWarnings({ kind: 'local', root: '/v' }, { token: 't' })[0]).toContain('not used')
  })
})
