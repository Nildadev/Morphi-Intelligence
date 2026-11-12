# Morphi Intelligence

Desktop app for Roblox development: a chat client that drives Roblox Studio through the official Model
Context Protocol server, with a git-like history over every write it makes to your place.

Current version: **1.1.0**.

## Requirements

- Windows 10/11 (the packaged build is a portable executable)
- Node.js `^20.19.0 || >=22.12.0` and npm 10
- Roblox Studio with its built-in MCP server enabled (see [Roblox Studio](#roblox-studio))

## Run it

```bash
npm ci
npm ci --prefix server
npm ci --prefix client

npm run dev
```

`npm run dev` starts the API on `http://127.0.0.1:3000` and the client on `http://localhost:5173`.
In development the server accepts the token `dev-token` in an `X-Morphi-Token` header; the packaged
app generates a fresh token per launch and hands it to the window over IPC.

There is no supported headless mode: the server asks the Electron main process for provider keys, so
`npm run dev` is for UI and API work only.

## Roblox Studio

Morphi talks only to the MCP server shipped inside Roblox Studio, resolved in this order:

1. `%LOCALAPPDATA%\Roblox\mcp.bat`
2. `%LOCALAPPDATA%\Roblox\Versions\version-*\StudioMCP.exe`
3. the `ContentFolder\..\StudioMCP.exe` path recorded in the registry
4. an official `rbx-studio-mcp` binary on `PATH`

No `npx`, no npm-pinned MCP package, no third-party plugin; nothing is downloaded to make MCP work.

1. Open Roblox Studio with a place open.
2. Studio › Assistant › **Manage MCP Servers** › enable the server.
3. In Morphi, Settings › MCP › **Reconnect**. The panel must say the Studio server is linked; when it
   is not, it prints the path it tried and the last error.

The same panel accepts a manual override path, validated against the list above before it is saved to
`settings.json`.

## Where data lives

`%APPDATA%\MorphiIntelligence`:

| File | Contents |
| --- | --- |
| `morphi.db` | SQLite: projects, sessions, and the append-only event log that chat history and undo derive from |
| `settings.json` | UI preferences, MCP path override, title model, provider priority, compaction thresholds |
| `credentials.json` | Provider keys, encrypted with Electron `safeStorage` (Windows DPAPI) |

## Security model

- The server binds to `127.0.0.1` on an OS-assigned port; nothing listens on a routable address.
- Every `/api` request needs `X-Morphi-Token`, a token generated per launch and passed to the renderer
  over IPC — a token is never written to disk or into a URL.
- Provider keys live in `credentials.json` encrypted by `safeStorage`, are read only by the Electron
  main process, and reach the server through the IPC channel. They never enter `localStorage`, a
  renderer bundle, or a log line.
- Writes to your place go through the tool approval gate: every mutating tool call pauses for an
  approve/deny decision, and a denied call is recorded as denied, not as a failure.
- The database is event-sourced. A legacy pre-1.1 database is renamed to `morphi.db.v1.bak` (with its
  WAL/SHM) before a fresh schema is created, so an upgrade never mixes two generations of rows.
- No telemetry, no analytics endpoint, no crash reporter. The only outbound traffic is the model
  provider you configured and Studio's local MCP server.

## Tests

```bash
npm run typecheck                       # server, test files, client build
npm run lint                            # client ESLint
npm test                                # server (vitest) + client (vitest)
npm --prefix client run e2e             # Playwright; needs `npx playwright install`
npm run test:main                       # Electron main process (node:test)
node server/scripts/quit-check.mjs      # real server quits over IPC: exit 0, SQLite closed
```

The server suite keeps a live Studio probe and an end-to-end undo run behind `MORPHI_LIVE_STUDIO=1`:
the probe is skipped without it, and the e2e script needs a real Studio session plus the fake-LLM server
described in `server/scripts/e2e-live-undo.mjs`.

## Build a release

```bash
npm run dist
```

Artifacts: `dist_electron/win-unpacked/Morphi Intelligence.exe` and a portable executable. The final
portable step needs permission to create symlinks while extracting `winCodeSign`, so run it from an
elevated shell or with Windows Developer Mode on; without that privilege the unpacked build is still
produced and runs.

## Known limitations

- Studio's MCP server is beta: it goes away when Studio closes the place, and the app can only report a
  lost connection, not restore it.
- Undo refuses rather than guesses. If an instance the turn touched was renamed, moved or re-parented by
  hand since the turn, the whole turn is refused with the reason and nothing is written.
- Capture is bounded: an instance tree to 200 nodes and 4 levels, a listing to 400 nodes and 5 levels.
  Past a bound the tree is dropped rather than captured approximately, and that turn reports
  non-restorable instead of restorable-from-a-partial-picture.
- `Terrain` and properties Studio locks to plugins are not restorable; they are listed as skipped for
  the turn.

## License

ISC. See [LICENSE](LICENSE).

## Acknowledgments

- Roblox's own MCP server, the only bridge Morphi uses.
- [Model Context Protocol](https://modelcontextprotocol.io/) for the protocol itself.
