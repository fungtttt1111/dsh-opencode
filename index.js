// index.js — DSH host plugin for the OpenCode Zen free-model relay.
//
// Installed as a profile plugin bundle (package.json -> dsh.bundle.patch).
// On activation it:
//   1. starts the local Zen relay on 127.0.0.1 (in-process, no child window),
//   2. provisions the keyless `opencode-zen` provider in the profile's user
//      patch (cordis.patch.yml) when it is not there yet,
//   3. refreshes the model list from the gateway now and every six hours.
//
// The relay only listens on loopback. No API key is used or stored.

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startModelSync, startRelay, probeRelay, log, RELAY_VERSION } from "./zen-relay.mjs";
import { applyPluginToPatch, setPatchPort } from "./patch-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 9360;

export const name = "dsh-opencode";

// ---------------------------------------------------------------------------
// Profile discovery. A real install lives under
// <profile>/node_modules/.pnpm/dsh-opencode@.../node_modules/dsh-opencode, so
// walking up to the directory that owns a profile `dsh.profile` manifest finds
// the profile. The package directory itself also has package.json and
// cordis.patch.yml (the bundle patch), so it must never be accepted as a
// profile; every candidate is checked for `dsh.profile`.
// ---------------------------------------------------------------------------
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function isProfileDir(dir) {
  if (!dir) return false;
  if (!existsSync(join(dir, "cordis.patch.yml"))) return false;
  const pkg = readJson(join(dir, "package.json"));
  return !!(pkg && pkg.dsh && pkg.dsh.profile);
}

function findProfileDir() {
  const env = process.env;
  if (env.DSH_PROFILE_DIR) return resolve(env.DSH_PROFILE_DIR);

  const home = env.DSH_HOME || join(homedir(), ".dsh");
  const names = [];
  if (env.DSH_PROFILE) names.push(env.DSH_PROFILE);
  const ai = process.argv.indexOf("--profile");
  if (ai >= 0 && process.argv[ai + 1] && !process.argv[ai + 1].startsWith("-")) names.push(process.argv[ai + 1]);
  for (const name of names) {
    const dir = join(home, "profiles", name);
    if (isProfileDir(dir)) return dir;
  }

  // A linked (local-directory) install keeps this module outside the profile;
  // find the profile that declares this package instead.
  try {
    for (const name of readdirSync(join(home, "profiles"))) {
      const dir = join(home, "profiles", name);
      const pkg = readJson(join(dir, "package.json"));
      if (!pkg) continue;
      const deps = pkg.dependencies || {};
      const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
      if (deps["dsh-opencode"] || bundles.includes("dsh-opencode")) return dir;
    }
  } catch { /* no profiles directory */ }

  // Packed and git installs sit inside the profile's node_modules; walk up.
  // Start above this package so its own manifest can never match.
  let dir = dirname(HERE);
  for (let i = 0; i < 8; i++) {
    if (isProfileDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Profile patch provisioning
// ---------------------------------------------------------------------------
function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function ensurePatch(patchPath, port, setDefault) {
  let before = "";
  try {
    before = readFileSync(patchPath, "utf8");
  } catch {
    before = "";
  }

  const r = applyPluginToPatch(before, { port, setDefault });
  if (r.error) return { ok: false, reason: r.error, actions: r.actions };

  let text = r.text;

  // The provider may already exist from an earlier run; keep its loopback URL
  // in step with the port this process actually bound.
  const p = setPatchPort(text, port);
  if (p.changed) text = p.text;

  const changed = text !== before;
  if (changed) {
    if (before && !existsSync(`${patchPath}.bak-dsh-opencode`)) {
      try { copyFileSync(patchPath, `${patchPath}.bak-dsh-opencode`); } catch { /* best effort */ }
    }
    writeAtomic(patchPath, text);
  }
  return { ok: true, changed, actions: r.actions, patchPath };
}

// ---------------------------------------------------------------------------
// Relay acquisition. The profile's user patch records the port the provider
// actually points at; prefer it so a fallback port stays stable across boots.
// A port is reused only when its /healthz reports this relay version, so a
// stale relay from an older install is never mistaken for ours.
// ---------------------------------------------------------------------------
function readPatchPort(patchPath) {
  try {
    const text = readFileSync(patchPath, "utf8");
    const m = text.match(/baseURL:\s*["']?http:\/\/127\.0\.0\.1:(\d+)\/v1/);
    const n = m ? Number(m[1]) : NaN;
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

async function acquireRelay(port) {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
  const existing = await probeRelay(port);
  if (existing) {
    if (existing.version === RELAY_VERSION) {
      log({ t: "reuse", port, session: existing.session || null });
      return { port, external: true, close: async () => {} };
    }
    log({ t: "skip", port, reason: "incompatible-relay", version: existing.version || null });
    return null;
  }
  try {
    return await startRelay({ port });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      log({ t: "skip", port, reason: "port-in-use" });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export async function apply(ctx, config = {}) {
  const wanted = Number(config && config.port);
  const port = Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : DEFAULT_PORT;
  const syncEnabled = !config || config.sync !== false;

  const profileDir = findProfileDir();
  const patchPath = profileDir ? join(profileDir, "cordis.patch.yml") : null;

  const candidates = [];
  const patchPort = patchPath ? readPatchPort(patchPath) : null;
  if (patchPort) candidates.push(patchPort);
  if (port !== patchPort) candidates.push(port);

  let relay = null;
  for (const candidate of candidates) {
    relay = await acquireRelay(candidate);
    if (relay) break;
  }
  if (!relay) relay = await startRelay({ port: 0 });

  let sync = null;

  if (patchPath) {
    const r = ensurePatch(patchPath, relay.port, config ? config.setDefault !== false : true);
    log({ t: "provision", port: relay.port, patch: patchPath, changed: r.changed, actions: r.actions, error: r.reason });
    if (r.ok && syncEnabled) {
      sync = startModelSync({ patchPath, intervalMs: Number(config && config.syncIntervalMs) || undefined });
    }
  } else {
    log({ t: "provision", port: relay.port, patch: null, error: "profile directory not found" });
  }

  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    try { sync && sync.stop(); } catch { /* ignore */ }
    try { relay.close(); } catch { /* ignore */ }
  };

  if (typeof ctx.effect === "function") ctx.effect(() => dispose);
  else if (typeof ctx.on === "function") ctx.on("dispose", dispose);
}
