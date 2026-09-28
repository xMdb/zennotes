# zennotes-mcp: the ZenNotes MCP server, standalone

`zennotes-mcp` is the ZenNotes MCP server as a single Node.js file. It does not
need the desktop app, Electron or a POSIX shell, so it runs the same way on
Windows, Linux (including WSL) and macOS. Point it at:

- a **ZenNotes server** (a remote vault), with its auth token, or
- a **vault folder** on the same machine.

The tools, their behaviour and the instructions given to the model are the
desktop app's own (`apps/desktop/src/mcp`), compiled into this file at build
time. An agent sees the same 34 tools whether it was set up from the desktop
app (`zn mcp`) or from this package.

## Requirements

Node.js 20 or newer, on the machine where the agent runs the server.

## Build and install

From a checkout of this repository:

```sh
npm ci
npm run build --workspace @zennotes/mcp-server
```

This writes `apps/mcp-server/dist/zennotes-mcp.mjs`. That one file is the whole
program. It has no dependencies, so you can copy it anywhere (another machine,
into WSL, next to your agent) and run it with `node zennotes-mcp.mjs`.

To get a `zennotes-mcp` command on your `PATH` instead (npm makes a `.cmd`
shim for it on Windows):

```sh
npm pack --workspace @zennotes/mcp-server          # builds and writes zennotes-mcp-server-<version>.tgz
npm install -g ./zennotes-mcp-server-<version>.tgz
zennotes-mcp --version
```

## Check the connection first

`--check` connects once, prints what `vault_info` would tell the agent, and
exits with 0 on success or 1 on failure. Use it to test the URL and token
before you put them in an agent config:

```sh
zennotes-mcp --server https://notes.example.com --token-file ~/.config/zennotes/token --check
```

## Options

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--server <url\|name>` | `ZENNOTES_SERVER` | ZenNotes server URL (`https://notes.example.com`, `192.168.1.20:7878`), or the name of a server saved in the desktop app. A URL with no scheme gets `http://`. |
| `--token <token>` | `ZENNOTES_REMOTE_TOKEN` | The server's auth token (the one the server was started with as `ZENNOTES_AUTH_TOKEN`). Sent as `Authorization: Bearer`. |
| `--token-file <path>` | `ZENNOTES_REMOTE_TOKEN_FILE` | Read the token from a file (first non-empty line; BOM, CRLF and whitespace are ignored). Keeps the token out of agent configs and process lists. |
| `--vault <path\|name>` | `ZENNOTES_VAULT` | A vault folder on this machine instead of a server. |
| `--transport stdio\|http` | `ZENNOTES_MCP_TRANSPORT` | `stdio` (default) for agents that start the server themselves. `http` serves MCP Streamable HTTP at `http://<host>:<port>/mcp`. |
| `--host <addr>` | `ZENNOTES_MCP_HOST` | HTTP listen address. Default `127.0.0.1`. |
| `--port <n>` | `ZENNOTES_MCP_PORT` | HTTP listen port. Default `7879`. |
| `--http-token <token>` | `ZENNOTES_MCP_HTTP_TOKEN` | Require `Authorization: Bearer <token>` from MCP clients. Required for a non-loopback `--host`. |
| `--http-token-file <path>` | `ZENNOTES_MCP_HTTP_TOKEN_FILE` | Read that token from a file. |
| `--http-no-auth` | | Allow a non-loopback `--host` without `--http-token`. Anyone who can reach the port can then use your vault. |
| `--check` | | Connect once, report, exit. |

Token precedence, highest first: `--token`, `--token-file`,
`ZENNOTES_REMOTE_TOKEN`, `ZENNOTES_REMOTE_TOKEN_FILE`, then a token saved with a
desktop-app server profile.

With neither `--server` nor `--vault`, the server follows `ZENNOTES_SERVER`,
then `ZENNOTES_VAULT`, then the vault the ZenNotes desktop app has open on this
machine, if it is installed.

stdout carries only the MCP protocol. Status and errors go to stderr, which
MCP clients keep in their logs. The token is never printed. When a token is
sent over plain `http://` to a host that is not this machine, a warning is
printed; use `https://` if the network is not one you trust. A stdio server
exits when its client closes stdin, so no stray process is left behind.

## Agent configuration

### Hermes Agent

In `~/.hermes/config.yaml`. Keep the token in `~/.hermes/.env`
(`ZENNOTES_TOKEN=...`); Hermes substitutes `${ZENNOTES_TOKEN}` from there.

```yaml
mcp_servers:
  zennotes:
    command: node
    args:
      - /home/me/bin/zennotes-mcp.mjs
      - --server
      - https://notes.example.com
    env:
      ZENNOTES_REMOTE_TOKEN: ${ZENNOTES_TOKEN}
```

### Claude Desktop, Claude Code, Cursor and other JSON configs

Linux / WSL / macOS:

```json
{
  "mcpServers": {
    "zennotes": {
      "command": "node",
      "args": ["/home/me/bin/zennotes-mcp.mjs", "--server", "https://notes.example.com"],
      "env": { "ZENNOTES_REMOTE_TOKEN": "your-server-token" }
    }
  }
}
```

Windows (JSON needs doubled backslashes):

```json
{
  "mcpServers": {
    "zennotes": {
      "command": "node",
      "args": [
        "C:\\Users\\me\\zennotes\\zennotes-mcp.mjs",
        "--server", "https://notes.example.com",
        "--token-file", "C:\\Users\\me\\zennotes\\token.txt"
      ]
    }
  }
}
```

If you installed the package globally, use `"command": "zennotes-mcp"` and drop
the script path from `args`. On Windows, if a client cannot find a command on
`PATH`, give the full path to `node.exe` as the command.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.zennotes]
command = "node"
args = ["/home/me/bin/zennotes-mcp.mjs", "--server", "https://notes.example.com"]
env = { ZENNOTES_REMOTE_TOKEN = "your-server-token" }
```

## WSL and Windows

**Agent in WSL, notes on a ZenNotes server.** Install Node.js inside WSL, copy
`zennotes-mcp.mjs` into WSL and use the stdio config above. The `--server` URL
has to be reachable from inside WSL. A server running on the Windows host is
usually *not* reachable at `localhost` from WSL 2 (unless WSL's mirrored
networking mode is on). Use the Windows host's address instead: the gateway
printed by `ip route show default` inside WSL, or the host's LAN IP. The ZenNotes
server must also listen on that interface (`ZENNOTES_BIND=0.0.0.0:7878`) and
be allowed through the Windows firewall. Run `--check` from inside WSL to
confirm.

**Agent in WSL, MCP server on Windows.** Run the server on Windows over HTTP and
point the agent at its URL:

```powershell
node C:\Users\me\zennotes\zennotes-mcp.mjs --server http://127.0.0.1:7878 --token-file C:\Users\me\zennotes\token.txt `
  --transport http --host 0.0.0.0 --port 7879 --http-token-file C:\Users\me\zennotes\mcp-token.txt
```

```yaml
# ~/.hermes/config.yaml in WSL
mcp_servers:
  zennotes:
    url: http://<windows-host-ip>:7879/mcp
    headers:
      Authorization: Bearer ${ZENNOTES_MCP_TOKEN}
```

The HTTP transport needs `--http-token` whenever it listens on anything but
loopback. On a loopback address it answers only requests addressed to
`localhost` and rejects cross-origin browser requests, so a web page cannot
reach it. `GET /healthz` answers `{"ok":true}` without auth for supervisors.
Each MCP client gets its own session. A session unused for 12 hours is closed,
and a client coming back after that starts a new one.

## Development

```sh
npm run test:run --workspace @zennotes/mcp-server    # unit + end-to-end tests
npm run typecheck --workspace @zennotes/mcp-server
```

The end-to-end tests build the bundle into an empty directory, start it with
`node` the way an MCP client does, and drive it over stdio and HTTP against a
token-protected stand-in for the ZenNotes server API.

`src/` holds only what is specific to running standalone: option parsing
(`options.ts`), vault resolution glue (`target.ts`), the HTTP transport
(`http.ts`) and the entry point (`cli.ts`, `bin.ts`). Tool changes belong in
`apps/desktop/src/mcp`, and this package picks them up on its next build.
