import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { globalMemoryDir, loadConfig, projectMemoryDir } from "./storage.ts";

export type SearchScope = "active" | "global" | "project" | "archive";
export type SearchMode = "keyword" | "semantic" | "deep";
export interface SearchRequest { query: string; scope?: SearchScope; mode?: SearchMode; limit?: number }
export interface SearchTarget { scope: "global" | "project" | "archive"; path: string; collection: string; mask: string }
export interface SearchHit { scope: SearchTarget["scope"]; file: string; title: string; score: number; snippet: string }
export type QmdRunner = (args: string[], signal?: AbortSignal) => Promise<string>;

class QmdFailure extends Error {
  readonly stderr: string;
  constructor(stderr: string) { super(`QMD failed: ${stderr.slice(0, 1000)}`); this.stderr = stderr; }
}

export const runQmd: QmdRunner = (args, signal) => new Promise((resolveOutput, reject) => {
  // A named index ignores unrelated project-local .qmd config and preserves existing indexes.
  execFile("qmd", ["--index", "pi-memory-fork", ...args], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout, stderr) => {
    if (error) reject(new QmdFailure(stderr || (error.code === "ENOENT" ? "qmd is not installed/on PATH" : error.message)));
    else resolveOutput(stdout);
  });
});

/** The archive location is user-global configuration, never supplied by a project. */
export function archiveMemoryDir(globalDir: string): string | undefined {
  if (process.env.PI_MEMORY_ARCHIVE_DIR) return resolve(process.env.PI_MEMORY_ARCHIVE_DIR);
  try {
    const config: unknown = JSON.parse(readFileSync(join(globalDir, "config.json"), "utf8"));
    if (config && typeof config === "object" && "archiveDir" in config && typeof config.archiveDir === "string") {
      return resolve(config.archiveDir);
    }
  } catch { /* No archive is configured. */ }
  return undefined;
}

function target(scope: SearchTarget["scope"], dir: string): SearchTarget | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
    const path = realpathSync(dir);
    const id = createHash("sha256").update(path).digest("hex").slice(0, 24);
    return { scope, path, collection: `pm-${scope}-${id}`, mask: scope === "archive" ? "**/*.md" : "*.md" };
  } catch { return undefined; }
}

export function searchTargets(cwd: string, trusted: boolean, scope: SearchScope = "active"): SearchTarget[] {
  const globalDir = globalMemoryDir();
  if (scope === "archive") {
    const archiveDir = archiveMemoryDir(globalDir);
    if (!archiveDir) throw new Error("No archive configured. Set archiveDir in global memory/config.json or PI_MEMORY_ARCHIVE_DIR.");
    const archive = target("archive", archiveDir);
    if (!archive) throw new Error("Configured archive directory is unavailable.");
    return [archive];
  }
  const targets: SearchTarget[] = [];
  if (scope === "active" || scope === "global") {
    const global = target("global", globalDir);
    if (global) targets.push(global);
  }
  if (scope === "active" || scope === "project") {
    const dir = trusted ? projectMemoryDir(cwd) : undefined;
    if (scope === "project" && !dir) throw new Error("Project memory requires a trusted Git working tree.");
    const project = dir ? target("project", dir) : undefined;
    if (project) targets.push(project);
  }
  return targets;
}

async function ensureCollection(t: SearchTarget, runner: QmdRunner, signal?: AbortSignal): Promise<void> {
  let existing: string;
  try { existing = await runner(["collection", "show", t.collection], signal); }
  catch (error) {
    if (!(error instanceof QmdFailure) || !error.stderr.includes(`Collection not found: ${t.collection}`)) throw error;
    await runner(["collection", "add", t.path, "--name", t.collection, "--mask", t.mask], signal);
    existing = await runner(["collection", "show", t.collection], signal);
  }
  const path = existing.match(/^\s+Path:\s+(.+)$/m)?.[1]?.trimEnd();
  const mask = existing.match(/^\s+Pattern:\s+(.+)$/m)?.[1]?.trimEnd();
  if (path !== t.path || mask !== t.mask) throw new Error(`QMD collection binding mismatch: ${t.collection}`);
  await runner(["update", "-c", t.collection], signal);
}

function hitsFromJson(output: string, targets: SearchTarget[]): SearchHit[] {
  const data: unknown = JSON.parse(output);
  if (!Array.isArray(data)) throw new Error("Unexpected QMD search output; expected a JSON array.");
  return data.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("file" in item) || typeof item.file !== "string") {
      throw new Error("Malformed QMD search hit.");
    }
    const file = item.file;
    const t = targets.find(t => file.startsWith(`qmd://${t.collection}/`));
    if (!t) throw new Error("QMD returned a result outside the selected memory scopes.");
    return {
      scope: t.scope, file,
      title: "title" in item && typeof item.title === "string" ? item.title : item.file,
      score: "score" in item && typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0,
      snippet: "snippet" in item && typeof item.snippet === "string" ? item.snippet.slice(0, 4000) : "",
    };
  });
}

/** Serialize derived-index mutations and their dependent searches in one Pi process. */
export function createMemorySearch(runner: QmdRunner = runQmd) {
  let queue: Promise<unknown> = Promise.resolve();
  return (request: SearchRequest, cwd: string, trusted: boolean, signal?: AbortSignal): Promise<SearchHit[]> => {
    const pending = queue.then(async () => {
      const query = request.query.trim();
      if (!query || query.length > 4000) throw new Error("Memory query must contain 1–4000 characters.");
      const limit = request.limit ?? 8;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Memory result limit must be an integer from 1 to 20.");
      const scope = request.scope ?? "active", mode = request.mode ?? "keyword";
      if (!["active", "global", "project", "archive"].includes(scope)) throw new Error("Unknown memory scope.");
      if (!["keyword", "semantic", "deep"].includes(mode)) throw new Error("Unknown memory search mode.");
      const targets = searchTargets(cwd, trusted, scope);
      if (!targets.length) return [];
      for (const t of targets) {
        await ensureCollection(t, runner, signal);
        if (mode !== "keyword") await runner(["embed", "-c", t.collection, "--timeout", "1"], signal);
      }
      const command = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
      const args = [command, "--json", "-n", String(limit)];
      for (const t of targets) args.push("-c", t.collection);
      args.push("--", query);
      return hitsFromJson(await runner(args, signal), targets).slice(0, limit);
    });
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
}

export function registerMemorySearch(pi: ExtensionAPI): void {
  const search = createMemorySearch();
  pi.registerTool({
    name: "memory_search", label: "Memory Search",
    description: "Search private Markdown memory with local QMD. Defaults to global + current trusted Git project; linked worktrees share project memory. Archive is excluded unless scope=archive. Refreshes only the selected derived indexes; semantic/deep modes generate local embeddings. Does not write source memories or call a remote model.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4000 }),
      scope: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("global"), Type.Literal("project"), Type.Literal("archive")])),
      mode: Type.Optional(Type.Union([Type.Literal("keyword"), Type.Literal("semantic"), Type.Literal("deep")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params: SearchRequest, signal, _onUpdate, ctx: ExtensionContext) {
      const project = ctx.isProjectTrusted() ? projectMemoryDir(ctx.cwd) : undefined;
      if (!loadConfig(globalMemoryDir(), project).enabled || pi.getFlag("no-memory") === true) {
        throw new Error("Persistent memory is disabled.");
      }
      const hits = await search(params, ctx.cwd, ctx.isProjectTrusted(), signal);
      const text = hits.length ? hits.map(hit => `[${hit.scope}] ${hit.title}\n${hit.file}\n${hit.snippet}`).join("\n\n") : "No matching memories in the selected scopes.";
      return { content: [{ type: "text", text }], details: { scope: params.scope ?? "active", hits } };
    },
  });
}
