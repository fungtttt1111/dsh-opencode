#!/usr/bin/env node
// dsh-opencode installer — adds OpenCode Zen's free models to DeepSeek
// Harness on this machine:
//   1. copies the relay runtime into  ~/.dsh/zen-relay
//   2. adds/repairs the `opencode-zen` provider route in the DSH profile patch
//   3. optionally installs a logon shortcut that starts the relay hidden
//   4. starts the relay and triggers a model-list sync
//
// Nothing is downloaded except the model list (from opencode.ai + models.dev);
// the relay itself has no dependencies. No API key is used or stored.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { applyPluginToPatch, defaultEntryLines, providerEntryLines, PATCH_HEADER } from "./patch-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";
const DEFAULT_PORT = 9360;
const RUNTIME_FILES = [
  "zen-relay.mjs",
  "zen-tools.json",
  "patch-lib.mjs",
  "prep-patch-markers.mjs",
  "run-relay.cmd",
  "start-hidden.vbs",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const o = {
    port: DEFAULT_PORT,
    profile: "desktop",
    patch: null,
    setDefault: true,
    autostart: true,
    start: true,
    dryRun: false,
    printPatch: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--print-patch") o.printPatch = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-default") o.setDefault = false;
    else if (a === "--no-autostart") o.autostart = false;
    else if (a === "--no-start") o.start = false;
    else if (a === "--patch") o.patch = argv[++i];
    else if (a === "--profile") o.profile = argv[++i];
    else if (a === "--port") o.port = Number(argv[++i]);
    else {
      console.error(`unknown option: ${a}`);
      o.help = true;
    }
  }
  return o;
}

function help() {
  console.log(`dsh-opencode ${VERSION} — OpenCode Zen free models for DeepSeek Harness

Usage: node install.mjs [options]

Options:
  --patch <file>     DSH profile patch to edit
                     (default: ~/.dsh/profiles/$PROFILE/cordis.patch.yml)
  --profile <name>   DSH profile name (default: desktop)
  --port <n>         relay port (default: ${DEFAULT_PORT}; custom ports skip autostart)
  --no-default       do not touch the agent-default-model entry
  --no-autostart     do not create the logon shortcut
  --no-start         do not start the relay after installing
  --dry-run          show what would change without writing anything
  --print-patch      print the patch block and exit (manual installs)
  -h, --help         this text`);
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.service === "zen-relay" ? j : null;
  } catch {
    return null;
  }
}

async function waitHealthy(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const h = await health(port);
    if (h) return h;
    await sleep(400);
  }
  return null;
}

function killListener(port) {
  if (platform() !== "win32") return false;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) {
        execFileSync("taskkill", ["/F", "/PID", m[1]], { stdio: "ignore" });
        return true;
      }
    }
  } catch {
    /* fall through */
  }
  return false;
}

function installAutostart(runtimeDir) {
  if (platform() !== "win32") return { ok: false, reason: "logon shortcut is Windows-only" };
  const startup = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  if (!process.env.APPDATA || !existsSync(startup)) return { ok: false, reason: "Startup folder not found" };

  const lnk = join(startup, "dsh-opencode.lnk");
  const vbs = join(runtimeDir, "start-hidden.vbs");
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const cmd =
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${q(lnk)}); ` +
    `$s.TargetPath=${q(wscript)}; ` +
    `$s.Arguments=${q(`"${vbs}"`)}; ` +
    `$s.WorkingDirectory=${q(runtimeDir)}; ` +
    `$s.WindowStyle=1; $s.Save()`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { stdio: "ignore" });
    return { ok: true, path: lnk };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 160) };
  }
}

function spawnRelay(runtimeDir, patchPath, port) {
  const child = spawn(process.execPath, [join(runtimeDir, "zen-relay.mjs")], {
    cwd: runtimeDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ZEN_PATCH: patchPath, ZEN_RELAY_PORT: String(port) },
  });
  child.unref();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  if (opts.printPatch) {
    console.log([...PATCH_HEADER, ...providerEntryLines(opts.port), ...defaultEntryLines()].join("\n"));
    return;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error("invalid --port");
    process.exit(2);
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    console.error(`Node.js 20+ is required (this is ${process.version}).`);
    process.exit(1);
  }

  const home = homedir();
  const runtimeDir = join(home, ".dsh", "zen-relay");
  const patchPath = opts.patch ? resolve(opts.patch) : join(home, ".dsh", "profiles", opts.profile, "cordis.patch.yml");

  console.log(`dsh-opencode ${VERSION}`);
  console.log(`  runtime : ${runtimeDir}`);
  console.log(`  patch   : ${patchPath}`);
  console.log(`  port    : ${opts.port}`);
  if (opts.dryRun) console.log("  mode    : dry run (nothing is written or started)");

  // 1) runtime files -------------------------------------------------------
  if (!opts.dryRun) mkdirSync(runtimeDir, { recursive: true });
  let copied = 0;
  for (const f of RUNTIME_FILES) {
    const src = join(HERE, f);
    const dst = join(runtimeDir, f);
    if (!existsSync(src)) {
      console.warn(`  warn    : missing file in package: ${f}`);
      continue;
    }
    if (resolve(src) === resolve(dst)) continue;
    if (!opts.dryRun) copyFileSync(src, dst);
    copied++;
  }
  console.log(`  files   : ${copied} runtime file(s) ${opts.dryRun ? "would be " : ""}copied`);

  // 2) profile patch -------------------------------------------------------
  const existed = existsSync(patchPath);
  const before = existed ? readFileSync(patchPath, "utf8") : "";
  const result = applyPluginToPatch(before, { port: opts.port, setDefault: opts.setDefault });

  if (result.error) {
    console.error(`\nCould not edit the patch automatically: ${result.error}`);
    console.error("Use `node install.mjs --print-patch` and paste the block into the patch by hand.");
    process.exit(1);
  }

  let backupPath = null;
  if (result.changed) {
    if (!opts.dryRun) {
      mkdirSync(dirname(patchPath), { recursive: true });
      if (existed) {
        backupPath = `${patchPath}.bak-${stamp()}`;
        copyFileSync(patchPath, backupPath);
      }
      const tmp = `${patchPath}.tmp-${process.pid}`;
      writeFileSync(tmp, result.text);
      renameSync(tmp, patchPath);
    }
    console.log(`  patch   : ${result.actions.join(", ")}${opts.dryRun ? " (would write)" : ""}`);
    if (backupPath) console.log(`  backup  : ${backupPath}`);
  } else {
    console.log(`  patch   : already up to date (${result.actions.join(", ") || "no changes"})`);
  }

  // 3) logon shortcut ------------------------------------------------------
  if (opts.autostart && !opts.dryRun) {
    if (opts.port !== DEFAULT_PORT) {
      console.log("  autostart: skipped (custom port - start the relay with ZEN_RELAY_PORT yourself)");
    } else {
      const a = installAutostart(runtimeDir);
      console.log(`  autostart: ${a.ok ? "installed " + a.path : "skipped (" + a.reason + ")"}`);
    }
  } else {
    console.log("  autostart: skipped");
  }

  // 4) relay + first sync --------------------------------------------------
  if (!opts.start) {
    console.log("  relay   : not started (--no-start)");
  } else if (opts.dryRun) {
    console.log("  relay   : would be (re)started and synced");
  } else {
    const running = await health(opts.port);
    if (running) {
      console.log("  relay   : restarting to load the installed code");
      killListener(opts.port);
      for (let i = 0; i < 20 && (await health(opts.port)); i++) await sleep(250);
    }
    if (!(await health(opts.port))) spawnRelay(runtimeDir, patchPath, opts.port);
    const up = await waitHealthy(opts.port, 15000);
    if (!up) {
      console.error("  relay   : did not answer on /healthz - check zen-relay.log in the runtime folder");
      process.exit(1);
    }
    let sync = null;
    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/sync`, { signal: AbortSignal.timeout(45000) });
      sync = await r.json();
    } catch (e) {
      sync = { ok: false, error: String(e).slice(0, 160) };
    }
    if (sync && sync.ok) {
      console.log(`  relay   : http://127.0.0.1:${opts.port}  (${sync.free} free model(s) in the patch)`);
      if (sync.added?.length) console.log(`  added   : ${sync.added.join(", ")}`);
      if (sync.removed?.length) console.log(`  removed : ${sync.removed.join(", ")}`);
    } else {
      console.log(`  relay   : running, but the model sync failed (${sync?.error || "unknown"})`);
      console.log("            it will retry every 6 hours, or GET /sync when online");
    }
  }

  console.log(`
Done. Next steps:
  1. Start (or restart) DeepSeek Harness so it re-reads the profile patch.
  2. Pick provider "OpenCode Zen (free)" in the model picker.

The model list updates itself (relay start, every 6 hours, GET /sync).
Logs: ${join(runtimeDir, "zen-relay.log")} (metadata only, no chat content).`);
}

main().catch((e) => {
  console.error("installer failed:", e);
  process.exit(1);
});
