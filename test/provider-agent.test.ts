import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

interface ProviderCase {
  id: number;
  expected: "npm" | "pnpm" | "yes" | "no" | "topic" | "memory.md" | "archive";
  prompt: string;
}

interface ProviderResult extends ProviderCase {
  output: string;
  normalized: string;
  passed: boolean;
}

const RUN_PROVIDER_TESTS = process.env.PI_MEMORY_PROVIDER_TESTS === "1";
const PI_BIN = process.env.PI_BIN ?? "pi";
const EXTENSION_PATH = join(process.cwd(), "extensions", "index.ts");

const CASES: ProviderCase[] = [
  {
    id: 1,
    expected: "npm",
    prompt: "From persistent memory only: Does this project use npm or pnpm? Reply exactly one word.",
  },
  {
    id: 2,
    expected: "pnpm",
    prompt: "From persistent memory only: Which package manager is explicitly not used here? Reply exactly one word.",
  },
  {
    id: 3,
    expected: "no",
    prompt: "From persistent memory instructions: Should you write memory into AGENTS.md? Reply exactly yes or no.",
  },
  {
    id: 4,
    expected: "yes",
    prompt: "From persistent memory instructions: Are project memory entries shared with the team? Reply exactly yes or no.",
  },
  {
    id: 5,
    expected: "no",
    prompt: "From persistent memory instructions: Should project memory store secrets? Reply exactly yes or no.",
  },
  {
    id: 6,
    expected: "topic",
    prompt: "From persistent memory instructions: If a fact outgrows the concise index, where should detail go? Reply with two words.",
  },
  {
    id: 7,
    expected: "memory.md",
    prompt: "From persistent memory instructions: What file is the per-scope injected index named? Reply exactly the filename.",
  },
  {
    id: 8,
    expected: "archive",
    prompt: "From persistent memory instructions: When a memory entry is stale, should it be archived or deleted? Reply exactly archive or delete.",
  },
  {
    id: 9,
    expected: "no",
    prompt: "From persistent memory instructions: Should the agent save facts already recorded in code or git history? Reply yes or no.",
  },
  {
    id: 10,
    expected: "npm",
    prompt: "From persistent memory: Complete this sentence with exactly one word: This project uses ___, not pnpm.",
  },
];

test(
  "provider-backed pi agents use injected persistent memory",
  { skip: RUN_PROVIDER_TESTS ? false : "set PI_MEMORY_PROVIDER_TESTS=1 to run provider-backed pi-agent tests", timeout: 300_000 },
  () => {
    assert.equal(existsSync(EXTENSION_PATH), true, `missing extension at ${EXTENSION_PATH}`);

    const results = CASES.map(runCase);
    const failures = results.filter((result) => !result.passed);

    console.log(formatResults(results));
    assert.deepEqual(
      failures.map((failure) => ({
        id: failure.id,
        expected: failure.expected,
        normalized: failure.normalized,
      })),
      [],
    );
  },
);

function runCase(testCase: ProviderCase): ProviderResult {
  const output = execFileSync(PI_BIN, piArgs(testCase.prompt), {
    cwd: process.cwd(),
    encoding: "utf8",
    input: "",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  const normalized = normalize(output);
  return {
    ...testCase,
    output,
    normalized,
    passed: matchesExpected(normalized, testCase.expected),
  };
}

function piArgs(prompt: string): string[] {
  const args = [
    "-p",
    "--thinking",
    "minimal",
    "--no-session",
    "--no-tools",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-extensions",
    "-e",
    EXTENSION_PATH,
    "--approve",
  ];
  if (process.env.PI_MEMORY_PROVIDER) args.push("--provider", process.env.PI_MEMORY_PROVIDER);
  if (process.env.PI_MEMORY_MODEL) args.push("--model", process.env.PI_MEMORY_MODEL);
  args.push(prompt);
  return args;
}

function normalize(output: string): string {
  return output
    .toLowerCase()
    .replace(/[`*_.,:;!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesExpected(normalized: string, expected: ProviderCase["expected"]): boolean {
  switch (expected) {
    case "npm":
      return containsWord(normalized, "npm")
        && !normalized.includes("uses pnpm")
        && !normalized.includes("pnpm not npm");
    case "pnpm":
      return containsWord(normalized, "pnpm");
    case "yes":
      return containsWord(normalized, "yes");
    case "no":
      return containsWord(normalized, "no");
    case "topic":
      return normalized.includes("topic file") || normalized.includes("topic files");
    case "memory.md":
      return normalized.includes("memorymd") || normalized.includes("memory md");
    case "archive":
      return containsWord(normalized, "archive") || containsWord(normalized, "archived");
  }
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`(^| )${escapeRegex(word)}( |$)`).test(text);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatResults(results: ProviderResult[]): string {
  const lines = ["provider-backed memory results:"];
  for (const result of results) {
    lines.push(
      `${result.id}. ${result.passed ? "PASS" : "FAIL"} expected=${result.expected} output=${JSON.stringify(result.normalized)}`,
    );
  }
  return lines.join("\n");
}
