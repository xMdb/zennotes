import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@desktop': path.resolve(__dirname, '../desktop/src'),
      '@shared': path.resolve(__dirname, '../../packages/shared-domain/src'),
      '@bridge-contract': path.resolve(__dirname, '../../packages/bridge-contract/src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The end-to-end tests build the bundle and spawn it with Node.
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
