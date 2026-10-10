import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories = new Set<string>();
process.once("exit", () => { for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true }); });

export function gitFixture() {
  const base = mkdtempSync(join(tmpdir(), "pi-memory-git-"));
  const root = join(base, "repo with spaces");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Memory test", "-c", "user.email=memory@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"]);
  temporaryDirectories.add(base);
  return { base, root };
}
