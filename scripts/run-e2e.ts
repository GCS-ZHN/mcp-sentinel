#!/usr/bin/env bun
/**
 * End-to-end test runner with an LLM judge.
 *
 * Reads every `packages/<pkg>/tests/e2e-cases.json`, runs each case's
 * headless command against its harness, then asks a separate judge model to
 * decide whether the actual output satisfies the case's natural-language
 * expectation (no keyword matching). Each case produces a standard JSON
 * report under `e2e-results/`, and the script aggregates pass/fail.
 *
 * Usage:
 *   bun scripts/run-e2e.ts                        # run + judge all harnesses
 *   bun scripts/run-e2e.ts --harness deepseek-harness
 *   bun scripts/run-e2e.ts --dry-run              # print commands only
 *   bun scripts/run-e2e.ts --report-dir e2e-results
 *
 * Case file is a JSON array (or `{ "cases": [...] }`). Each case:
 *   {
 *     "id": "stable label",
 *     "harness_name": "deepseek-harness",
 *     "headless_test_command": "npx @deepseek-ai/dsh --profile headless {prompt}",
 *     "input_prompt": "…",     // replaces the {prompt} token
 *     "expect_result": "…"     // natural-language expectation for the judge
 *   }
 *
 * Judge configuration (env):
 *   DEEPSEEK_API_KEY   required for judging
 *   DEEPSEEK_BASE_URL  optional, default https://api.deepseek.com
 *   E2E_JUDGE_MODEL    optional, default deepseek-chat
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface E2ECase {
  id?: string;
  harness_name: string;
  headless_test_command: string;
  input_prompt: string;
  expect_result: string;
}

interface CaseFile {
  cases?: E2ECase[];
}

interface JudgeResult {
  passed: boolean;
  reason: string;
}

interface Report extends E2ECase {
  id: string;
  actual_output: string;
  exit_code: number | null;
  duration_ms: number;
  passed: boolean;
  reason: string;
}

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Resolve the DeepSeek API key for judging: env first, then dsh credentials. */
function resolveApiKey(): string | undefined {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return undefined;
  try {
    const content = readFileSync(join(home, ".dsh", ".credentials.yaml"), "utf8");
    const match = content.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Collect every case from the e2e-cases.json under each package's tests dir. */
function collectCases(): E2ECase[] {
  const packagesDir = join(ROOT, "packages");
  const collected: E2ECase[] = [];

  for (const pkg of readdirSync(packagesDir)) {
    const file = join(packagesDir, pkg, "tests", "e2e-cases.json");
    if (!existsSync(file)) continue;

    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const cases = Array.isArray(parsed) ? parsed : (parsed as CaseFile).cases;
    if (!Array.isArray(cases)) {
      throw new Error(`Invalid e2e case file (expected array or { cases: [...] }): ${file}`);
    }
    collected.push(...(cases as E2ECase[]));
  }

  return collected;
}

/** Turn a free-text prompt into a filesystem-safe report id. */
function slugify(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "case"
  );
}

/** Build the shell command for a case, substituting {prompt}. */
function buildCommand(c: E2ECase): string {
  if (!c.headless_test_command.includes("{prompt}")) {
    return `${c.headless_test_command} ${JSON.stringify(c.input_prompt)}`;
  }
  return c.headless_test_command.replace("{prompt}", JSON.stringify(c.input_prompt));
}

/** Ask a judge model whether the actual output satisfies the expectation. */
async function judge(
  inputPrompt: string,
  expectation: string,
  output: string
): Promise<JudgeResult> {
  const key = resolveApiKey();
  if (!key) {
    return { passed: false, reason: "DEEPSEEK_API_KEY is not set; cannot judge." };
  }
  const base = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.E2E_JUDGE_MODEL ?? "deepseek-chat";

  const system =
    "You are a test judge. Given a test's input prompt, its expected result, and the harness's actual output, decide whether the test passed. " +
    'Respond with JSON only: {"passed": true|false, "reason": "one concise sentence"}.';
  const user = `input prompt:\n${inputPrompt}\n\nexpected result:\n${expectation}\n\nactual output:\n${output}`;

  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
    });
    if (!resp.ok) {
      return { passed: false, reason: `judge API error ${resp.status}: ${await resp.text()}` };
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content) as Partial<JudgeResult>;
    return { passed: Boolean(parsed.passed), reason: String(parsed.reason ?? "") };
  } catch (err) {
    return { passed: false, reason: `judge failed: ${String(err)}` };
  }
}

async function runCase(
  c: E2ECase,
  reportDir: string,
  dryRun: boolean,
  doJudge: boolean
): Report | null {
  const id = c.id ?? `${c.harness_name}-${slugify(c.input_prompt.slice(0, 60))}`;
  const command = buildCommand(c);

  if (dryRun) {
    console.log(`[dry-run] ${id}\n  $ ${command}`);
    return null;
  }

  const started = Date.now();
  const proc = spawnSync(command, {
    shell: true,
    cwd: ROOT,
    encoding: "utf8",
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  const report: Report = {
    id,
    harness_name: c.harness_name,
    headless_test_command: c.headless_test_command,
    input_prompt: c.input_prompt,
    expect_result: c.expect_result,
    actual_output: output,
    exit_code: proc.status,
    duration_ms: Date.now() - started,
    passed: false,
    reason: "",
  };

  if (doJudge) {
    const verdict = await judge(c.input_prompt, c.expect_result, output);
    report.passed = verdict.passed;
    report.reason = verdict.reason;
  } else {
    report.passed = proc.status === 0;
    report.reason = proc.status === 0 ? "exit code 0" : `exit code ${proc.status}`;
  }

  const file = join(reportDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const harnessFilter = (() => {
    const i = args.indexOf("--harness");
    return i >= 0 ? args[i + 1] : undefined;
  })();
  const idFilter = (() => {
    const i = args.indexOf("--id");
    return i >= 0 ? args[i + 1] : undefined;
  })();
  const reportDir = (() => {
    const i = args.indexOf("--report-dir");
    return i >= 0 ? args[i + 1] : "e2e-results";
  })();

  const all = collectCases();
  const byHarness = harnessFilter ? all.filter((c) => c.harness_name === harnessFilter) : all;
  const cases = idFilter ? byHarness.filter((c) => (c.id ?? "").includes(idFilter)) : byHarness;
  if (cases.length === 0) {
    console.error("No e2e cases found.");
    process.exit(1);
  }

  mkdirSync(join(ROOT, reportDir), { recursive: true });
  const reports: Report[] = [];

  for (const c of cases) {
    const report = await runCase(c, join(ROOT, reportDir), dryRun, !dryRun);
    if (!report) continue;
    reports.push(report);
    console.log(`${report.passed ? "PASS" : "FAIL"}  ${report.id} — ${report.reason}`);
  }

  if (dryRun) return;

  const passed = reports.filter((r) => r.passed).length;
  const rate = ((passed / reports.length) * 100).toFixed(1);
  const summary = {
    total: reports.length,
    passed,
    failed: reports.length - passed,
    pass_rate: Number(rate),
  };
  writeFileSync(join(ROOT, reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${reports.length} passed (${rate}%)`);
  process.exit(passed === reports.length ? 0 : 1);
}

await main();
