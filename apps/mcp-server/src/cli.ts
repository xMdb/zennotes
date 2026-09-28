/**
 * `zennotes-mcp`: the ZenNotes MCP server as a plain Node.js program.
 *
 * The tools, their behaviour and the model instructions are the desktop
 * app's own (desktop/src/mcp), compiled into this program at build time, so
 * an agent sees the same server whether it was set up from the desktop app
 * (`zn mcp`) or from this package. What this package adds is a way to run
 * that server with nothing but Node.js: no Electron, no desktop install, no
 * POSIX shell wrapper, so it runs the same way on Windows, in WSL and on
 * Linux, against a ZenNotes server anywhere on the network.
 */

import { runMcpServer, callTool, describeToolError } from '@desktop/mcp/server'
import { createBackend } from '@desktop/cli/backend'
import type { VaultTarget } from '@desktop/cli/vault-target'
import { startHttpServer } from './http'
import { HELP_TEXT, UsageError, parseCliOptions, type CliOptions } from './options'
import { createTargetResolver, describeTarget, targetWarnings } from './target'
import { VERSION } from './version'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
}

function logTarget(io: CliIo, target: VaultTarget, options: CliOptions): void {
  io.stderr(`[zennotes-mcp] ${VERSION} serving the ${describeTarget(target)}\n`)
  for (const warning of targetWarnings(target, options)) io.stderr(`[zennotes-mcp] warning: ${warning}\n`)
}

/** `--check`: resolve, call vault_info once, report. */
async function runCheck(options: CliOptions, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const resolveTarget = createTargetResolver(options, env)
  let target: VaultTarget
  try {
    target = await resolveTarget()
  } catch (err) {
    io.stderr(`zennotes-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  for (const warning of targetWarnings(target, options)) io.stderr(`zennotes-mcp: warning: ${warning}\n`)
  try {
    const info = await callTool('vault_info', {}, createBackend(target))
    io.stdout(`${JSON.stringify(info, null, 2)}\n`)
    io.stderr(`zennotes-mcp: OK, reached the ${describeTarget(target)}.\n`)
    return 0
  } catch (err) {
    io.stderr(`zennotes-mcp: could not use the ${describeTarget(target)}: ${describeToolError(err)}\n`)
    return 1
  }
}

/**
 * Run the program. Resolves with an exit code for commands that finish, or
 * with null once a server is up (the process then lives as long as its
 * transport does).
 */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = defaultIo
): Promise<number | null> {
  let options: CliOptions
  try {
    options = await parseCliOptions(argv, env)
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`zennotes-mcp: ${err.message}\n`)
      return 2
    }
    throw err
  }

  if (options.mode === 'help') {
    io.stdout(HELP_TEXT)
    return 0
  }
  if (options.mode === 'version') {
    io.stdout(`${VERSION}\n`)
    return 0
  }
  if (options.mode === 'check') return await runCheck(options, env, io)

  const resolveTarget = createTargetResolver(options, env)

  if (options.transport === 'http') {
    const server = await startHttpServer(options.http, resolveTarget, (line) => io.stderr(`${line}\n`))
    io.stderr(`[zennotes-mcp] MCP endpoint: ${server.url}${options.http.token ? ' (Bearer token required)' : ''}\n`)
    try {
      logTarget(io, await resolveTarget(), options)
    } catch (err) {
      io.stderr(
        `[zennotes-mcp] ${err instanceof Error ? err.message : String(err)} The MCP server is running anyway; every tool call returns this error until a vault resolves.\n`
      )
    }
    const shutdown = (): void => {
      server.close().finally(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return null
  }

  // stdio. stdout is the protocol channel from here on: everything for a
  // person goes to stderr, which MCP clients keep in their server logs.
  await runMcpServer({ resolveTarget })
  const target = await resolveTarget().catch(() => null)
  if (target) logTarget(io, target, options)

  // The client closing our stdin is the end of the session. Exit rather than
  // wait for idle sockets to drain, so a client that restarts us (or quits)
  // never leaves a stray server behind, which on Windows holds files open.
  const exit = (): void => process.exit(0)
  process.stdin.once('end', exit)
  process.stdin.once('close', exit)
  return null
}
