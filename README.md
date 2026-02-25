# streamplace-plays-pokemon

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run start
```

The listener subscribes to Jetstream `place.stream.chat.message` and maps chat commands to local keyboard input for your emulator.

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

Environment variables:

- `STREAMER_DID` (default: `did:plc:b6dcapsekrslqcsjavnafgag`)
- `JETSTREAM_URL` (default: `wss://jetstream2.us-east.bsky.network`)
- `KEYPRESS_DURATION_MS` (default: `80`)
- `DRY_RUN=1` to log commands without sending key events
- `OVERLAY_PORT` (default: `8080`)
- `SLINGSHOT_URL` (default: `https://slingshot.microcosm.blue`) for DID -> handle/avatar lookup

Platform notes:

- macOS: uses `osascript` via System Events. You must grant Accessibility permission to your terminal/Codex app.
- Linux: uses `xdotool` (`sudo apt install xdotool`).
