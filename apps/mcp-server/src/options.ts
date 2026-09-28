/**
 * Command-line and environment handling for the standalone ZenNotes MCP
 * server (`zennotes-mcp`).
 *
 * The vault itself is resolved by the same code `zn mcp` uses
 * (desktop/src/cli/vault-target.ts), so `--server`, `--vault`, `--token`,
 * `ZENNOTES_SERVER`, `ZENNOTES_VAULT` and `ZENNOTES_REMOTE_TOKEN` mean exactly
 * what they mean there. This module adds what a process that is started by an
 * agent (and not by the desktop app) needs on top of that:
 *
 *   - `--token-file` / `ZENNOTES_REMOTE_TOKEN_FILE`, so the server's token does
 *     not have to sit in an MCP client config or on a command line;
 *   - an HTTP transport, for agents that cannot spawn a process on the machine
 *     the vault is reachable from (an agent in WSL talking to Windows, say);
 *   - `--check`, which resolves the vault once, prints what it found and exits.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

export const TOKEN_FILE_ENV = 'ZENNOTES_REMOTE_TOKEN_FILE'
export const TRANSPORT_ENV = 'ZENNOTES_MCP_TRANSPORT'
export const HTTP_HOST_ENV = 'ZENNOTES_MCP_HOST'
export const HTTP_PORT_ENV = 'ZENNOTES_MCP_PORT'
export const HTTP_TOKEN_ENV = 'ZENNOTES_MCP_HTTP_TOKEN'
export const HTTP_TOKEN_FILE_ENV = 'ZENNOTES_MCP_HTTP_TOKEN_FILE'

export const DEFAULT_HTTP_HOST = '127.0.0.1'
export const DEFAULT_HTTP_PORT = 7879

export type Transport = 'stdio' | 'http'

export interface HttpOptions {
  host: string
  port: number
  /** Bearer token MCP clients must send to this server. Not the vault token. */
  token: string | null
  /** Serve a non-loopback address without a token. Off unless asked for. */
  allowNoAuth: boolean
}

export interface CliOptions {
  mode: 'serve' | 'check' | 'help' | 'version'
  /** `--server <name|url>`: a saved server profile or a server URL. */
  server?: string
  /** `--vault <name|path>`: a vault the desktop app knows, or a folder. */
  vault?: string
  /**
   * The vault token this process was given explicitly (`--token`,
   * `--token-file`, or `ZENNOTES_REMOTE_TOKEN_FILE`). `ZENNOTES_REMOTE_TOKEN`
   * is left in the environment for the shared resolver to read, so its
   * precedence is the same as everywhere else.
   */
  token?: string
  transport: Transport
  http: HttpOptions
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const HELP_TEXT = `zennotes-mcp: the ZenNotes MCP server, standalone.

Runs with Node.js (20 or newer) on Windows, Linux and macOS. The desktop app
does not need to be installed. Point it at a ZenNotes server (a "remote vault")
or at a vault folder on this machine.

Usage:
  zennotes-mcp --server <url|name> [--token <token> | --token-file <path>]
  zennotes-mcp --vault <path|name>
  zennotes-mcp ... --check
  zennotes-mcp ... --transport http [--host <addr>] [--port <n>] [--http-token <token>]

Vault:
  --server <url|name>     ZenNotes server to use, e.g. https://notes.example.com
                          or 192.168.1.20:7878, or the name of a server saved
                          in the desktop app. A URL without a scheme gets http://.
  --token <token>         Auth token for that server (sent as a Bearer token).
  --token-file <path>     Read the auth token from a file instead (first line,
                          surrounding whitespace ignored).
  --vault <path|name>     A vault folder on this machine instead of a server.

  With neither --server nor --vault the server follows ZENNOTES_SERVER, then
  ZENNOTES_VAULT, then the vault the ZenNotes desktop app has open (if any).

Transport:
  --transport <stdio|http>  stdio (default) is what MCP clients spawn. http
                          serves MCP Streamable HTTP at http://<host>:<port>/mcp.
  --host <addr>           HTTP listen address. Default ${DEFAULT_HTTP_HOST}.
  --port <n>              HTTP listen port. Default ${DEFAULT_HTTP_PORT}.
  --http-token <token>    Require "Authorization: Bearer <token>" from MCP
                          clients. Required when --host is not a loopback address.
  --http-token-file <path>  Read that token from a file.
  --http-no-auth          Allow a non-loopback --host without --http-token.
                          Anyone who can reach the port can then use your vault.

Other:
  --check                 Resolve the vault, call it once, print what was found
                          (as vault_info would) and exit. 0 on success, 1 if not.
  -h, --help              Show this help.
  -v, --version           Print the version.

Environment:
  ZENNOTES_SERVER             Server URL or saved name (like --server).
  ZENNOTES_VAULT              Vault folder (like --vault).
  ZENNOTES_REMOTE_TOKEN       Server auth token (like --token).
  ZENNOTES_REMOTE_TOKEN_FILE  File holding the server auth token.
  ZENNOTES_CONFIG_DIR         Read desktop-app settings (saved servers, known
                              vaults) from this directory.
  ZENNOTES_MCP_TRANSPORT      stdio or http.
  ZENNOTES_MCP_HOST, ZENNOTES_MCP_PORT, ZENNOTES_MCP_HTTP_TOKEN,
  ZENNOTES_MCP_HTTP_TOKEN_FILE  Defaults for the HTTP flags above.

  Token precedence: --token, --token-file, ZENNOTES_REMOTE_TOKEN,
  ZENNOTES_REMOTE_TOKEN_FILE, then a token saved with the server profile.
`

function expandHome(target: string): string {
  if (target === '~') return os.homedir()
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2))
  }
  return target
}

/**
 * A secret kept in a file: the first non-empty line, trimmed. A file written
 * by `echo token > file` on Windows ends in CRLF and one written by a secret
 * manager may end in nothing; both read the same.
 */
export async function readSecretFile(file: string, what: string): Promise<string> {
  const resolved = path.resolve(expandHome(file.trim()))
  let raw: string
  try {
    raw = await fs.readFile(resolved, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'it does not exist' : (err as Error).message
    throw new UsageError(`Could not read the ${what} from ${resolved}: ${reason}.`)
  }
  const line = raw
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) throw new UsageError(`The ${what} file ${resolved} is empty.`)
  return line
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

function parsePort(raw: string, source: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new UsageError(`${source} must be a port number between 0 and 65535, not "${raw}".`)
  }
  const port = Number(raw.trim())
  if (port > 65535) {
    throw new UsageError(`${source} must be a port number between 0 and 65535, not "${raw}".`)
  }
  return port
}

/**
 * Turn argv and the environment into options. Throws UsageError for anything
 * the user has to fix; the caller prints it and exits with status 2.
 */
export async function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<CliOptions> {
  let parsed: ReturnType<typeof parseArgsStrict>
  try {
    parsed = parseArgsStrict(argv)
  } catch (err) {
    // Node's own wording runs on with advice about `--` that does not apply
    // here; its first sentence says what is wrong.
    const message = (err as Error).message
    const first = /^.*?\.(?=\s|$)/.exec(message)?.[0] ?? message
    throw new UsageError(`${first} Run zennotes-mcp --help for usage.`)
  }
  const { values, positionals } = parsed
  if (positionals.length > 0) {
    throw new UsageError(
      `Unexpected argument "${positionals[0]}". Run zennotes-mcp --help for usage.`
    )
  }

  const http: HttpOptions = {
    host: DEFAULT_HTTP_HOST,
    port: DEFAULT_HTTP_PORT,
    token: null,
    allowNoAuth: values['http-no-auth'] === true
  }

  if (values.help) return { mode: 'help', transport: 'stdio', http }
  if (values.version) return { mode: 'version', transport: 'stdio', http }

  const server = nonEmpty(values.server)
  const vault = nonEmpty(values.vault)
  if (values.server !== undefined && !server) {
    throw new UsageError('--server needs a server URL or name, e.g. --server https://notes.example.com.')
  }
  if (values.vault !== undefined && !vault) {
    throw new UsageError('--vault needs a vault folder or name.')
  }

  const flagToken = values.token
  const flagTokenFile = values['token-file']
  if (flagToken !== undefined && flagTokenFile !== undefined) {
    throw new UsageError('Pass either --token or --token-file, not both.')
  }
  if (flagToken !== undefined && !flagToken.trim()) {
    throw new UsageError('--token is empty.')
  }
  let token: string | undefined
  if (flagToken !== undefined) token = flagToken.trim()
  else if (flagTokenFile !== undefined) {
    token = await readSecretFile(flagTokenFile, 'server token')
  } else if (!nonEmpty(env.ZENNOTES_REMOTE_TOKEN) && nonEmpty(env[TOKEN_FILE_ENV])) {
    token = await readSecretFile(env[TOKEN_FILE_ENV]!, `server token (${TOKEN_FILE_ENV})`)
  }

  const transportRaw = (values.transport ?? nonEmpty(env[TRANSPORT_ENV]) ?? 'stdio')
    .trim()
    .toLowerCase()
  if (transportRaw !== 'stdio' && transportRaw !== 'http') {
    throw new UsageError(`--transport must be stdio or http, not "${transportRaw}".`)
  }
  const transport = transportRaw as Transport

  const hostRaw = values.host ?? nonEmpty(env[HTTP_HOST_ENV])
  if (hostRaw !== undefined) {
    if (!hostRaw.trim()) throw new UsageError('--host is empty.')
    http.host = hostRaw.trim()
  }
  if (values.port !== undefined) http.port = parsePort(values.port, '--port')
  else if (nonEmpty(env[HTTP_PORT_ENV])) http.port = parsePort(env[HTTP_PORT_ENV]!, HTTP_PORT_ENV)

  if (values['http-token'] !== undefined && values['http-token-file'] !== undefined) {
    throw new UsageError('Pass either --http-token or --http-token-file, not both.')
  }
  if (values['http-token'] !== undefined) {
    if (!values['http-token'].trim()) throw new UsageError('--http-token is empty.')
    http.token = values['http-token'].trim()
  } else if (values['http-token-file'] !== undefined) {
    http.token = await readSecretFile(values['http-token-file'], 'HTTP token')
  } else if (nonEmpty(env[HTTP_TOKEN_ENV])) {
    http.token = nonEmpty(env[HTTP_TOKEN_ENV])!
  } else if (nonEmpty(env[HTTP_TOKEN_FILE_ENV])) {
    http.token = await readSecretFile(env[HTTP_TOKEN_FILE_ENV]!, `HTTP token (${HTTP_TOKEN_FILE_ENV})`)
  }

  if (transport === 'http' && !http.token && !http.allowNoAuth && !isLoopbackHost(http.host)) {
    throw new UsageError(
      `Refusing to serve MCP on ${http.host} without a token: anyone who can reach it could read and ` +
        'change your notes. Pass --http-token (or --http-token-file), or --http-no-auth if you really mean it.'
    )
  }

  return {
    mode: values.check ? 'check' : 'serve',
    ...(server ? { server } : {}),
    ...(vault ? { vault } : {}),
    ...(token ? { token } : {}),
    transport,
    http
  }
}

function parseArgsStrict(argv: string[]) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      vault: { type: 'string' },
      token: { type: 'string' },
      'token-file': { type: 'string' },
      transport: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'http-token': { type: 'string' },
      'http-token-file': { type: 'string' },
      'http-no-auth': { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }
    }
  })
}
