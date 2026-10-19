#!/usr/bin/env node
// prep-patch-markers.mjs — insert or repair the zen-sync marker block around
// the opencode-zen model list in a DSH profile patch. Idempotent.
//
//   node prep-patch-markers.mjs <patch> [out]
//
// The relay regenerates only what lives between the markers, so leaving them
// in place is what keeps the model list updating automatically.

import { readFileSync, writeFileSync } from "node:fs";
import { ensureMarkersInText } from "./patch-lib.mjs";

const [src, dst = src] = process.argv.slice(2);
if (!src) {
  console.error("usage: node prep-patch-markers.mjs <patch> [out]");
  process.exit(2);
}

const text = readFileSync(src, "utf8");
const result = ensureMarkersInText(text);
writeFileSync(dst, result.text);
console.log(result.changed ? `markers inserted (${result.actions.join(", ")})` : "markers already present - nothing to do");
console.log("wrote", dst);
