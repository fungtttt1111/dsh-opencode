// zen-relay.mjs — OpenCode Zen shaping relay for DeepSeek Harness
//
// Runs inside the DSH host (imported by index.js) or standalone:
//   node zen-relay.mjs
//
// It reshapes each request to match what the official OpenCode CLI sends, so
// the keyless free tier answers exactly as it does for the real client:
//   endpoint  POST https://opencode.ai/inference/openai/v1/chat/completions
//   identity  Authorization: Bearer public  (the CLI's keyless free-tier token)
//   headers   x-opencode-client/project/session quartets + b3/traceparent
//   markers   a tool named "read" present and stream:true
//
// Endpoints:
//   POST  * /v1/chat/completions   chat; SSE passthrough or buffered JSON
//   GET   * /v1/models             models proxied from Zen, 5-minute cache
//   GET   /sync                    refresh the profile model list now
//   GET   /healthz                 liveness
//
// Zero dependencies; Node 20+. Listens on 127.0.0.1 only.

import { createServer } from "node:http";
import { appendFileSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

const ZEN_BASE = process.env.ZEN_RELAY_UPSTREAM || "https://opencode.ai";
const ZEN_CHAT = `${ZEN_BASE}/inference/openai/v1/chat/completions`;
// Bumped when the relay contract changes. The host plugin only reuses a relay
// on the requested port when its /healthz reports the same version, so an old
// relay left by a previous install can never be mistaken for this one.
export const RELAY_VERSION = 2;
const ZEN_MODELS = `${ZEN_BASE}/zen/v1/models`;
let LOG_FILE = process.env.ZEN_RELAY_LOG || join(tmpdir(), "dsh-opencode-relay.log");

// ---------------------------------------------------------------------------
// Client identity (shape is what the gateway checks; ids are random per run)
// ---------------------------------------------------------------------------
const CLIENT_UA = "opencode/latest/2.0.28/cli";
const FREE_TOKEN = "Bearer public";

const B62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const pick = (alphabet, n) => Array.from({ length: n }, () => alphabet[randomBytes(1)[0] % alphabet.length]).join("");
const hex = (n) => pick(HEX, n);

// Project ids are client-generated; a fresh random id looks like a new CLI
// project. Set ZEN_RELAY_PROJECT to pin a specific value.
const CLIENT_PROJECT = process.env.ZEN_RELAY_PROJECT || hex(32);

// The CLI builds session ids as "ses_" + the six big-endian bytes of the
// 48-bit complement of (Date.now() * 4096 + sequence), plus 14 base62 chars.
let idLastMs = 0;
let idSeq = 0;
function makeSessionId() {
  const now = Date.now();
  if (now !== idLastMs) { idLastMs = now; idSeq = 0; }
  idSeq++;
  const n = (BigInt(now) * 4096n + BigInt(idSeq)) & 0xffffffffffffn;
  const a = (~n) & 0xffffffffffffn;
  return `ses_${a.toString(16).padStart(12, "0")}${pick(B62, 14)}`;
}
let sessionId = makeSessionId();
let sessionBornAt = Date.now();
const SESSION_LIFETIME_MS = 5 * 60 * 1000;

function identityHeaders() {
  if (Date.now() - sessionBornAt > SESSION_LIFETIME_MS) {
    sessionId = makeSessionId();
    sessionBornAt = Date.now();
  }
  const traceId = hex(32);
  const spanId = hex(16);
  const parentId = hex(16);
  return {
    "user-agent": CLIENT_UA,
    "x-opencode-client": "cli",
    "x-opencode-project": CLIENT_PROJECT,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
    b3: `${traceId}-${spanId}-1-${parentId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

// ---------------------------------------------------------------------------
// Gate marker: the official client always advertises a tool named "read".
// ---------------------------------------------------------------------------
let MARKER_READ = { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } } };
try {
  const captured = JSON.parse(readFileSync(join(HERE, "zen-tools.json"), "utf8"));
  const real = (captured.tools || []).find((t) => t?.function?.name === "read");
  if (real) MARKER_READ = real;
} catch { /* keep stub */ }

const hasToolNamedRead = (tools) =>
  Array.isArray(tools) && tools.some((t) => (t?.function?.name || t?.name) === "read");

// ---------------------------------------------------------------------------
// Logging (one metadata line per request; bodies are never logged)
// ---------------------------------------------------------------------------
export function setLogFile(path) {
  if (typeof path === "string" && path.trim()) LOG_FILE = path;
}

export function log(obj) {
  const line = `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`;
  try {
    if (existsSync(LOG_FILE) && readFileSync(LOG_FILE).length > 8 * 1024 * 1024) {
      writeFileSync(LOG_FILE, "");
    }
    appendFileSync(LOG_FILE, line);
  } catch { /* logging must never break serving */ }
  if (process.env.ZEN_RELAY_DEBUG) process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// Body shaping
// ---------------------------------------------------------------------------
function shapeBody(incoming) {
  const out = {};
  for (const k of ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed", "stop", "tool_choice", "parallel_tool_calls", "response_format", "user", "metadata", "logit_bias", "reasoning_effort"]) {
    if (incoming[k] !== undefined) out[k] = incoming[k];
  }
  out.model = incoming.model;
  out.messages = incoming.messages;

  let tools = Array.isArray(incoming.tools) ? incoming.tools.slice() : [];
  if (!hasToolNamedRead(tools)) tools.push(MARKER_READ);
  out.tools = tools;

  out.stream = true; // required by the gateway
  out.stream_options = { include_usage: true };
  out.store = false;
  out.max_completion_tokens = incoming.max_completion_tokens ?? incoming.max_tokens ?? 32000;
  return out;
}

// ---------------------------------------------------------------------------
// SSE -> single JSON completion (for clients that asked stream:false)
// ---------------------------------------------------------------------------
function assembleCompletion(sseText, model) {
  let id = `chatcmpl-${hex(24)}`;
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  let finish = null;
  let usage = null;

  for (const rawEvent of sseText.split(/\r?\n\r?\n/)) {
    const dataLines = rawEvent.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (!dataLines.length) continue;
    const data = dataLines.map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.id) id = chunk.id;
    if (chunk.created) created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    else if (typeof d.reasoning === "string") reasoning += d.reasoning;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id || `call_${hex(16)}`, type: "function", function: { name: "", arguments: "" } });
        const acc = toolCalls.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (calls.length) message.tool_calls = calls;
  if (!content && !calls.length && finish === null) finish = "stop";

  const result = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
  };
  if (usage) result.usage = usage;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}

const upstreamHeaders = (extra = {}) => ({ ...identityHeaders(), ...extra });

async function handleChat(req, res) {
  const started = Date.now();
  let incoming;
  try {
    const raw = await readBody(req);
    incoming = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    sendJson(res, 400, { error: { message: `zen-relay: bad request body (${e.message})` } });
    return;
  }

  const wantStream = incoming.stream === true;
  const shaped = shapeBody(incoming);
  const outHeaders = upstreamHeaders({ "content-type": "application/json", authorization: FREE_TOKEN });
  const outBody = JSON.stringify(shaped);
  if (process.env.ZEN_RELAY_DUMP) {
    try {
      writeFileSync(join(HERE, "zen-relay-dump.json"), JSON.stringify({ at: new Date().toISOString(), headers: outHeaders, bodyLen: outBody.length, body: shaped }, null, 1));
    } catch { /* ignore */ }
  }
  const ctrl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctrl.abort(); });

  let upstream = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      upstream = await fetch(ZEN_CHAT, { method: "POST", headers: outHeaders, body: outBody, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      log({ t: "chat", model: shaped.model, msgs: shaped.messages?.length, tools: shaped.tools?.length, effort: shaped.reasoning_effort || "-", status: "neterr", ms: Date.now() - started, err: String(e).slice(0, 160) });
      sendJson(res, 502, { error: { message: `zen-relay: upstream fetch failed: ${String(e)}` } });
      return;
    }
    if (upstream.ok) break;
    const retryable = upstream.status === 422 || upstream.status === 503 || upstream.status === 429;
    if (!retryable || attempt === 3) break;
    let reason = "";
    try { reason = (await upstream.text()).slice(0, 200); } catch { /* ignore */ }
    log({ t: "retry", model: shaped.model, status: upstream.status, attempt, upstream: reason });
    await new Promise((r) => setTimeout(r, 1200 * attempt));
  }

  const ctype = upstream.headers.get("content-type") || "";
  const isSse = ctype.includes("text/event-stream");

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    log({ t: "chat", model: shaped.model, msgs: shaped.messages?.length, tools: shaped.tools?.length, effort: shaped.reasoning_effort || "-", status: upstream.status, ms: Date.now() - started, upstream: text.slice(0, 200) });
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text || JSON.stringify({ error: { message: `zen-relay: upstream ${upstream.status}` } }));
    return;
  }

  if (wantStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    try {
      if (isSse) {
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
        }
      } else {
        const text = await upstream.text();
        res.write(`data: ${text}\n\ndata: [DONE]\n\n`);
      }
    } catch (e) {
      if (!res.destroyed) { try { res.write(`data: ${JSON.stringify({ error: { message: `zen-relay: stream error ${String(e)}` } })}\n\n`); } catch { /* ignore */ } }
    }
    res.end();
    log({ t: "chat", model: shaped.model, msgs: shaped.messages?.length, tools: shaped.tools?.length, effort: shaped.reasoning_effort || "-", status: 200, stream: true, ms: Date.now() - started });
    return;
  }

  try {
    if (isSse) {
      const text = await upstream.text();
      sendJson(res, 200, assembleCompletion(text, shaped.model));
    } else {
      const text = await upstream.text();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    }
    log({ t: "chat", model: shaped.model, msgs: shaped.messages?.length, tools: shaped.tools?.length, effort: shaped.reasoning_effort || "-", status: 200, stream: false, ms: Date.now() - started });
  } catch (e) {
    sendJson(res, 502, { error: { message: `zen-relay: failed to buffer upstream response: ${String(e)}` } });
  }
}

let modelsCache = { at: 0, body: null, status: 200 };
async function handleModels(res) {
  if (modelsCache.body && Date.now() - modelsCache.at < 5 * 60 * 1000) {
    res.writeHead(modelsCache.status, { "content-type": "application/json; charset=utf-8" });
    res.end(modelsCache.body);
    return;
  }
  try {
    const r = await fetch(ZEN_MODELS, { headers: upstreamHeaders() });
    const text = await r.text();
    modelsCache = { at: Date.now(), body: text, status: r.status };
    res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: { message: `zen-relay: models fetch failed: ${String(e)}` } });
  }
}

// ---------------------------------------------------------------------------
// Model-list sync — keeps the DSH profile patch in step with the gateway.
// The generated list lives between the zen-sync markers in the patch; the
// block is rewritten only when it differs.
// ---------------------------------------------------------------------------
const SYNC_INTERVAL_MS = (() => {
  const n = Number(process.env.ZEN_SYNC_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 60 * 60 * 1000;
})();
const CATALOG_URL = process.env.ZEN_CATALOG_URL || "https://models.dev/api.json";
const SYNC_BEGIN = "# >>> zen-sync:models";
const SYNC_END = "# <<< zen-sync:models";
const SYNC_DEFAULT_RE = /^([ \t]*model:[ \t]*)(\S+)([ \t]*#[ \t]*zen-sync:default[ \t]*)$/m;

async function fetchFreeModelIds() {
  const r = await fetch(ZEN_MODELS, { headers: upstreamHeaders() });
  if (!r.ok) throw new Error(`models http ${r.status}`);
  const body = await r.json();
  return (body.data || []).map((m) => m && m.id).filter((id) => typeof id === "string" && id.endsWith("-free"));
}

async function fetchCatalog() {
  const r = await fetch(CATALOG_URL);
  if (!r.ok) throw new Error(`catalog http ${r.status}`);
  const all = await r.json();
  return (all.opencode && all.opencode.models) || {};
}

function syncDisplayName(id, meta) {
  let base = meta && typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : id.replace(/-free$/, "");
  base = base.replace(/[ ]+free$/i, "").trim();
  base = base.charAt(0).toUpperCase() + base.slice(1);
  if (!/\(free\)$/i.test(base)) base += " (free)";
  return base.replace(/"/g, "'");
}

function syncEffortLevels(meta) {
  const opts = meta && meta.reasoning_options;
  if (!Array.isArray(opts)) return [];
  for (const o of opts) {
    const values = o && o.values;
    if (Array.isArray(values)) return values.filter((v) => typeof v === "string" && v !== "none" && v !== "off");
  }
  return [];
}

function generateModelLines(ids, catalog, prevOrder, itemIndent = 10) {
  const ordered = [];
  for (const id of prevOrder) if (ids.includes(id) && !ordered.includes(id)) ordered.push(id);
  for (const id of ids) if (!ordered.includes(id)) ordered.push(id);

  const i = " ".repeat(itemIndent);
  const f = " ".repeat(itemIndent + 2);
  const lines = [];
  for (const id of ordered) {
    const meta = catalog[id] || {};
    lines.push(`${i}- id: ${id}`);
    lines.push(`${f}name: "${syncDisplayName(id, meta)}"`);
    const ctx = meta.limit && Number(meta.limit.context);
    const out = meta.limit && Number(meta.limit.output);
    if (Number.isFinite(ctx) && ctx > 0) lines.push(`${f}contextWindow: ${ctx}`);
    if (Number.isFinite(out) && out > 0) lines.push(`${f}maxTokens: ${out}`);
    const ins = meta.modalities && Array.isArray(meta.modalities.input) ? meta.modalities.input : [];
    if (ins.includes("image")) lines.push(`${f}input: [ text, image ]`);
    const efforts = syncEffortLevels(meta);
    if (efforts.length) {
      lines.push(`${f}reasoningEfforts:`);
      for (const e of efforts) lines.push(`${f}  ${e}: ${e}`);
    }
  }
  return { ordered, lines };
}

export async function syncModels(patchPath, reason = "manual") {
  const started = Date.now();
  const result = { t: "sync", reason, file: patchPath };
  try {
    let text;
    try { text = readFileSync(patchPath, "utf8"); }
    catch { log({ ...result, status: "no-patch" }); return { ok: false, error: `patch not found: ${patchPath}` }; }

    const b = text.indexOf(SYNC_BEGIN);
    const e = text.indexOf(SYNC_END);
    if (b < 0 || e < 0 || e < b) { log({ ...result, status: "no-markers" }); return { ok: false, error: "zen-sync markers missing in patch" }; }

    const [ids, catalog] = await Promise.all([fetchFreeModelIds(), fetchCatalog()]);
    if (!ids.length) throw new Error("gateway returned no free models");

    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const prevBlock = text.slice(b + SYNC_BEGIN.length, e);
    const prevOrder = [...prevBlock.matchAll(/^[ \t]*- id:[ \t]*(\S+)/gm)].map((m) => m[1]);
    const markerLine = text.slice(0, b).split(/\r?\n/).pop() || "";
    const itemIndent = markerLine.length - markerLine.trimStart().length;
    const { ordered, lines } = generateModelLines(ids, catalog, prevOrder, itemIndent);

    let next = text.slice(0, b + SYNC_BEGIN.length) + nl + lines.join(nl) + nl + markerLine + text.slice(e);

    let defaultSwitched = null;
    const dm = next.match(SYNC_DEFAULT_RE);
    if (dm && !ids.includes(dm[2])) {
      next = next.replace(SYNC_DEFAULT_RE, `$1${ordered[0]}$3`);
      defaultSwitched = `${dm[2]} -> ${ordered[0]}`;
    }

    const added = ids.filter((id) => !prevOrder.includes(id));
    const removed = prevOrder.filter((id) => !ids.includes(id));
    const changed = next !== text;

    result.status = "ok";
    result.free = ordered.length;
    if (added.length) result.added = added;
    if (removed.length) result.removed = removed;
    if (defaultSwitched) result.default = defaultSwitched;
    result.changed = changed;
    result.ms = Date.now() - started;
    if (changed) {
      const tmp = `${patchPath}.tmp-${process.pid}`;
      writeFileSync(tmp, next);
      renameSync(tmp, patchPath);
    }
    log(result);
    return { ok: true, ...result };
  } catch (err) {
    const out = { ...result, status: "error", err: String(err).slice(0, 200), ms: Date.now() - started };
    log(out);
    return { ok: false, error: out.err };
  }
}

export function startModelSync({ patchPath, intervalMs = SYNC_INTERVAL_MS } = {}) {
  if (!patchPath) return { run: async () => ({ ok: false, error: "no patch path" }), stop() {} };
  const run = () => syncModels(patchPath, "timer").catch((err) => ({ ok: false, error: String(err) }));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { run, stop() { clearInterval(timer); } };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
export async function startRelay(options = {}) {
  const wanted = Number.isInteger(options.port) ? options.port : 9360;
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    if (req.method === "POST" && path.endsWith("/chat/completions")) { handleChat(req, res); return; }
    if (req.method === "GET" && path.endsWith("/models")) { handleModels(res); return; }
    if (req.method === "GET" && path === "/sync") {
      const patch = options.patchPath;
      if (!patch) { sendJson(res, 400, { ok: false, error: "no patch path configured" }); return; }
      syncModels(patch, "http").then((r) => sendJson(res, r.ok ? 200 : 500, r));
      return;
    }
    if (req.method === "GET" && (path === "/healthz" || path === "/")) {
      sendJson(res, 200, { ok: true, service: "zen-relay", version: RELAY_VERSION, upstream: ZEN_BASE, session: sessionId });
      return;
    }
    sendJson(res, 404, { error: { message: `zen-relay: no route for ${req.method} ${path}` } });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => { server.off("listening", onListening); reject(err); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(wanted, "127.0.0.1");
  });
  server.unref?.();
  const port = server.address().port;
  log({ t: "start", port, session: sessionId });

  return {
    port,
    server,
    external: false,
    close: () => new Promise((done) => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { server.close(() => done()); } catch { done(); }
    }),
  };
}

export async function probeRelay(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.service === "zen-relay" ? j : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Standalone mode: node zen-relay.mjs
//   ZEN_RELAY_PORT  listen port (default 9360)
//   ZEN_PATCH       profile patch to sync (optional)
// ---------------------------------------------------------------------------
const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  const port = Number(process.env.ZEN_RELAY_PORT || 9360);
  const patch = process.env.ZEN_PATCH || "";
  startRelay({ port, patchPath: patch || undefined }).then((relay) => {
    // startRelay unrefs the server so it never keeps DSH alive; standalone
    // mode has no host event loop, so hold the process open explicitly.
    relay.server?.ref?.();
    console.log(`zen-relay listening on http://127.0.0.1:${relay.port} (session ${sessionId})`);
    if (patch) {
      startModelSync({ patchPath: patch });
      console.log(`model sync    : ${patch} (start + every 6h + GET /sync)`);
    }
  }).catch((err) => {
    console.error(`zen-relay: ${err.message}`);
    process.exit(1);
  });
}
