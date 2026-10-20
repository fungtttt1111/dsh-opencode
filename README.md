# dsh-opencode

OpenCode Zen's **free models** inside **DeepSeek Harness** — installed as a real DSH plugin, with **no API key**.

The plugin starts a small loopback relay that talks to Zen exactly like the official OpenCode CLI does, adds an `OpenCode Zen (free)` provider to the model picker, keeps the free-model list in step with the gateway, and exposes each model's real reasoning-effort levels.

## What it does

- Registers itself on the **Plugins** page as a normal DSH plugin bundle.
- Starts the relay **inside the DSH host** — no extra window, service, login item, or external process.
- Ships a seed provider so the free models are present on the very first boot, then keeps the provider in the profile's user patch (`cordis.patch.yml`) in step.
- Refreshes the free-model list from the gateway **at start**, **every 6 hours**, and **on demand**.
- Maps `reasoningEfforts` for each model to the wire `reasoning_effort` DSH sends, so the effort picker shows the levels that model actually supports.
- Stores no key, token, account, or credential. The relay listens on `127.0.0.1` only.

## Requirements

- DeepSeek Harness Desktop with the Plugins page (0.2.x).
- Internet access to `opencode.ai` (gateway) and `models.dev` (model metadata).

## Install

1. Open **Plugins → Add plugin**.
2. Paste this repository's Git address — copy it from your browser's address bar (the page you are reading this on).
3. Click **Install**, then **Enable now** when it finishes.
4. If DSH asks for a restart (profiles without HMR), restart it once.
5. Open the model picker and choose **OpenCode Zen (free)**.

On activation the plugin writes the provider into

```
~/.dsh/profiles/<profile>/cordis.patch.yml
```

between the `# >>> zen-sync:models` and `# <<< zen-sync:models` markers, and chooses a starter free model only when the profile has no `agent-default-model` yet. Your own default provider is never replaced. The bundle layer already seeds the same provider so the model picker works on the first boot; the user patch is the durable, synced copy.

### Other profiles (CLI)

For a profile that is not the app-managed `desktop` one:

```sh
dsh plugin --profile <name> add <this-repository-url>
dsh --profile <name> --dump-config    # optional: check the composed profile
```

## Models and effort

- A free model is any gateway model whose id ends in `-free`.
- Names, context window, output cap, image input, and reasoning levels come from the `opencode` catalog on `models.dev`; a model with no catalog entry still works from its gateway id.
- Only declared effort levels are shown. Models with no declaration send no `reasoning_effort` and keep the gateway default.

## Model-list sync

The list is refreshed:

- when the plugin starts,
- every 6 hours,
- and on `GET http://127.0.0.1:9360/sync`.

Only the block between the zen-sync markers is rewritten, and only when it changed. If the selected default model disappears, the marker line `# zen-sync:default` lets the sync move it to the first available free model.

## Port

The default is `9360`. If the port is already served by this version of the relay, the plugin reuses it. If another program (including a relay left by an older install) owns it, the plugin binds a free loopback port and writes that URL into the provider, so no manual configuration is needed. The chosen port is remembered in the user patch, so it stays put across restarts.

## Privacy and safety

- The relay listens on `127.0.0.1` only.
- No API key, auth token, account, or credential is read or stored.
- Project and session ids are generated locally and randomly each run.
- The log is metadata only (`dsh-opencode-relay.log` in the system temp directory): model, status, timing, counts. No message bodies.
- Chat content is forwarded to `opencode.ai`; that is the service being used.

## Notes and limits

- Free-tier availability, quotas, and rate limits are controlled by OpenCode Zen, not by this plugin.
- The gateway occasionally cold-starts a free model with a transient `Endpoint is unavailable`; the relay retries briefly before surfacing an error.
- OpenCode can rename or retire models at any time; the sync follows the gateway.
- This project is not affiliated with OpenCode or DeepSeek.

## Uninstall

1. **Plugins → dsh-opencode → Remove** (or switch the bundle off).
2. Optional cleanup: in `~/.dsh/profiles/<profile>/cordis.patch.yml`, delete the `llm-pi-ai` entry that contains the zen-sync markers. The plugin keeps a one-time backup at `cordis.patch.yml.bak-dsh-opencode`.
3. Restart DSH.

Leaving the block in place is harmless apart from the model picker still listing models whose relay is no longer running.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin: relay lifecycle, profile patch provisioning, sync timer |
| `zen-relay.mjs` | OpenAI-compatible loopback relay + model sync (zero dependencies) |
| `patch-lib.mjs` | Safe, marker-aware text edits for `cordis.patch.yml` |
| `cordis.patch.yml` | Bundle layer: seeds the provider/default model and inserts the host plugin row |
| `zen-tools.json` | Read-tool marker schema used to keep the client identity compatible |
| `locale/*.json`, `icon.svg` | Plugin display metadata |

## License

MIT
