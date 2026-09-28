/**
 * Which vault this process serves, resolved with the desktop CLI's own
 * resolver so the standalone server and `zn mcp` never disagree about what a
 * flag means.
 */

import type { ParsedArgs } from '@desktop/cli/args'
import { resolveTarget, type VaultTarget } from '@desktop/cli/vault-target'
import type { CliOptions } from './options'

/** The subset of `zn` flags the shared resolver reads. */
export function toParsedArgs(options: Pick<CliOptions, 'server' | 'vault' | 'token'>): ParsedArgs {
  const flags = new Map<string, string[]>()
  if (options.server) flags.set('server', [options.server])
  if (options.vault) flags.set('vault', [options.vault])
  if (options.token) flags.set('token', [options.token])
  return { positionals: [], flags }
}

/**
 * A resolver that keeps the first target that resolves and tries again after
 * a failure, shared by every session of an HTTP server so they all serve the
 * same vault. (A stdio server has one session; the MCP core pins its own
 * backend the same way.)
 */
export function createTargetResolver(
  options: Pick<CliOptions, 'server' | 'vault' | 'token'>,
  env: NodeJS.ProcessEnv = process.env,
  resolve: (args: ParsedArgs, env: NodeJS.ProcessEnv) => Promise<VaultTarget> = resolveTarget
): () => Promise<VaultTarget> {
  const args = toParsedArgs(options)
  let pending: Promise<VaultTarget> | null = null
  return () => {
    if (!pending) {
      pending = resolve(args, env)
      pending.catch(() => {
        pending = null
      })
    }
    return pending
  }
}

/** One line for stderr describing a resolved target, with no secrets in it. */
export function describeTarget(target: VaultTarget): string {
  if (target.kind === 'local') return `vault folder ${target.root}`
  const name = target.name ? `"${target.name}" ` : ''
  return `ZenNotes server ${name}at ${target.baseUrl} (${target.authToken ? 'with' : 'without'} an auth token)`
}

/**
 * Warnings worth a line on stderr at startup: things that work but are
 * probably not what the user meant.
 */
export function targetWarnings(
  target: VaultTarget,
  options: Pick<CliOptions, 'token'>
): string[] {
  const warnings: string[] = []
  if (target.kind === 'local' && options.token) {
    warnings.push('A server token was given but the vault is a local folder, so it is not used.')
  }
  if (target.kind === 'remote' && target.authToken) {
    let url: URL | null = null
    try {
      url = new URL(target.baseUrl)
    } catch {
      url = null
    }
    const host = url?.hostname.replace(/^\[|\]$/g, '').toLowerCase() ?? ''
    const loopback = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
    if (url?.protocol === 'http:' && !loopback) {
      warnings.push(
        `The auth token is sent to ${target.baseUrl} over plain http. Use an https:// URL if this server is not on a network you trust.`
      )
    }
  }
  return warnings
}
