// `npm run build`: bundle dist/zennotes-mcp.mjs and prove it runs on its own.
import { buildBundle, verifyBundle } from './bundle.mjs'

const { outfile, version } = await buildBundle()
await verifyBundle(outfile, version)
process.stdout.write(`Built ${outfile} (zennotes-mcp ${version})\n`)
