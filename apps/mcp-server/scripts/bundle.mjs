/**
 * Bundle the standalone MCP server into one self-contained ES module,
 * dist/zennotes-mcp.mjs, that `node` runs on any platform with no
 * node_modules beside it.
 *
 * Everything is inlined: the MCP SDK, the desktop app's MCP core
 * (desktop/src/mcp and the CLI's vault backends it uses) and the shared
 * domain package. Only Node built-ins stay external. After bundling, the
 * output is copied to an empty temporary directory and run there, because a
 * stray external import is only visible where nothing can resolve it.
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageDir, '../..')

/** The path aliases the desktop sources are written against. */
const ALIASES = {
  '@desktop/': join(repoRoot, 'apps/desktop/src/'),
  '@shared/': join(repoRoot, 'packages/shared-domain/src/'),
  '@bridge-contract/': join(repoRoot, 'packages/bridge-contract/src/')
}

const aliasPlugin = {
  name: 'zennotes-aliases',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@(desktop|shared|bridge-contract)\// }, async (args) => {
      const prefix = Object.keys(ALIASES).find((p) => args.path.startsWith(p))
      // An absolute, platform-native path; esbuild then applies the usual
      // extension (.ts) and index resolution to it.
      const target = resolve(ALIASES[prefix], args.path.slice(prefix.length))
      const result = await pluginBuild.resolve(target, {
        kind: args.kind,
        resolveDir: packageDir
      })
      if (result.errors.length > 0) return { errors: result.errors }
      return { path: result.path }
    })
  }
}

export async function buildBundle({ outfile = join(packageDir, 'dist/zennotes-mcp.mjs') } = {}) {
  const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const result = await build({
    entryPoints: [join(packageDir, 'src/bin.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    logLevel: 'warning',
    define: { __ZENNOTES_MCP_VERSION__: JSON.stringify(pkg.version) },
    // Bundled CommonJS dependencies (ajv, among others) call require() for
    // Node built-ins; an ES module has no require of its own to give them.
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __zennotesCreateRequire } from 'node:module';",
        'const require = __zennotesCreateRequire(import.meta.url);'
      ].join('\n')
    },
    plugins: [aliasPlugin]
  })
  if (result.errors.length > 0) throw new Error('esbuild reported errors')
  // Runnable as ./zennotes-mcp.mjs on Linux and macOS (the shebang finds node).
  await chmod(outfile, 0o755)
  return { outfile, version: pkg.version }
}

/** Run the bundle from a directory with no node_modules anywhere above it
 *  that could hide a missing dependency. */
export async function verifyBundle(outfile, expectedVersion) {
  const dir = await mkdtemp(join(tmpdir(), 'zennotes-mcp-verify-'))
  try {
    const copy = join(dir, 'zennotes-mcp.mjs')
    await copyFile(outfile, copy)
    const version = execFileSync(process.execPath, [copy, '--version'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' }
    }).trim()
    if (version !== expectedVersion) {
      throw new Error(`Bundle reported version "${version}", expected "${expectedVersion}"`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
