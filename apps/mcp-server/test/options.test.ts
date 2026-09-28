import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  UsageError,
  isLoopbackHost,
  parseCliOptions,
  readSecretFile
} from '../src/options'

let dir: string
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-options-'))
})
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

async function secret(name: string, content: string): Promise<string> {
  const file = path.join(dir, name)
  await fsp.writeFile(file, content)
  return file
}

const noEnv: NodeJS.ProcessEnv = {}

describe('parseCliOptions', () => {
  it('defaults to serving over stdio with nothing named', async () => {
    expect(await parseCliOptions([], noEnv)).toEqual({
      mode: 'serve',
      transport: 'stdio',
      http: { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT, token: null, allowNoAuth: false }
    })
  })

  it('takes a server and token in both flag spellings', async () => {
    const spaced = await parseCliOptions(['--server', 'https://notes.example.com', '--token', ' abc '], noEnv)
    const joined = await parseCliOptions(['--server=https://notes.example.com', '--token=abc'], noEnv)
    for (const options of [spaced, joined]) {
      expect(options).toMatchObject({ mode: 'serve', server: 'https://notes.example.com', token: 'abc' })
    }
  })

  it('takes a local vault', async () => {
    expect(await parseCliOptions(['--vault', 'C:\\Notes'], noEnv)).toMatchObject({ vault: 'C:\\Notes' })
  })

  it('reads --token-file, ignoring a BOM, CRLF and blank lines', async () => {
    const file = await secret('crlf.txt', '\uFEFF\r\n  tok-123  \r\nsecond line\r\n')
    expect((await parseCliOptions(['--token-file', file], noEnv)).token).toBe('tok-123')
  })

  it('rejects an empty or missing token file with a message naming it', async () => {
    const empty = await secret('empty.txt', ' \n\n')
    await expect(parseCliOptions(['--token-file', empty], noEnv)).rejects.toThrow(/is empty/)
    const missing = path.join(dir, 'nope.txt')
    await expect(parseCliOptions(['--token-file', missing], noEnv)).rejects.toThrow(
      /Could not read the server token from .*nope\.txt: it does not exist/
    )
  })

  it('refuses --token together with --token-file', async () => {
    const file = await secret('t.txt', 'x')
    await expect(parseCliOptions(['--token', 'a', '--token-file', file], noEnv)).rejects.toThrow(
      /either --token or --token-file/
    )
  })

  it('leaves ZENNOTES_REMOTE_TOKEN to the shared resolver and reads the token file env only without it', async () => {
    const file = await secret('env.txt', 'from-file')
    expect(
      (await parseCliOptions([], { ZENNOTES_REMOTE_TOKEN: 'from-env', ZENNOTES_REMOTE_TOKEN_FILE: file })).token
    ).toBeUndefined()
    expect((await parseCliOptions([], { ZENNOTES_REMOTE_TOKEN_FILE: file })).token).toBe('from-file')
    // Flags beat the environment.
    expect((await parseCliOptions(['--token', 'flag'], { ZENNOTES_REMOTE_TOKEN_FILE: file })).token).toBe('flag')
  })

  it('reports usage errors as UsageError', async () => {
    for (const argv of [
      ['--bogus'],
      ['stray'],
      ['--server'],
      ['--server', ''],
      ['--token', '  '],
      ['--transport', 'sse'],
      ['--port', '99999'],
      ['--port', 'abc']
    ]) {
      await expect(parseCliOptions(argv, noEnv), argv.join(' ')).rejects.toBeInstanceOf(UsageError)
    }
  })

  it('configures the HTTP transport from flags and environment', async () => {
    expect(
      await parseCliOptions(['--transport', 'http', '--port', '0', '--http-token', 'mcp'], noEnv)
    ).toMatchObject({ transport: 'http', http: { host: '127.0.0.1', port: 0, token: 'mcp' } })
    const file = await secret('http.txt', 'from-file\n')
    expect(
      await parseCliOptions([], {
        ZENNOTES_MCP_TRANSPORT: 'HTTP',
        ZENNOTES_MCP_HOST: '0.0.0.0',
        ZENNOTES_MCP_PORT: '8123',
        ZENNOTES_MCP_HTTP_TOKEN_FILE: file
      })
    ).toMatchObject({ transport: 'http', http: { host: '0.0.0.0', port: 8123, token: 'from-file' } })
  })

  it('refuses a non-loopback HTTP address without a token unless told to', async () => {
    await expect(parseCliOptions(['--transport', 'http', '--host', '0.0.0.0'], noEnv)).rejects.toThrow(
      /Refusing to serve MCP on 0\.0\.0\.0 without a token/
    )
    expect(
      await parseCliOptions(['--transport', 'http', '--host', '0.0.0.0', '--http-no-auth'], noEnv)
    ).toMatchObject({ http: { host: '0.0.0.0', token: null, allowNoAuth: true } })
    expect(
      await parseCliOptions(['--transport', 'http', '--host', 'localhost'], noEnv)
    ).toMatchObject({ http: { host: 'localhost', token: null } })
  })

  it('answers --help, --version and --check', async () => {
    expect((await parseCliOptions(['-h'], noEnv)).mode).toBe('help')
    expect((await parseCliOptions(['--version'], noEnv)).mode).toBe('version')
    expect((await parseCliOptions(['--server', 'x:1', '--check'], noEnv)).mode).toBe('check')
  })
})

describe('isLoopbackHost', () => {
  it('knows loopback from everything else', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'notes.example.com', 'localhost.evil.com']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('readSecretFile', () => {
  it('expands ~ to the home directory', async () => {
    await expect(readSecretFile('~/definitely-not-a-zennotes-token-file', 'token')).rejects.toThrow(
      os.homedir()
    )
  })
})
