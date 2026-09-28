// Replaced with the package version when the bundle is built (see build.mjs).
declare const __ZENNOTES_MCP_VERSION__: string | undefined

export const VERSION: string =
  typeof __ZENNOTES_MCP_VERSION__ === 'string' ? __ZENNOTES_MCP_VERSION__ : '0.0.0-dev'
