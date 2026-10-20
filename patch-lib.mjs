// patch-lib.mjs — dependency-free helpers that edit a DSH profile patch
// (cordis.patch.yml). They understand the standard two-space block YAML that
// DSH writes and refuse to guess on exotic layouts.
//
// The functions are pure text-in/text-out so they can be unit-tested and run
// safely against a copy before touching the real profile.

export const SYNC_BEGIN = "# >>> zen-sync:models";
export const SYNC_END = "# <<< zen-sync:models";
export const STARTER_MODEL_ID = "deepseek-v4.1-flash-free";

export const PATCH_HEADER = [
  "# dsh-opencode — OpenCode Zen free models (no API key).",
  "# The local relay re-shapes requests like the official OpenCode CLI and",
  "# uses Zen's keyless free tier; no API key is stored anywhere.",
  "# The model list is regenerated automatically from the gateway and lives",
  "# between the zen-sync markers below. Leave the markers in place.",
];

const IND = (n) => " ".repeat(n);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "";
const isComment = (line) => line.trimStart().startsWith("#");

export function lineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// ---------------------------------------------------------------------------
// YAML fragment builders
// ---------------------------------------------------------------------------

function starterModelLines(itemIndent) {
  const i = IND(itemIndent);
  const f = IND(itemIndent + 2);
  return [
    `${i}- id: ${STARTER_MODEL_ID}`,
    `${f}name: "DeepSeek V4.1 Flash (free)"`,
    `${f}contextWindow: 200000`,
    `${f}maxTokens: 32000`,
    `${f}input: [ text, image ]`,
    `${f}reasoningEfforts:`,
    `${f}  low: low`,
    `${f}  high: high`,
    `${f}  max: max`,
  ];
}

// providersIndent = indentation of the `providers:` key this block lives under.
export function providerBlockLines(port, providersIndent = 4) {
  const p = IND(providersIndent + 2); // provider id key
  const s = IND(providersIndent + 4); // provider settings
  const m = IND(providersIndent + 6); // model list items
  return [
    `${p}opencode-zen:`,
    `${s}displayName: OpenCode Zen (free)`,
    `${s}baseURL: "http://127.0.0.1:${port}/v1"`,
    `${s}api: openai-completions`,
    `${s}compat:`,
    `${s}  supportsReasoningEffort: true`,
    `${s}headers:`,
    `${s}  Authorization: "Bearer zen-relay"`,
    `${s}models:`,
    `${m}${SYNC_BEGIN}`,
    ...starterModelLines(providersIndent + 6),
    `${m}${SYNC_END}`,
  ];
}

export function providerEntryLines(port) {
  return ["- id: llm-pi-ai", "  config:", "    providers:", ...providerBlockLines(port, 4)];
}

export function defaultEntryLines() {
  return [
    "- id: agent-default-model",
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    "  config:",
    "    provider: opencode-zen",
    `    model: ${STARTER_MODEL_ID} # zen-sync:default`,
  ];
}

// ---------------------------------------------------------------------------
// Structure helpers (line arrays; line endings handled by the caller)
// ---------------------------------------------------------------------------

export function findEntryRange(lines, id) {
  const re = new RegExp(`^- id:[ \\t]*${escapeRe(id)}[ \\t]*$`);
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- id:[ \t]*\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

export function entryHasProvider(lines, range, providerId) {
  const re = new RegExp(`^[ \\t]*${escapeRe(providerId)}:[ \\t]*$`);
  for (let i = range.start; i < range.end; i++) {
    if (re.test(lines[i]) || new RegExp(`${escapeRe(providerId)}:`).test(lines[i])) return true;
  }
  return false;
}

function trimTrailingBlanks(lines) {
  const out = lines.slice();
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out;
}

function mergeProviderIntoEntry(lines, range, port) {
  const slice = lines.slice(range.start, range.end);
  // Flow-style config cannot be edited safely by text surgery.
  if (slice.some((l) => /^[ \t]*(config|providers):[ \t]*[{\[]/.test(l))) {
    return { lines, changed: false, reason: "flow-style config detected" };
  }

  const out = lines.slice();
  const provIdx = slice.findIndex((l) => /^([ \t]*)providers:[ \t]*$/.test(l));
  if (provIdx >= 0) {
    const at = range.start + provIdx;
    const indent = indentOf(lines[at]);
    out.splice(at + 1, 0, ...providerBlockLines(port, indent));
    return { lines: out, changed: true };
  }

  const cfgIdx = slice.findIndex((l) => /^([ \t]*)config:[ \t]*$/.test(l));
  if (cfgIdx >= 0) {
    const at = range.start + cfgIdx;
    const indent = indentOf(lines[at]);
    out.splice(at + 1, 0, `${IND(indent + 2)}providers:`, ...providerBlockLines(port, indent + 2));
    return { lines: out, changed: true };
  }

  out.splice(range.start + 1, 0, "  config:", "    providers:", ...providerBlockLines(port, 4));
  return { lines: out, changed: true };
}

// Insert (or repair) the zen-sync markers around the opencode-zen model list.
export function ensureMarkersInLines(lines) {
  const hasBegin = lines.some((l) => l.includes(SYNC_BEGIN));
  const hasEnd = lines.some((l) => l.includes(SYNC_END));
  if (hasBegin && hasEnd) return { lines, changed: false, actions: [] };

  let work = lines.slice();
  if (hasBegin || hasEnd) {
    work = work.filter((l) => !l.includes(SYNC_BEGIN) && !l.includes(SYNC_END));
  }

  const provIdx = work.findIndex((l) => /^[ \t]*opencode-zen:[ \t]*$/.test(l));
  if (provIdx < 0) return { lines: work, changed: hasBegin || hasEnd, actions: ["provider-missing"] };
  const provIndent = indentOf(work[provIdx]);

  let modelsIdx = -1;
  for (let i = provIdx + 1; i < work.length; i++) {
    const l = work[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= provIndent) break;
    if (/^[ \t]*models:[ \t]*$/.test(l)) { modelsIdx = i; break; }
  }
  if (modelsIdx < 0) return { lines: work, changed: hasBegin || hasEnd, actions: ["models-key-missing"] };

  const modelsIndent = indentOf(work[modelsIdx]);
  let endIdx = work.length;
  for (let i = modelsIdx + 1; i < work.length; i++) {
    const l = work[i];
    if (isBlank(l) || isComment(l)) continue;
    if (indentOf(l) <= modelsIndent) { endIdx = i; break; }
  }

  let hasItem = false;
  for (let i = modelsIdx + 1; i < endIdx; i++) {
    if (/^[ \t]*- id:[ \t]*\S/.test(work[i])) { hasItem = true; break; }
  }

  const itemIndent = modelsIndent + 2;
  const markerIndent = IND(itemIndent);
  const insert = [];
  if (!hasItem) insert.push(...starterModelLines(itemIndent));
  insert.push(`${markerIndent}${SYNC_END}`);

  work.splice(endIdx, 0, ...insert);
  work.splice(modelsIdx + 1, 0, `${markerIndent}${SYNC_BEGIN}`);
  return { lines: work, changed: true, actions: ["markers-inserted"] };
}

export function ensureDefaultInLines(lines) {
  const range = findEntryRange(lines, "agent-default-model");
  if (!range) {
    return { lines: trimTrailingBlanks(lines).concat(defaultEntryLines()), changed: true, actions: ["default-added"] };
  }

  const slice = lines.slice(range.start, range.end);
  if (!slice.some((l) => /^[ \t]*provider:[ \t]*opencode-zen[ \t]*$/.test(l))) {
    return { lines, changed: false, actions: [] }; // user's own default: leave alone
  }

  let mi = -1;
  for (let i = range.start; i < range.end; i++) {
    if (/^[ \t]*model:[ \t]*\S/.test(lines[i])) { mi = i; break; }
  }

  if (mi < 0) {
    const pi = slice.findIndex((l) => /^[ \t]*provider:[ \t]*opencode-zen[ \t]*$/.test(l));
    const out = lines.slice();
    out.splice(range.start + pi + 1, 0, `${IND(indentOf(lines[range.start + pi]))}model: ${STARTER_MODEL_ID} # zen-sync:default`);
    return { lines: out, changed: true, actions: ["default-model-added"] };
  }

  if (/#[ \t]*zen-sync:default/.test(lines[mi])) return { lines, changed: false, actions: [] };

  const out = lines.slice();
  out[mi] = out[mi].replace(/[ \t]+$/, "") + " # zen-sync:default";
  return { lines: out, changed: true, actions: ["default-marked"] };
}

// ---------------------------------------------------------------------------
// Top-level operations
// ---------------------------------------------------------------------------

export function applyPluginToPatch(text, { port = 9360, setDefault = true } = {}) {
  const eol = lineEnding(text);
  const actions = [];
  let lines = text.length ? text.split(/\r?\n/) : [];

  const content = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l !== "---");
  const hasEntry = lines.some((l) => /^- id:[ \t]*\S/.test(l));
  const bareEmptyArray = content.length === 1 && content[0] === "[]";

  if (!hasEntry && (content.length === 0 || bareEmptyArray)) {
    const base = bareEmptyArray ? lines.filter((l) => l.trim() !== "[]") : lines;
    const kept = base.filter((l) => !isBlank(l));
    const seed = kept.length ? kept : PATCH_HEADER;
    lines = [...seed, ...providerEntryLines(port), ...(setDefault ? defaultEntryLines() : [])];
    let out = lines.join(eol);
    if (!out.endsWith(eol)) out += eol;
    return { text: out, changed: out !== text, actions: ["patch-initialized"] };
  }

  const range = findEntryRange(lines, "llm-pi-ai");
  if (!range) {
    lines = trimTrailingBlanks(lines).concat(providerEntryLines(port));
    actions.push("provider-appended");
  } else if (entryHasProvider(lines, range, "opencode-zen")) {
    actions.push("provider-exists");
  } else {
    const merged = mergeProviderIntoEntry(lines, range, port);
    if (merged.changed) {
      lines = merged.lines;
      actions.push("provider-merged");
    } else {
      actions.push("provider-merge-skipped");
      return { text, changed: false, actions, error: merged.reason };
    }
  }

  const mk = ensureMarkersInLines(lines);
  if (mk.changed) {
    lines = mk.lines;
    actions.push(...mk.actions);
  }

  if (setDefault) {
    const dm = ensureDefaultInLines(lines);
    if (dm.changed) {
      lines = dm.lines;
      actions.push(...dm.actions);
    }
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return { text: out, changed: out !== text, actions };
}

// Keep the relay baseURL in step with the port the plugin actually bound.
// Only a loopback /v1 URL is rewritten; a custom endpoint is left alone.
export function setPatchPort(text, port) {
  const eol = lineEnding(text);
  const lines = text.split(/\r?\n/);
  const provIdx = lines.findIndex((l) => /^[ \t]*opencode-zen:[ \t]*$/.test(l));
  if (provIdx < 0) return { text, changed: false };

  const provIndent = indentOf(lines[provIdx]);
  for (let i = provIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && indentOf(l) <= provIndent) break;
    const m = l.match(/^([ \t]*baseURL:[ \t]*["']?)http:\/\/127\.0\.0\.1:\d+\/v1(["']?[ \t]*)$/);
    if (m) {
      const next = `${m[1]}http://127.0.0.1:${port}/v1${m[2]}`;
      if (next === l) return { text, changed: false };
      lines[i] = next;
      return { text: lines.join(eol), changed: true };
    }
  }
  return { text, changed: false };
}

export function ensureMarkersInText(text) {
  const eol = lineEnding(text);
  const lines = text.length ? text.split(/\r?\n/) : [];
  const r = ensureMarkersInLines(lines);
  let out = r.lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return { text: out, changed: r.changed, actions: r.actions };
}
