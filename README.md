# dsh-opencode — OpenCode Zen free models for DeepSeek Harness

A small local relay that lets **DeepSeek Harness (DSH)** use **OpenCode Zen's
free models without an API key**. One-command install, automatic model-list
updates, reasoning-effort support.

## What it does

- Runs a local relay on `127.0.0.1:9360` that re-shapes requests the same way
  the official OpenCode CLI does for Zen's keyless free tier (identity
  headers, `stream: true`, and a tool named `read`).
- Adds a provider named **"OpenCode Zen (free)"** to your DSH profile.
- Keeps the model list in sync with Zen: at relay start, every 6 hours, and on
  demand. New free models appear and retired ones disappear automatically.

## Requirements

- Windows 10/11 (DSH desktop)
- Node.js **20 or newer** in PATH (`node -v`)
- Internet access to `opencode.ai` (gateway) and `models.dev` (metadata)

## Install

1. Download or clone this repository.
2. Double-click `install.cmd` (or run `node install.mjs`).
3. Start (or restart) DeepSeek Harness.
4. In the model picker choose **"OpenCode Zen (free)"** and a model.

The installer:

- copies the runtime into `%USERPROFILE%\.dsh\zen-relay`
- adds the `opencode-zen` route to
  `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
  (a timestamped `.bak-*` copy is kept next to it)
- installs the Startup shortcut `dsh-opencode.lnk` (hidden autostart)
- starts the relay and runs the first model sync

Options:

```
node install.mjs --help
  --profile <name>   DSH profile (default: desktop)
  --patch <file>     explicit patch path
  --port <n>         relay port (default: 9360; custom ports skip autostart)
  --no-default       do not touch agent-default-model
  --no-autostart     do not create the logon shortcut
  --no-start         do not start the relay
  --dry-run          preview, write nothing
  --print-patch      print the patch block and exit (manual installs)
```

## Automatic model updates

The model list lives between two markers in the profile patch:

```yaml
        models:
          # >>> zen-sync:models
          ... entries ...
          # <<< zen-sync:models
```

On each sync the relay reads the live `-free` list from the gateway, enriches
it (display name, context window, max output, image input, reasoning levels)
from `models.dev`, and rewrites only that block. The file is written only when
something changed, and DSH hot-applies the patch — no restart needed.

If the current default model is retired, the `agent-default-model` line tagged
`# zen-sync:default` falls back to the first available model.

Manual trigger:

```
curl http://127.0.0.1:9360/sync
```

## Files and locations

```
%USERPROFILE%\.dsh\zen-relay\
  zen-relay.mjs          relay + model sync
  zen-tools.json         captured tool definitions (gateway marker)
  patch-lib.mjs          patch-editing helpers
  prep-patch-markers.mjs marker repair tool
  run-relay.cmd          watchdog/supervisor loop
  start-hidden.vbs       starts the supervisor hidden
  zen-relay.log          request metadata (no chat content)
  relay-stdout.log       supervisor output
```

Start hidden by double-clicking `start-hidden.vbs` or the Startup shortcut.
To stop, end the `node.exe` process running `zen-relay.mjs` in Task Manager.
Delete the shortcut to disable autostart.

## Privacy and security

- **No API key** is used or stored anywhere.
- The relay listens on `127.0.0.1` only; it is not reachable from the network.
- It contacts only `opencode.ai` and `models.dev`.
- Logs contain request metadata (model, message/tool counts, status, timing) —
  never chat content.
- The free tier is unofficial use of OpenCode's gateway; use at your own risk
  and respect the service's terms.

## Uninstall

1. Delete the Startup shortcut `dsh-opencode.lnk`.
2. End the relay process and delete `%USERPROFILE%\.dsh\zen-relay`.
3. Restore the patch backup (`cordis.patch.yml.bak-*`) or remove the
   `llm-pi-ai` and `agent-default-model` entries the installer added.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `403 FreeTierError` | The gateway rejected the request shape or the exit IP. Some VPN exit IPs are refused by the free-tier guard — if 403s only happen with a VPN on, try another VPN location. Also make sure the relay is running and restart it after editing files. |
| `429 FreeUsageLimitError` | Short-window rate limit; wait a bit and retry. |
| `Connection refused` | The relay is not running: start `start-hidden.vbs`. |
| Model list missing or stale | Check `zen-relay.log` for a `sync` line. `no-markers` means the sync markers were removed — run `node prep-patch-markers.mjs <patch>`. Sync needs internet. |
| Port 9360 already in use | Stop the other program, or run the relay with `ZEN_RELAY_PORT=<port>` and change the provider `baseURL` in the patch to match. |
| `node` not found | Install Node.js 20+ from https://nodejs.org. |

## Manual install

`node install.mjs --print-patch` prints the YAML block without touching
anything. Paste it into the profile patch, keep the markers, and start the
relay manually.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ZEN_RELAY_PORT` | relay port (default 9360) |
| `ZEN_PATCH` | patch file the sync maintains |
| `ZEN_SYNC=off` | disable the model sync |
| `ZEN_SYNC_INTERVAL_MS` | sync period (default 6 h) |
| `ZEN_RELAY_DEBUG=1` | also print log lines to stdout |
| `ZEN_RELAY_DUMP=1` | dump the last shaped request to `zen-relay-dump.json` |
| `ZEN_RELAY_PROJECT` | fixed project id (default: random per run) |
| `ZEN_RELAY_UPSTREAM` | alternate gateway base URL |
| `ZEN_CATALOG_URL` | alternate metadata catalog URL |

## License

MIT — see `LICENSE`.
