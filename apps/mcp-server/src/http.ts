/**
 * MCP over Streamable HTTP, for agents that cannot spawn the server as a
 * child process: an agent in WSL, in a container, or on another machine
 * connects to a URL instead.
 *
 * One MCP session per client, each backed by its own instance of the shared
 * MCP server, all serving the vault the shared resolver pins. The endpoint is
 * `/mcp`; `/healthz` answers without auth so a supervisor can probe it.
 *
 * Protection, since this port reaches the vault with the vault's token:
 *   - `--http-token` makes every MCP request carry `Authorization: Bearer`;
 *     options.ts refuses a non-loopback address without one unless told to;
 *   - on a loopback address the Host header must name loopback, and a browser
 *     Origin must be loopback too, so a web page cannot reach the port through
 *     DNS rebinding.
 */

import { randomUUID, timingSafeEqual, createHash } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { runMcpServer } from '@desktop/mcp/server'
import type { VaultTarget } from '@desktop/cli/vault-target'
import { isLoopbackHost, type HttpOptions } from './options'

export const MCP_PATH = '/mcp'
export const HEALTH_PATH = '/healthz'

/** A note body can be large; a request larger than this is not an MCP call. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * A session nobody has used for this long is closed, so clients that go away
 * without ending their session (most do) cannot pile up for the life of the
 * process. A client that comes back after that gets 404 and, as the MCP spec
 * requires of it, starts a new session. A session with an open event stream
 * is in use however quiet it is.
 */
export const DEFAULT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000

interface Session {
  transport: StreamableHTTPServerTransport
  lastSeen: number
  openStreams: number
}

export interface McpHttpServer {
  /** The URL clients connect to, with the port actually bound. */
  url: string
  port: number
  close(): Promise<void>
}

function sameSecret(given: string, expected: string): boolean {
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers)
}

function hostnameOf(hostHeader: string): string {
  // "[::1]:7879" -> "::1", "localhost:7879" -> "localhost"
  const trimmed = hostHeader.trim()
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'))
  const colon = trimmed.lastIndexOf(':')
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new BodyError(413, 'Request body too large.')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) throw new BodyError(400, 'Request body is empty.')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BodyError(400, 'Request body is not valid JSON.')
  }
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function isInitializeBody(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((message) => isInitializeRequest(message))
  return isInitializeRequest(body)
}

export async function startHttpServer(
  options: HttpOptions,
  resolveTarget: () => Promise<VaultTarget>,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  { sessionIdleMs = DEFAULT_SESSION_IDLE_MS }: { sessionIdleMs?: number } = {}
): Promise<McpHttpServer> {
  const sessions = new Map<string, Session>()
  const loopbackOnly = isLoopbackHost(options.host)

  /** The session a request names, marked as used. */
  const touch = (id: string | undefined): Session | undefined => {
    const session = id ? sessions.get(id) : undefined
    if (session) session.lastSeen = Date.now()
    return session
  }

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - sessionIdleMs
      for (const [id, session] of sessions) {
        if (session.openStreams > 0 || session.lastSeen > cutoff) continue
        sessions.delete(id)
        session.transport.close().catch(() => {})
      }
    },
    Math.max(1_000, Math.min(sessionIdleMs, 5 * 60 * 1000))
  )
  sweep.unref()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (loopbackOnly) {
      const host = req.headers.host
      if (!host || !isLoopbackHost(hostnameOf(host))) {
        jsonRpcError(res, 403, 'Forbidden: this server only answers requests addressed to localhost.')
        return
      }
      const origin = req.headers.origin
      if (origin && origin !== 'null') {
        let originHost = ''
        try {
          originHost = new URL(origin).hostname
        } catch {
          originHost = ''
        }
        if (!isLoopbackHost(originHost)) {
          jsonRpcError(res, 403, 'Forbidden: cross-origin requests are not allowed.')
          return
        }
      }
    }

    if (url.pathname === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname !== MCP_PATH) {
      jsonRpcError(res, 404, `Not found. The MCP endpoint is ${MCP_PATH}.`)
      return
    }

    if (options.token) {
      const header = req.headers.authorization ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(header.trim())
      if (!match || !sameSecret(match[1].trim(), options.token)) {
        jsonRpcError(res, 401, 'Unauthorized: send the server\'s --http-token as "Authorization: Bearer <token>".', {
          'WWW-Authenticate': 'Bearer realm="zennotes-mcp"'
        })
        return
      }
    }

    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader

    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (err) {
        const status = err instanceof BodyError ? err.status : 400
        jsonRpcError(res, status, (err as Error).message)
        return
      }

      if (sessionId) {
        const session = touch(sessionId)
        if (!session) {
          jsonRpcError(res, 404, 'Session not found. Start a new session with an initialize request.')
          return
        }
        await session.transport.handleRequest(req, res, body)
        return
      }

      if (!isInitializeBody(body)) {
        jsonRpcError(res, 400, 'Bad Request: no session. Send an initialize request first.')
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, lastSeen: Date.now(), openStreams: 0 })
        }
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await runMcpServer({ resolveTarget, transport })
      await transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = touch(sessionId)
      if (!session) {
        jsonRpcError(
          res,
          sessionId ? 404 : 400,
          sessionId ? 'Session not found.' : 'Bad Request: missing Mcp-Session-Id header.'
        )
        return
      }
      if (req.method === 'GET') {
        // The server-to-client event stream: open until the client drops it.
        session.openStreams += 1
        res.once('close', () => {
          session.openStreams -= 1
          session.lastSeen = Date.now()
        })
      }
      await session.transport.handleRequest(req, res)
      return
    }

    jsonRpcError(res, 405, 'Method not allowed.', { Allow: 'GET, POST, DELETE' })
  }

  const server: HttpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`[zennotes-mcp] HTTP request failed: ${err instanceof Error ? err.message : String(err)}`)
      jsonRpcError(res, 500, 'Internal server error.')
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    server.listen(options.port, options.host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  server.on('error', (err) => log(`[zennotes-mcp] HTTP server error: ${err.message}`))

  const address = server.address() as AddressInfo
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
  const url = `http://${displayHost}:${address.port}${MCP_PATH}`

  return {
    url,
    port: address.port,
    close: async () => {
      clearInterval(sweep)
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(open.map((session) => session.transport.close()))
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
