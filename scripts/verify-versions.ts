#!/usr/bin/env bun
/**
 * Lockstep version consistency check, run as a git pre-commit hook.
 *
 * Enforces two invariants across the package.json files under `packages/`:
 *   1. every package carries the exact same `version`;
 *   2. every plugin's `dependencies` pins `@gcszhn/mcp-sentinel-core` to that
 *      exact version (no `^`/`~`), matching the core package's own version.
 *
 * Exits non-zero on any mismatch so a forgotten version bump fails the commit
 * instead of surfacing later in CI.
 *
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CORE_NAME = "@gcszhn/mcp-sentinel-core";

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

const packagesDir = join(import.meta.dir, "..", "packages");
const packages: PackageManifest[] = readdirSync(packagesDir).map((name) =>
  JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"))
);

let failed = false;
const fail = (message: string): void => {
  failed = true;
  console.error(message);
};

// Invariant 1: one shared version across the monorepo.
const versions = new Set(packages.map((p) => p.version));
if (versions.size !== 1) {
  fail(`Version mismatch: packages carry different versions (${[...versions].join(", ")}).`);
  for (const p of packages) fail(`  ${p.name}: ${p.version}`);
}

// Invariant 2: every plugin pins the core to the core's exact version.
const core = packages.find((p) => p.name === CORE_NAME);
if (!core) {
  fail(`Missing core package ${CORE_NAME}.`);
} else {
  for (const p of packages) {
    if (p.name === CORE_NAME) continue;
    const pinned = p.dependencies?.[CORE_NAME];
    if (pinned === undefined) {
      fail(`Plugin ${p.name} does not depend on ${CORE_NAME}.`);
    } else if (pinned !== core.version) {
      fail(`Plugin ${p.name} pins ${CORE_NAME}@${pinned}, expected exact ${core.version}.`);
    }
  }
}

if (failed) {
  process.exit(1);
}

const version = [...versions][0];
console.log(`Versions consistent: all packages @${version}, ${CORE_NAME} pinned exactly.`);
