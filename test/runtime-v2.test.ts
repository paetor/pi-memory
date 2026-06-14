import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRuntimeMemoryBlock } from "../src/resident-inject.ts";
import { createIndexCache, DEFAULT_CONFIG } from "../src/storage.ts";
import { appendTrace, readRecentTraces, readTrace, recentFaults, residencyTrace } from "../src/trace.ts";
import { selectResidentPages } from "../src/residency.ts";
import { derivePagesFromMarkdown } from "../src/markdown-pages.ts";
import { flushWritebackJournal, readWritebackJournal, stageAppendMemory } from "../src/writeback.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-runtime-test-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("runtime injection renders a selected resident page block", () => {
  const globalDir = tempDir();
  const projectDir = tempDir();
  writeFileSync(join(globalDir, "MEMORY.md"), "## General\n- Global preference for concise answers.");
  writeFileSync(join(projectDir, "MEMORY.md"), "## General\n- this project uses npm, not pnpm.");

  const block = buildRuntimeMemoryBlock({
    globalDir,
    projectDir,
    config: { ...DEFAULT_CONFIG, maxMemoryTokens: 4, traceEnabled: false },
    cache: createIndexCache(),
  });

  assert.ok(block.includes("ClawVM-style persistent memory"));
  assert.ok(block.includes("this project uses npm, not pnpm"));
  assert.ok(block.includes("selected memory pages"));
});

test("runtime injection falls back to legacy memory block when no pages exist", () => {
  const globalDir = tempDir();
  const block = buildRuntimeMemoryBlock({
    globalDir,
    config: { ...DEFAULT_CONFIG, traceEnabled: false },
    cache: createIndexCache(),
  });

  assert.ok(block.includes("Persistent memory"));
  assert.ok(block.includes("no entries yet"));
});

test("trace store records residency faults and retrieves trace by id", () => {
  const dir = tempDir();
  const pages = derivePagesFromMarkdown("## General\n- this project uses npm, not pnpm.", {
    path: "MEMORY.md",
    scope: "project",
  }).pages;
  const decision = selectResidentPages(pages, { budgetTokens: 1 });
  const trace = residencyTrace(decision, "test residency");
  appendTrace(dir, trace);

  const recent = readRecentTraces(dir, 10);
  assert.equal(recent.errors.length, 0);
  assert.equal(recent.traces[0]?.id, trace.id);
  assert.equal(readTrace(dir, trace.id)?.summary, "test residency");
});

test("recentFaults reports invariant pressure from trace logs", () => {
  const dir = tempDir();
  const pages = derivePagesFromMarkdown("## General\n- this project uses npm, not pnpm.", {
    path: "MEMORY.md",
    scope: "project",
  }).pages;
  const decision = selectResidentPages(pages, { budgetTokens: 1 });
  appendTrace(dir, residencyTrace(decision, "too tight"));

  const faults = recentFaults(dir, 5);
  assert.equal(faults[0]?.fault.type, "invariant_pressure");
});

test("writeback journal commits staged append operations and rebuilds pages", () => {
  const dir = tempDir();
  stageAppendMemory(dir, "global", "User prefers short answers.");

  const result = flushWritebackJournal(dir, "global", { ...DEFAULT_CONFIG, traceEnabled: false });

  assert.equal(result.committed.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.ok(readFileSync(join(dir, "MEMORY.md"), "utf8").includes("User prefers short answers."));
  assert.ok(readFileSync(join(dir, "page-table.jsonl"), "utf8").includes("User prefers short answers."));
  assert.equal(readWritebackJournal(dir)[0]?.status, "committed");
});

test("writeback journal rejects secret-looking project memory", () => {
  const dir = tempDir();
  stageAppendMemory(dir, "project", "api_key = sk-1234567890abcdef");

  const result = flushWritebackJournal(dir, "project", { ...DEFAULT_CONFIG, traceEnabled: false });

  assert.equal(result.committed.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.faults[0]?.type, "writeback_rejected");
  assert.equal(readWritebackJournal(dir)[0]?.status, "rejected");
});

test("writeback journal reports only newly committed operations", () => {
  const dir = tempDir();
  stageAppendMemory(dir, "global", "Remember only once.");

  const first = flushWritebackJournal(dir, "global", { ...DEFAULT_CONFIG, traceEnabled: false });
  const second = flushWritebackJournal(dir, "global", { ...DEFAULT_CONFIG, traceEnabled: false });

  assert.equal(first.committed.length, 1);
  assert.equal(second.committed.length, 0);
  assert.equal(readWritebackJournal(dir).length, 1);
});

test("writeback journal rejects duplicate bullets", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "MEMORY.md"), "## General\n- Existing fact.\n");
  stageAppendMemory(dir, "global", "Existing fact.");

  const result = flushWritebackJournal(dir, "global", { ...DEFAULT_CONFIG, traceEnabled: false });

  assert.equal(result.rejected.length, 1);
  assert.equal(result.faults[0]?.reason, "duplicate memory bullet already exists");
});

test("writeback journal preserves corrupt journals by refusing to rewrite", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "writeback-journal.jsonl"), "not-json\n");

  const result = flushWritebackJournal(dir, "global", { ...DEFAULT_CONFIG, traceEnabled: false });

  assert.equal(result.faults[0]?.type, "sidecar_corrupt");
  assert.equal(readFileSync(join(dir, "writeback-journal.jsonl"), "utf8"), "not-json\n");
});
