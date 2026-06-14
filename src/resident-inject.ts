import { buildMemoryBlock } from "./inject.ts";
import { derivePagesFromMemoryFile } from "./markdown-pages.ts";
import type { MemoryFault, MemoryPage, MemoryScope } from "./memory-domain.ts";
import { readPageTable } from "./page-table.ts";
import { residencyTrace, appendTrace } from "./trace.ts";
import { selectResidentPages, type ResidentPage, type ResidencyDecision } from "./residency.ts";
import { readIndex, type IndexCache, type MemoryConfig } from "./storage.ts";
import { join } from "node:path";

export interface RuntimeMemoryOptions {
  globalDir: string;
  projectDir?: string;
  config: MemoryConfig;
  cache: IndexCache;
}

interface PageSource {
  pages: MemoryPage[];
  faults: MemoryFault[];
  source: "page-table" | "markdown" | "missing" | "error";
}

interface ScopedPages {
  label: "Global" | "Project";
  dir: string;
  scope: MemoryScope;
  source: PageSource;
}

/**
 * Build the memory block used by pi prompt injection.
 *
 * If ClawVM-style page-table injection is enabled and at least one valid page
 * is available, this renders a deterministic resident set. Otherwise it falls
 * back to the original capped MEMORY.md block, preserving v1 behavior.
 */
export function buildRuntimeMemoryBlock(opts: RuntimeMemoryOptions): string {
  if (!opts.config.pageTableInjection) return buildLegacyBlock(opts);

  const scopes = loadScopedPages(opts);
  const pages = scopes.flatMap((scope) => scope.source.pages);
  const loadFaults = scopes.flatMap((scope) => scope.source.faults);
  if (pages.length === 0) return buildLegacyBlock(opts);

  const selected = selectResidentPages(pages, { budgetTokens: opts.config.maxMemoryTokens });
  const decision: ResidencyDecision = { ...selected, faults: [...selected.faults, ...loadFaults] };

  if (opts.config.traceEnabled) {
    appendTrace(opts.globalDir, residencyTrace(decision, "resident memory prompt injection"));
  }

  return renderResidentBlock(scopes, decision, opts.config);
}

function loadScopedPages(opts: RuntimeMemoryOptions): ScopedPages[] {
  const scopes: ScopedPages[] = [
    { label: "Global", dir: opts.globalDir, scope: "global", source: loadPages(opts.globalDir, "global") },
  ];
  if (opts.projectDir) {
    scopes.push({ label: "Project", dir: opts.projectDir, scope: "project", source: loadPages(opts.projectDir, "project") });
  }
  return scopes;
}

function loadPages(dir: string, scope: MemoryScope): PageSource {
  const table = readPageTable(dir);
  if (!table.missing && table.errors.length === 0 && table.pages.length > 0) {
    return { pages: table.pages, faults: [], source: "page-table" };
  }
  if (!table.missing && table.errors.length > 0) {
    return {
      pages: [],
      faults: table.errors.map((error) => ({ type: "sidecar_corrupt", reason: error })),
      source: "error",
    };
  }

  const extraction = derivePagesFromMemoryFile(dir, scope);
  if (extraction.missing) return { pages: [], faults: [], source: "missing" };
  return {
    pages: extraction.pages,
    faults: extraction.warnings.map((warning) => ({ type: "sidecar_corrupt", reason: `markdown: ${warning}` })),
    source: "markdown",
  };
}

function buildLegacyBlock(opts: RuntimeMemoryOptions): string {
  return buildMemoryBlock({
    globalDir: opts.globalDir,
    projectDir: opts.projectDir,
    globalIndex: readIndex(join(opts.globalDir, "MEMORY.md"), opts.config, opts.cache),
    projectIndex: opts.projectDir ? readIndex(join(opts.projectDir, "MEMORY.md"), opts.config, opts.cache) : undefined,
  });
}

function renderResidentBlock(scopes: ScopedPages[], decision: ResidencyDecision, config: MemoryConfig): string {
  const selectedByScope = new Map<MemoryScope, ResidentPage[]>();
  for (const resident of decision.selected) {
    const current = selectedByScope.get(resident.page.scope) ?? [];
    current.push(resident);
    selectedByScope.set(resident.page.scope, current);
  }

  const parts = [
    "## Persistent memory",
    "",
    "You have ClawVM-style persistent memory, separate from AGENTS.md (which is user-authored — never write memory there).",
    "",
    ...scopes.map((scope) => `- ${scope.label} memory: ${scope.dir}/ (${scope.source.source})`),
    "",
    "Project memory is committed to the repo and shared with the team; keep it factual, professional, and free of secrets.",
    "Each scope has a MEMORY.md index plus topic files read on demand.",
    `The harness selected ${decision.selected.length} memory page(s), using ${decision.usedTokens}/${config.maxMemoryTokens} estimated tokens.`,
    "Use selected pages as durable context. If a pointer is relevant but insufficient, read the referenced MEMORY.md or topic file on demand.",
    "Rules: check existing MEMORY.md entries before adding duplicates; use topic files for detail; archive stale entries; never store secrets in project memory; do not save what code, git history, or AGENTS.md already records.",
  ];

  for (const scope of scopes) {
    const selected = selectedByScope.get(scope.scope) ?? [];
    parts.push("", `### ${scope.label} selected memory pages`);
    if (selected.length === 0) {
      parts.push("(none selected)");
      continue;
    }
    for (const resident of selected) {
      parts.push(
        `- [${resident.page.type}/${resident.fidelity}] ${resident.page.title}`,
        `  id: ${resident.page.id}`,
        `  source: ${formatSource(resident.page)}`,
        indentBlock(resident.representation.content),
      );
    }
  }

  if (decision.faults.length > 0) {
    parts.push("", "### Memory faults");
    for (const fault of decision.faults) {
      parts.push(`- ${fault.type}${fault.pageId ? ` (${fault.pageId})` : ""}: ${fault.reason}`);
    }
  }
  return parts.join("\n");
}

function indentBlock(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function formatSource(page: MemoryPage): string {
  const provenance = page.provenance[0];
  if (!provenance?.path) return "unknown";
  return `${provenance.path}${provenance.lineStart ? `:${provenance.lineStart}` : ""}`;
}
