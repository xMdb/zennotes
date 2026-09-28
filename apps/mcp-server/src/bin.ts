import { runCli } from './cli'

/** Exit once stdout and stderr have flushed: writes to a pipe are
 *  asynchronous, and exiting straight away can cut `--check` output short. */
function exitAfterFlush(code: number): void {
  let pending = 2
  const done = (): void => {
    pending -= 1
    if (pending === 0) process.exit(code)
  }
  process.stdout.write('', done)
  process.stderr.write('', done)
}

runCli(process.argv.slice(2)).then(
  (code) => {
    // null: a server is running and owns the process lifetime from here.
    if (code != null) exitAfterFlush(code)
  },
  (err: unknown) => {
    process.stderr.write(
      `[zennotes-mcp] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    )
    exitAfterFlush(1)
  }
)
