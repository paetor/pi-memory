import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface GitMemoryScope {
  /** Current checkout root; may be a linked worktree. */
  root: string;
  /** Canonical common Git directory, shared by linked worktrees. */
  commonDir: string;
  /** Private, untracked memory; moves with the repository metadata. */
  memoryDir: string;
}

/** Resolve actual Git metadata, not a basename or the shell's GIT_DIR override. */
export function resolveGitMemoryScope(cwd: string): GitMemoryScope | undefined {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
  try {
    const output = execFileSync("git", [
      "-C", resolve(cwd), "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir",
    ], { encoding: "utf8", env, timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const lines = output.trimEnd().split(/\r?\n/);
    if (lines.length !== 2 || !lines[0] || !lines[1]) return undefined;
    const root = realpathSync(lines[0]);
    const commonDir = realpathSync(lines[1]);
    const rel = relative(root, realpathSync(cwd));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
    return { root, commonDir, memoryDir: join(commonDir, "pi-memory") };
  } catch {
    // Non-Git/bare directories, unavailable Git and invalid metadata have no project scope.
    return undefined;
  }
}
