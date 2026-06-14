import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { derivePagesFromMarkdown } from "../src/markdown-pages.ts";
import { bestAvailableRepresentation, estimateTokens, fidelityAtLeast } from "../src/memory-domain.ts";
import {
  PAGE_TABLE_FILE,
  readPageTable,
  rebuildPageTableFromMarkdown,
  writePageTable,
} from "../src/page-table.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-pages-test-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("derivePagesFromMarkdown turns MEMORY.md bullets into typed pages", () => {
  const raw = [
    "# Memory",
    "",
    "## General",
    "- this project uses npm, not pnpm.",
    "## Decisions",
    "- Decided to keep project memory in-repo for team sharing.",
  ].join("\n");

  const result = derivePagesFromMarkdown(raw, {
    path: "/repo/.pi/memory/MEMORY.md",
    sourcePath: "MEMORY.md",
    scope: "project",
  });

  assert.equal(result.missing, false);
  assert.equal(result.pages.length, 2);

  const constraint = result.pages[0];
  assert.ok(constraint);
  assert.equal(constraint.scope, "project");
  assert.equal(constraint.type, "constraint");
  assert.equal(constraint.minFidelity, "structured");
  assert.deepEqual(constraint.pins, ["hard"]);
  assert.equal(constraint.provenance[0]?.path, "MEMORY.md");
  assert.equal(constraint.provenance[0]?.lineStart, 4);

  const decision = result.pages[1];
  assert.ok(decision);
  assert.equal(decision.type, "decision");
  assert.equal(decision.provenance[0]?.topic, "Decisions");
});

test("derivePagesFromMarkdown produces stable IDs when a bullet moves", () => {
  const first = derivePagesFromMarkdown("## General\n- remember stable ids", {
    path: "MEMORY.md",
    scope: "global",
  });
  const second = derivePagesFromMarkdown("## General\n\n\n- remember stable ids", {
    path: "MEMORY.md",
    scope: "global",
  });
  assert.equal(first.pages[0]?.id, second.pages[0]?.id);
  assert.equal(second.pages[0]?.provenance[0]?.lineStart, 4);
});

test("derivePagesFromMarkdown preserves link URLs in page content", () => {
  const result = derivePagesFromMarkdown("## Evidence\n- See [ClawVM](https://arxiv.org/abs/2604.10352).", {
    path: "MEMORY.md",
    scope: "project",
  });
  const page = result.pages[0];
  assert.ok(page);
  assert.equal(page.type, "evidence");
  assert.equal(page.title, "See ClawVM (https://arxiv.org/abs/2604.10352).");
  assert.equal(page.representations.full?.content, "See [ClawVM](https://arxiv.org/abs/2604.10352).");
});

test("page table read/write round trips derived pages", () => {
  const dir = tempDir();
  const pages = derivePagesFromMarkdown("## Build\n- Run npm test before publishing.", {
    path: join(dir, "MEMORY.md"),
    sourcePath: "MEMORY.md",
    scope: "project",
  }).pages;

  const written = writePageTable(dir, pages);
  assert.equal(written.pagesWritten, 1);
  assert.equal(written.path, join(dir, PAGE_TABLE_FILE));

  const read = readPageTable(dir);
  assert.equal(read.missing, false);
  assert.deepEqual(read.errors, []);
  assert.equal(read.pages[0]?.id, pages[0]?.id);
  assert.equal(read.pages[0]?.type, "procedure");
});

test("readPageTable reports invalid JSONL records without throwing", () => {
  const dir = tempDir();
  writeFileSync(join(dir, PAGE_TABLE_FILE), "not json\n{}\n");

  const read = readPageTable(dir);
  assert.equal(read.pages.length, 0);
  assert.equal(read.errors.length, 2);
});

test("readPageTable rejects corrupt nested page records", () => {
  const dir = tempDir();
  const pages = derivePagesFromMarkdown("## General\n- User prefers concise answers.", {
    path: join(dir, "MEMORY.md"),
    sourcePath: "MEMORY.md",
    scope: "global",
  }).pages;
  const page = pages[0];
  assert.ok(page);
  writeFileSync(
    join(dir, PAGE_TABLE_FILE),
    `${JSON.stringify({ ...page, representations: { pointer: {} } })}\n${JSON.stringify({
      ...page,
      tokenEstimate: { pointer: "not a number" },
    })}\n`,
  );

  const read = readPageTable(dir);
  assert.equal(read.pages.length, 0);
  assert.equal(read.errors.length, 2);
});

test("rebuildPageTableFromMarkdown writes sidecar from MEMORY.md", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "MEMORY.md"), "## General\n- User prefers concise answers.");

  const result = rebuildPageTableFromMarkdown(dir, "global");
  assert.equal(result.missing, false);
  assert.equal(result.pagesWritten, 1);

  const read = readPageTable(dir);
  assert.equal(read.pages[0]?.scope, "global");
  assert.equal(read.pages[0]?.type, "preference");
});

test("domain helpers compare fidelity and estimate tokens", () => {
  assert.equal(fidelityAtLeast("structured", "pointer"), true);
  assert.equal(fidelityAtLeast("pointer", "structured"), false);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);

  const page = derivePagesFromMarkdown("## General\n- User prefers concise answers.", {
    path: "MEMORY.md",
    scope: "global",
  }).pages[0];
  assert.ok(page);
  assert.equal(bestAvailableRepresentation(page, "structured")?.fidelity, "full");
});
