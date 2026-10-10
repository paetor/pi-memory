import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGitMemoryScope } from "../src/git-scope.ts";
import { globalMemoryDir, projectMemoryDir } from "../src/storage.ts";

import { gitFixture } from "./helpers.ts";

test("Git root and nested working directory use one private memory scope", () => {
  const { root } = gitFixture();
  const nested = join(root, "src", "deep"); mkdirSync(nested, { recursive: true });
  const scope = resolveGitMemoryScope(nested);
  assert.equal(scope?.root, realpathSync(root));
  assert.equal(scope?.memoryDir, join(realpathSync(join(root, ".git")), "pi-memory"));
  assert.equal(projectMemoryDir(nested), projectMemoryDir(root));
  assert.equal(existsSync(scope!.memoryDir), false, "resolution must not create storage");
});

test("linked worktrees share private memory and private files never enter Git status", () => {
  const { root, base } = gitFixture(); const wt = join(base, "feature worktree");
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "test-feature", wt]);
  assert.equal(projectMemoryDir(root), projectMemoryDir(wt));
  const memory = projectMemoryDir(wt)!; mkdirSync(memory, { mode: 0o700 }); writeFileSync(join(memory, "MEMORY.md"), "- private fixture");
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }), "");
  assert.equal(execFileSync("git", ["-C", wt, "status", "--porcelain"], { encoding: "utf8" }), "");
});

test("different repositories with the same directory basename do not share memory", () => {
  const a = gitFixture(), b = gitFixture(); assert.notEqual(projectMemoryDir(a.root), projectMemoryDir(b.root));
});

test("non-Git and bare repositories have no project memory", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-nongit-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  assert.equal(projectMemoryDir(base), undefined);
  const bare = join(base, "bare.git"); execFileSync("git", ["init", "--bare", "-q", bare]);
  assert.equal(projectMemoryDir(bare), undefined);
});

test("separate Git directories use the actual common metadata directory", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-separate-"));
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "working"), metadata = join(base, "metadata");
  execFileSync("git", ["init", "-q", "--separate-git-dir", metadata, root]);
  assert.equal(projectMemoryDir(root), join(realpathSync(metadata), "pi-memory"));
});

test("symlinked working directories preserve canonical repository identity", () => {
  const { root, base } = gitFixture(); const link = join(base, "repo-link"); symlinkSync(root, link, "dir");
  assert.equal(projectMemoryDir(link), projectMemoryDir(root));
});

test("ambient GIT_DIR and GIT_WORK_TREE cannot redirect the cwd project", () => {
  const a = gitFixture(), b = gitFixture(); const savedDir = process.env.GIT_DIR, savedTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(b.root, ".git"); process.env.GIT_WORK_TREE = b.root;
    assert.equal(projectMemoryDir(a.root), join(realpathSync(join(a.root, ".git")), "pi-memory"));
  } finally {
    if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
    if (savedTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedTree;
  }
});

test("global memory respects Pi agent-directory and existing memory overrides", () => {
  assert.equal(globalMemoryDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent/memory");
  assert.equal(globalMemoryDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent", PI_MEMORY_DIR: "/tmp/existing-memory" }), "/tmp/existing-memory");
});
