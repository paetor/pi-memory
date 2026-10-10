import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createMemorySearch, searchTargets, type QmdRunner, type SearchTarget } from "../src/search.ts";
import { projectMemoryDir } from "../src/storage.ts";
import { gitFixture } from "./helpers.ts";

function fixture() {
  const { base, root } = gitFixture(); const b = gitFixture();
  const global = join(base, "global"), archive = join(base, "history");
  for (const dir of [global, archive, projectMemoryDir(root)!, projectMemoryDir(b.root)!]) {
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "MEMORY.md"), "- fixture scopeprobe\n");
  }
  const saved = { memory: process.env.PI_MEMORY_DIR, archive: process.env.PI_MEMORY_ARCHIVE_DIR };
  process.env.PI_MEMORY_DIR = global; process.env.PI_MEMORY_ARCHIVE_DIR = archive;
  const cleanup = () => {
    if (saved.memory === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = saved.memory;
    if (saved.archive === undefined) delete process.env.PI_MEMORY_ARCHIVE_DIR; else process.env.PI_MEMORY_ARCHIVE_DIR = saved.archive;
  };
  return { root, other: b.root, global, archive, cleanup };
}

function fakeQmd(targets: SearchTarget[]) {
  const calls: string[][] = [];
  const runner: QmdRunner = async args => {
    calls.push([...args]);
    if (args[0] === "collection" && args[1] === "show") {
      const t = targets.find(t => t.collection === args[2]); assert(t);
      return `Collection: ${t.collection}\n  Path:     ${t.path}\n  Pattern:  ${t.mask}\n`;
    }
    if (args[0] === "update" || args[0] === "embed") return "ready";
    const selected = args.flatMap((arg, i) => arg === "-c" ? [args[i + 1]] : []);
    return JSON.stringify(targets.filter(t => selected.includes(t.collection)).map(t => ({
      file: `qmd://${t.collection}/memory.md`, title: `${t.scope} fixture`, score: 1, snippet: "scopeprobe",
    })));
  };
  return { runner, calls };
}

test("default search targets global plus current project, not another project or archive", async () => {
  const f = fixture();
  try {
    const targets = [...searchTargets(f.root, true), ...searchTargets(f.other, true, "project"), ...searchTargets(f.root, true, "archive")];
    const qmd = fakeQmd(targets), search = createMemorySearch(qmd.runner);
    const result = await search({ query: "scopeprobe" }, f.root, true);
    assert.deepEqual(result.map(r => r.scope), ["global", "project"]);
    const query = qmd.calls.find(c => c[0] === "search")!;
    assert(!query.includes(targets.at(-1)!.collection)); assert(!query.includes(targets.at(-2)!.collection));
    assert.deepEqual(query.slice(-2), ["--", "scopeprobe"]);
  } finally { f.cleanup(); }
});

test("untrusted cwd never contributes project config or search targets", async () => {
  const f = fixture();
  try {
    const targets = searchTargets(f.root, false); assert.deepEqual(targets.map(t => t.scope), ["global"]);
    const qmd = fakeQmd(targets); const hits = await createMemorySearch(qmd.runner)({ query: "scopeprobe" }, f.root, false);
    assert.deepEqual(hits.map(h => h.scope), ["global"]);
    assert.throws(() => searchTargets(f.root, false, "project"), /trusted Git/);
  } finally { f.cleanup(); }
});

test("explicit project and archive scopes exclude global and all other scopes", async () => {
  const f = fixture();
  try {
    for (const scope of ["project", "archive"] as const) {
      const targets = searchTargets(f.root, true, scope); const qmd = fakeQmd(targets);
      const hits = await createMemorySearch(qmd.runner)({ query: "scopeprobe", scope }, f.root, true);
      assert.deepEqual(hits.map(h => h.scope), [scope]);
      assert.equal(targets[0]?.mask, scope === "archive" ? "**/*.md" : "*.md");
    }
  } finally { f.cleanup(); }
});

test("project config cannot redirect the historical archive", () => {
  const f = fixture();
  try {
    delete process.env.PI_MEMORY_ARCHIVE_DIR;
    writeFileSync(join(projectMemoryDir(f.root)!, "config.json"), JSON.stringify({ archiveDir: f.other }));
    assert.throws(() => searchTargets(f.root, true, "archive"), /No archive configured/);
    writeFileSync(join(f.global, "config.json"), JSON.stringify({ archiveDir: f.archive }));
    assert.equal(searchTargets(f.root, true, "archive")[0]?.scope, "archive");
  } finally { f.cleanup(); }
});

test("semantic/deep search embeds only selected collections before retrieval", async () => {
  const f = fixture();
  try {
    for (const [mode, command] of [["semantic", "vsearch"], ["deep", "query"]] as const) {
      const targets = searchTargets(f.root, true), qmd = fakeQmd(targets);
      await createMemorySearch(qmd.runner)({ query: "scopeprobe", mode }, f.root, true);
      assert.equal(qmd.calls.filter(c => c[0] === "embed").length, 2);
      assert.equal(qmd.calls.at(-1)?.[0], command);
    }
  } finally { f.cleanup(); }
});

test("unexpected collection results and binding mismatches fail closed", async () => {
  const f = fixture();
  try {
    const targets = searchTargets(f.root, true), qmd = fakeQmd(targets);
    const outside: QmdRunner = args => args[0] === "search"
      ? Promise.resolve(JSON.stringify([{ file: "qmd://other-project/private.md" }])) : qmd.runner(args);
    await assert.rejects(createMemorySearch(outside)({ query: "x" }, f.root, true), /outside the selected/);
    const mismatch: QmdRunner = args => args[0] === "collection"
      ? Promise.resolve("  Path:     /wrong\n  Pattern:  *.md\n") : qmd.runner(args);
    await assert.rejects(createMemorySearch(mismatch)({ query: "x" }, f.root, true), /binding mismatch/);
  } finally { f.cleanup(); }
});

test("invalid requests do not execute QMD and failed requests do not poison the queue", async () => {
  const f = fixture();
  try {
    const qmd = fakeQmd(searchTargets(f.root, true)), search = createMemorySearch(qmd.runner);
    await assert.rejects(search({ query: " " }, f.root, true), /query/);
    await assert.rejects(search({ query: "x", limit: 21 }, f.root, true), /limit/);
    assert.equal(qmd.calls.length, 0);
    assert.equal((await search({ query: "x" }, f.root, true)).length, 2);
  } finally { f.cleanup(); }
});

test("parallel requests serialize QMD mutations and dependent retrieval", async () => {
  const f = fixture();
  try {
    const qmd = fakeQmd(searchTargets(f.root, true)); let active = 0, peak = 0;
    const runner: QmdRunner = async args => { active++; peak = Math.max(peak, active); await setTimeout(2); try { return await qmd.runner(args); } finally { active--; } };
    const search = createMemorySearch(runner);
    await Promise.all([search({ query: "first" }, f.root, true), search({ query: "second" }, f.root, true)]);
    assert.equal(peak, 1); assert.equal(qmd.calls.filter(c => c[0] === "search").length, 2);
  } finally { f.cleanup(); }
});

test("non-Git cwd remains global-only and empty existing scopes do not create memory folders", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-empty-"));
  const saved = process.env.PI_MEMORY_DIR;
  try { process.env.PI_MEMORY_DIR = join(base, "missing"); assert.deepEqual(searchTargets(base, true), []); }
  finally { if (saved === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = saved; rmSync(base, { recursive: true, force: true }); }
});
