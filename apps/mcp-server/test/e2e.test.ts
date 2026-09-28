/**
 * The built program, run the way an MCP client runs it: `node
 * zennotes-mcp.mjs ...` from a directory with no node_modules, against a
 * ZenNotes server that requires a token. The server here is a small stand-in
 * for the Go server's HTTP API, enough for the tools exercised below.
 */

import { spawn, execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBundle } from '../scripts/bundle.mjs'

const execFileAsync = promisify(execFile)
const TOKEN = 'vault-token-e2e'

/* ---------- A token-protected stand-in for the ZenNotes server ---------- */

interface FakeServer {
  url: string
  hostPort: string
  requests: Array<{ path: string; auth: string | null }>
  notes: Map<string, string>
  comments: Map<string, unknown[]>
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

function meta(rel: string, body: string) {
  return {
    path: rel,
    title: path.posix.basename(rel, '.md'),
    folder: rel.split('/')[0],
    createdAt: 1,
    updatedAt: 2,
    size: body.length,
    tags: [],
    wikilinks: [],
    excerpt: body.slice(0, 40)
  }
}

async function startFakeServer(): Promise<FakeServer> {
  const requests: FakeServer['requests'] = []
  const notes = new Map<string, string>([['inbox/Hello.md', '# Hello\n\nFirst line.\n']])
  const comments = new Map<string, unknown[]>()

  const server: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push({ path: url.pathname, auth: req.headers.authorization ?? null })
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: 'unauthorized' })
      return
    }
    void (async () => {
      const rel = url.searchParams.get('path') ?? ''
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/vault':
          return send(200, { root: '/srv/notes', name: 'notes' })
        case 'GET /api/vault/settings':
          return send(200, { primaryNotesLocation: 'inbox', systemFolderPaths: null })
        case 'GET /api/folders':
          return send(200, [{ folder: 'inbox', subpath: 'Work' }])
        case 'GET /api/notes':
          return send(200, [...notes].map(([p, b]) => meta(p, b)))
        case 'GET /api/notes/read': {
          const body = notes.get(rel)
          return body == null ? send(404, { error: 'not found' }) : send(200, { ...meta(rel, body), body })
        }
        case 'POST /api/notes/write': {
          const { path: p, body } = (await readBody(req)) as { path: string; body: string }
          notes.set(p, body)
          return send(200, meta(p, body))
        }
        case 'GET /api/comments/read':
          return send(200, comments.get(rel) ?? [])
        case 'POST /api/comments/write': {
          const { path: p, comments: list } = (await readBody(req)) as {
            path: string
            comments: Array<Record<string, unknown>>
          }
          const stored = list.map((c, i) => ({
            createdAt: 1,
            updatedAt: 1,
            resolvedAt: null,
            ...c,
            id: (c.id as string | undefined) ?? `c${i + 1}`,
            notePath: p
          }))
          comments.set(p, stored)
          return send(200, stored)
        }
        default:
          return send(404, { error: `no route ${url.pathname}` })
      }
    })().catch((err: unknown) => send(500, { error: String(err) }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    requests,
    notes,
    comments,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/* ---------- Fixtures ---------------------------------------------------- */

let workDir: string
let bundle: string
let tokenFile: string
let fake: FakeServer

/** An environment with nothing of the developer's in it: no desktop config,
 *  no ZenNotes variables. */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !key.startsWith('ZENNOTES_')) env[key] = value
  }
  return { ...env, ZENNOTES_CONFIG_DIR: path.join(workDir, 'config'), ...extra }
}

beforeAll(async () => {
  workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zennotes-mcp-e2e-'))
  await fsp.mkdir(path.join(workDir, 'config'))
  // Built into a directory with no node_modules above it, like a copy of the
  // file on another machine.
  bundle = (await buildBundle({ outfile: path.join(workDir, 'bin', 'zennotes-mcp.mjs') })).outfile
  tokenFile = path.join(workDir, 'token.txt')
  await fsp.writeFile(tokenFile, `${TOKEN}\r\n`)
  fake = await startFakeServer()
})

afterAll(async () => {
  await fake?.close()
  if (workDir) await fsp.rm(workDir, { recursive: true, force: true })
})

async function runBundle(args: string[], env = cleanEnv()) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundle, ...args], {
      cwd: workDir,
      env
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string }
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text: string }>)[0].text
}

/* ---------- Tests ------------------------------------------------------- */

describe('zennotes-mcp as a program', () => {
  it('prints its version and help, and exits 2 on a bad flag', async () => {
    const version = await runBundle(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect((await runBundle(['--help'])).stdout).toContain('--token-file')
    const bad = await runBundle(['--nope'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain("Unknown option '--nope'")
  })

  it('--check reaches a token-protected server and reports what it found', async () => {
    const ok = await runBundle(['--server', fake.hostPort, '--token-file', tokenFile, '--check'])
    expect(ok.stderr).toContain('OK, reached the ZenNotes server')
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.stdout)).toMatchObject({
      kind: 'remote',
      server: fake.url,
      vaultName: 'notes',
      authConfigured: true,
      subfolders: [{ folder: 'inbox', subpath: 'Work' }]
    })
    expect(ok.stderr).not.toContain(TOKEN)
  })

  it('--check fails with the token hint when the token is wrong or missing', async () => {
    const wrong = await runBundle(['--server', fake.hostPort, '--token', 'wrong', '--check'])
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('rejected the connection')
    expect(wrong.stderr).toContain('--token-file')

    const none = await runBundle(['--check'], cleanEnv({ ZENNOTES_SERVER: fake.url }))
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('without an auth token')
  })

  it('takes the server and token from the environment', async () => {
    const env = cleanEnv({ ZENNOTES_SERVER: fake.url, ZENNOTES_REMOTE_TOKEN: TOKEN })
    expect((await runBundle(['--check'], env)).code).toBe(0)
    const fromFile = cleanEnv({ ZENNOTES_SERVER: fake.url, ZENNOTES_REMOTE_TOKEN_FILE: tokenFile })
    expect((await runBundle(['--check'], fromFile)).code).toBe(0)
  })

  it('serves MCP over stdio against the remote vault, sending the token on every request', async () => {
    fake.requests.length = 0
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--server', fake.url, '--token-file', tokenFile],
      env: cleanEnv(),
      cwd: workDir,
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    const client = new Client({ name: 'hermes-agent', version: '1.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['vault_info', 'read_note', 'append_to_note']))
      expect(client.getInstructions()).toBeTruthy()

      const listed = JSON.parse(toolText(await client.callTool({ name: 'list_notes', arguments: {} })))
      expect(listed.map((n: { path: string }) => n.path)).toEqual(['inbox/Hello.md'])

      const appended = await client.callTool({
        name: 'append_to_note',
        arguments: { path: 'inbox/Hello.md', text: '- from the agent' }
      })
      expect(appended.isError).toBeFalsy()
      expect(fake.notes.get('inbox/Hello.md')).toBe('# Hello\n\nFirst line.\n\n- from the agent\n')

      const comment = JSON.parse(
        toolText(
          await client.callTool({
            name: 'add_comment',
            arguments: { path: 'inbox/Hello.md', body: 'Looks good', anchor_text: 'First line.' }
          })
        )
      )
      expect(comment.author).toBe('Hermes Agent')

      expect(fake.requests.length).toBeGreaterThan(0)
      expect(new Set(fake.requests.map((r) => r.auth))).toEqual(new Set([`Bearer ${TOKEN}`]))
      expect(stderr).toContain(`serving the ZenNotes server at ${fake.url} (with an auth token)`)
      expect(stderr).not.toContain(TOKEN)
    } finally {
      await client.close()
    }
  })

  it('exits when the client closes its stdin', async () => {
    const child = spawn(process.execPath, [bundle, '--server', fake.url, '--token-file', tokenFile], {
      cwd: workDir,
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    // Wait until it is serving, then hang up.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never started: ${stderr}`)), 20_000)
      child.stderr.on('data', () => {
        if (stderr.includes('serving the')) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    child.stdin.end()
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000))
    ])
    if (code === 'timeout') child.kill()
    expect(code).toBe(0)
  })

  it('serves MCP over HTTP with its own bearer token, one session per client', async () => {
    const child = spawn(
      process.execPath,
      [bundle, '--server', fake.url, '--transport', 'http', '--port', '0', '--http-token', 'mcp-secret'],
      { cwd: workDir, env: cleanEnv({ ZENNOTES_REMOTE_TOKEN: TOKEN }), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no endpoint: ${stderr}`)), 20_000)
        child.stderr.on('data', () => {
          const match = /MCP endpoint: (\S+)/.exec(stderr)
          if (match) {
            clearTimeout(timer)
            resolve(match[1])
          }
        })
      })
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

      const unauthorized = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      })
      expect(unauthorized.status).toBe(401)
      expect((await fetch(new URL('/healthz', endpoint))).status).toBe(200)

      const connect = async (name: string) => {
        const client = new Client({ name, version: '1.0.0' })
        await client.connect(
          new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: { Authorization: 'Bearer mcp-secret' } }
          })
        )
        return client
      }
      const hermes = await connect('hermes')
      const claude = await connect('claude-code')
      try {
        const sign = async (client: Client, body: string) =>
          JSON.parse(
            toolText(
              await client.callTool({ name: 'add_comment', arguments: { path: 'inbox/Hello.md', body } })
            )
          ).author as string
        // Interleaved sessions each sign as their own client.
        expect(await sign(hermes, 'one')).toBe('Hermes')
        expect(await sign(claude, 'two')).toBe('Claude Code')
        expect(await sign(hermes, 'three')).toBe('Hermes')

        const info = JSON.parse(toolText(await claude.callTool({ name: 'vault_info', arguments: {} })))
        expect(info).toMatchObject({ kind: 'remote', server: fake.url, authConfigured: true })
      } finally {
        await hermes.close()
        await claude.close()
      }
    } finally {
      child.kill('SIGINT')
      await exited
    }
  })
})
