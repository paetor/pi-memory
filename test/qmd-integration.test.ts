import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemorySearch } from "../src/search.ts";
import { projectMemoryDir } from "../src/storage.ts";
import { gitFixture } from "./helpers.ts";

const enabled = process.env.PI_MEMORY_QMD_TESTS === "1";
test("real QMD isolates global/project/archive, excludes other projects and refreshes edits", {
  skip: enabled ? false : "set PI_MEMORY_QMD_TESTS=1 for isolated real QMD tests", timeout: 180_000,
}, async () => {
  const a = gitFixture(), b = gitFixture(), base = mkdtempSync(join(tmpdir(), "pi-memory-qmd-"));
  const old = { cache: process.env.XDG_CACHE_HOME, config: process.env.XDG_CONFIG_HOME, memory: process.env.PI_MEMORY_DIR, archive: process.env.PI_MEMORY_ARCHIVE_DIR };
  const cache = join(base, "cache"), config = join(base, "config");
  const modelCache = join(old.cache ?? join(homedir(), ".cache"), "qmd", "models");
  const global = join(base, "global"), archive = join(base, "archive");
  try {
    process.env.XDG_CACHE_HOME = cache; process.env.XDG_CONFIG_HOME = config;
    process.env.PI_MEMORY_DIR = global; process.env.PI_MEMORY_ARCHIVE_DIR = archive;
    for (const dir of [global, archive, projectMemoryDir(a.root)!, projectMemoryDir(b.root)!]) mkdirSync(dir, { recursive: true });
    mkdirSync(join(cache, "qmd"), { recursive: true });
    if (existsSync(modelCache)) symlinkSync(realpathSync(modelCache), join(cache, "qmd", "models"), "dir");
    writeFileSync(join(global, "MEMORY.md"), "# Global\n- scopeprobe global preference: concise engineering answers.\n");
    writeFileSync(join(projectMemoryDir(a.root)!, "MEMORY.md"), "# Project A\n- scopeprobe project-a convention: use npm for builds.\n");
    writeFileSync(join(projectMemoryDir(b.root)!, "MEMORY.md"), "# Project B\n- scopeprobe project-b convention: use pnpm for builds.\n");
    writeFileSync(join(archive, "historical.md"), "# History\n- scopeprobe archived historical decision.\n");
    mkdirSync(join(global, "archive")); writeFileSync(join(global, "archive", "old.md"), "- scopeprobe stale hidden active memory\n");
    const search = createMemorySearch();
    await search({ query: "scopeprobe", scope: "project" }, b.root, true); // B exists in the same derived index.
    const active = await search({ query: "scopeprobe" }, a.root, true);
    assert.deepEqual(new Set(active.map(h => h.scope)), new Set(["global", "project"]));
    assert(!active.some(h => h.snippet.includes("project-b") || h.snippet.includes("historical") || h.snippet.includes("stale hidden")));
    const history = await search({ query: "scopeprobe", scope: "archive" }, a.root, true);
    assert(history.length > 0 && history.every(h => h.scope === "archive"));
    writeFileSync(join(projectMemoryDir(a.root)!, "MEMORY.md"), "# Project A\n- freshmemorytoken updated convention.\n");
    const fresh = await search({ query: "freshmemorytoken" }, a.root, true);
    assert(fresh.some(h => h.scope === "project"));
    const untrusted = await search({ query: "scopeprobe" }, a.root, false);
    assert(untrusted.length > 0 && untrusted.every(h => h.scope === "global"));
    if (process.env.PI_MEMORY_QMD_AI_TESTS === "1") {
      assert(existsSync(modelCache), "AI test requires preinstalled local QMD models");
      for (const mode of ["semantic", "deep"] as const) {
        const hits = await search({ query: "engineering preferences and project build conventions", mode }, a.root, true);
        assert(hits.length > 0); assert(hits.every(h => h.scope === "global" || h.scope === "project"));
        assert(!hits.some(h => h.snippet.includes("project-b") || h.snippet.includes("historical")));
      }
    }
  } finally {
    for (const [key, value] of Object.entries({ XDG_CACHE_HOME: old.cache, XDG_CONFIG_HOME: old.config, PI_MEMORY_DIR: old.memory, PI_MEMORY_ARCHIVE_DIR: old.archive })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
});
