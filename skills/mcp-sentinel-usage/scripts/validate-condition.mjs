#!/usr/bin/env node
// Validates an mcp-sentinel "until" condition object against the closed DSL.
// Usage:
//   node validate-condition.mjs <file.json>
//   echo '<json>' | node validate-condition.mjs -
// Exit 0 = valid, 1 = invalid (errors on stderr), 2 = usage error.

import { readFileSync } from "node:fs";

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "match"]);
const LEAF_KEYS = new Set(["path", "is", "value"]);
const COMPOUND_KEYS = new Set(["not", "and", "or"]);
const ALL_KEYS = new Set([...LEAF_KEYS, ...COMPOUND_KEYS]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validatePath(path, errors) {
  if (typeof path !== "string") {
    errors.push("path must be a string (or omitted to compare the whole result).");
    return;
  }
  if (path === "") return; // empty path = whole-result compare (valid)
  // Mirror the engine's normalization: [n] -> .n, then split on "."
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  if (normalized.includes("[") || normalized.includes("]")) {
    errors.push(
      'path "' + path + '" has malformed bracket syntax; array indices must look like "[0]".'
    );
  }
}

function validateCondition(c, errors) {
  if (!isPlainObject(c)) {
    errors.push("condition must be a JSON object, got " + (c === null ? "null" : typeof c) + ".");
    return;
  }
  const keys = Object.keys(c);
  const unknown = keys.filter((k) => !ALL_KEYS.has(k));
  if (unknown.length > 0) {
    errors.push(
      "unknown condition key(s): " +
        unknown.join(", ") +
        ". A condition is a leaf { path?, is, value } or a compound { not } / { and } / { or }."
    );
    return;
  }
  const compounds = keys.filter((k) => COMPOUND_KEYS.has(k));
  if (keys.includes("is") && compounds.length > 0) {
    errors.push(
      "condition mixes leaf (is) with compound keys (" +
        compounds.join(", ") +
        "); use exactly one form."
    );
    return;
  }
  if (!keys.includes("is") && compounds.length !== 1) {
    errors.push(
      "condition must be a leaf { path?, is, value } or exactly one compound key (not | and | or)."
    );
    return;
  }
  if (keys.includes("is")) {
    if (typeof c.is !== "string" || !OPERATORS.has(c.is)) {
      errors.push(
        "is must be one of: eq, ne, gt, gte, lt, lte, contains, match (got " +
          JSON.stringify(c.is) +
          ")."
      );
    }
    if (!("value" in c)) {
      errors.push("leaf condition must include value.");
    }
    if ("path" in c) validatePath(c.path, errors);
    return;
  }
  if (compounds.length > 1) {
    errors.push("condition must use exactly one compound key, got " + compounds.join(", ") + ".");
    return;
  }
  const key = compounds[0];
  if (key === "not") {
    validateCondition(c.not, errors);
  } else {
    const arr = c[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      errors.push(key + " must be a non-empty array of conditions.");
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      validateCondition(arr[i], errors);
    }
  }
}

function readInput(argv) {
  const arg = argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "Usage: node validate-condition.mjs <file.json>  (or '-' to read JSON from stdin)\n"
    );
    process.exit(0);
  }
  if (!arg) {
    process.stderr.write(
      "Usage: node validate-condition.mjs <file.json>  (or '-' to read JSON from stdin)\n"
    );
    process.exit(2);
  }
  const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  return JSON.parse(raw);
}

function main() {
  let condition;
  try {
    condition = readInput(process.argv);
  } catch (err) {
    process.stderr.write(
      "Error: input is not valid JSON: " + String((err && err.message) || err) + "\n"
    );
    process.exit(1);
  }
  const errors = [];
  validateCondition(condition, errors);
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write("Error: " + e + "\n");
    }
    process.exit(1);
  }
  process.stdout.write("ok\n");
}

main();
