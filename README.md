# streamplace-plays-pokemon

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

The listener subscribes to Jetstream `place.stream.chat.message` and maps chat commands to direct button presses in mGBA via a Lua socket bridge (no OS keybind injection).

It also serves an OBS/browser-source friendly overlay at:

- `http://localhost:8080/overlay` (or `OVERLAY_PORT`)

Default chat command mapping:

- `up` -> `I`
- `down` -> `K`
- `left` -> `J`
- `right` -> `L`
- `a` -> `A`
- `b` -> `B`
- `start` -> `O`
- `select` -> `P`
- `l` -> `L`
- `r` -> `R`

Command syntax:

- Single button: `up`, `a`, `start`, etc.
- Two-button combo: `b+right` (presses both at the same time)
- Extended hold: append `-`, e.g. `up-` or `b+right-`

Environment variables:

- `STREAMER_DID` (default: `did:plc:b6dcapsekrslqcsjavnafgag`)
- `JETSTREAM_URL` (default: `wss://jetstream2.us-east.bsky.network`)
- `KEYPRESS_DURATION_MS` (default: `80`)
- `LONG_KEYPRESS_DURATION_MS` (default: `KEYPRESS_DURATION_MS * 3`)
- `DRY_RUN=1` to log commands without sending key events
- `OVERLAY_PORT` (default: `8080`)
- `SLINGSHOT_URL` (default: `https://slingshot.microcosm.blue`) for DID -> handle/avatar lookup
- `MGBA_HOST` (default: `127.0.0.1`)
- `MGBA_PORT` (default: `8765`)
- `MGBA_SOCKET_TIMEOUT_MS` (default: `1500`)

## mGBA setup (external instance)

1. Open your ROM in mGBA.
2. Load [scripts/mgba-bridge.lua](/Users/matt/dev/mmattbtw/streamplace-plays-pokemon/scripts/mgba-bridge.lua) in mGBA (`Tools` -> `Scripting`).
3. Start this listener with `bun run start`.
4. Keep the mGBA scripting window open while playing.

The TypeScript listener sends lines like `press up 80` to the Lua bridge over TCP, and the Lua script translates those into `emu:addKey` / `emu:clearKey`.
