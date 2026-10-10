import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { derivePagesFromMemoryFile } from "./markdown-pages.ts";
import type { MemoryScope } from "./memory-domain.ts";
import {
  formatPageForList,
  readPageTable,
  rebuildPageTableFromMarkdown,
} from "./page-table.ts";
import { readRecentTraces, readTrace, recentFaults } from "./trace.ts";
import {
  globalMemoryDir,
  listMemoryFiles,
  loadConfig,
  projectMemoryDir,
  readIndex,
  type IndexCache,
} from "./storage.ts";
import { flushWritebackJournal, readWritebackJournal, stageAppendMemory } from "./writeback.ts";

export interface MemoryState {
  /** Session toggle; undefined until resolved from the --no-memory flag. */
  enabled: boolean | undefined;
}

interface ResolvedScopes {
  globalDir: string;
  projectDir?: string;
  trusted: boolean;
}

const MAX_LISTED_PAGES = 40;
const MAX_LISTED_ERRORS = 5;

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

function resolveScopes(ctx: ExtensionCommandContext): ResolvedScopes {
  const trusted = ctx.isProjectTrusted();
  return {
    globalDir: globalMemoryDir(),
    projectDir: trusted ? projectMemoryDir(ctx.cwd) : undefined,
    trusted,
  };
}

function scopeReport(label: string, dir: string, cache: IndexCache, config: ReturnType<typeof loadConfig>): string[] {
  const lines = [`${label}: ${dir}/`];
  const files = listMemoryFiles(dir);
  const pageTable = readPageTable(dir);
  const journal = readWritebackJournal(dir);
  if (files.length === 0 && pageTable.missing && journal.length === 0) {
    lines.push("  (empty — nothing saved yet)");
    return lines;
  }
  const index = readIndex(join(dir, "MEMORY.md"), config, cache);
  for (const file of files) {
    if (file.name === "MEMORY.md" && index) {
      const cap = index.truncated
        ? ` — injected ${formatBytes(index.injectedBytes)} of ${formatBytes(index.totalBytes)} (over cap, trim it!)`
        : ` — injected in full (${formatBytes(index.injectedBytes)})`;
      lines.push(`  MEMORY.md${cap}`);
    } else {
      lines.push(`  ${file.name} (${formatBytes(file.bytes)}, read on demand)`);
    }
  }
  if (!pageTable.missing) {
    const status = pageTable.errors.length > 0 ? `, ${pageTable.errors.length} error(s)` : "";
    lines.push(`  page-table.jsonl (${pageTable.pages.length} page(s)${status})`);
  }
  if (journal.length > 0) {
    const pending = journal.filter((operation) => operation.status === "pending").length;
    lines.push(`  writeback-journal.jsonl (${journal.length} operation(s), ${pending} pending)`);
  }
  return lines;
}

function pagesReportForScope(label: string, dir: string, scope: MemoryScope): string[] {
  const extraction = derivePagesFromMemoryFile(dir, scope);
  const sidecar = readPageTable(dir);
  const lines = [`${label}: ${dir}/`];

  if (extraction.missing) {
    lines.push("  MEMORY.md missing; no markdown pages derived");
  } else if (extraction.pages.length === 0) {
    lines.push("  MEMORY.md has no bullet entries to derive as pages");
  } else {
    lines.push(`  derived from MEMORY.md: ${extraction.pages.length} page(s)`);
    for (const page of extraction.pages.slice(0, MAX_LISTED_PAGES)) {
      lines.push(`  - ${formatPageForList(page)}`);
    }
    if (extraction.pages.length > MAX_LISTED_PAGES) {
      lines.push(`  … ${extraction.pages.length - MAX_LISTED_PAGES} more page(s)`);
    }
  }

  if (extraction.warnings.length > 0) {
    lines.push("  warnings:");
    for (const warning of extraction.warnings) lines.push(`    - ${warning}`);
  }

  if (sidecar.missing) {
    lines.push("  page-table.jsonl: missing (run /memory verify to write it)");
  } else {
    const status = sidecar.errors.length > 0 ? ` with ${sidecar.errors.length} error(s)` : "";
    lines.push(`  page-table.jsonl: ${sidecar.pages.length} page(s)${status}`);
    for (const error of sidecar.errors.slice(0, MAX_LISTED_ERRORS)) lines.push(`    - ${error}`);
  }
  return lines;
}

function verifyScope(label: string, dir: string, scope: MemoryScope): string[] {
  const result = rebuildPageTableFromMarkdown(dir, scope);
  const lines = [`${label}: ${dir}/`];
  if (result.missing) {
    lines.push("  skipped: MEMORY.md missing");
  } else {
    lines.push(`  wrote ${result.pagesWritten} page(s) to ${result.path}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  return lines;
}

function flushScope(label: string, dir: string, scope: MemoryScope, config: ReturnType<typeof loadConfig>): string[] {
  const result = flushWritebackJournal(dir, scope, config);
  const lines = [`${label}: ${dir}/`];
  lines.push(`  committed ${result.committed.length}, rejected ${result.rejected.length}, pending ${result.pending.length}`);
  for (const fault of result.faults.slice(0, MAX_LISTED_ERRORS)) {
    lines.push(`  fault: ${fault.type}: ${fault.reason}`);
  }
  return lines;
}

function faultsReport(scopes: ResolvedScopes): string[] {
  const lines = ["Persistent memory recent faults:"];
  const faults = recentFaults(scopes.globalDir, 30);
  if (faults.length === 0) {
    lines.push("  (none recorded)");
    return lines;
  }
  for (const { trace, fault } of faults) {
    lines.push(`  - ${trace.id} ${fault.type}${fault.pageId ? ` ${fault.pageId}` : ""}: ${fault.reason}`);
  }
  return lines;
}

function traceReport(scopes: ResolvedScopes, traceId: string): string[] {
  const trace = readTrace(scopes.globalDir, traceId);
  if (!trace) return [`Trace not found: ${traceId}`];
  return [
    `Trace ${trace.id}`,
    `kind: ${trace.kind}`,
    `timestamp: ${trace.timestamp}`,
    `summary: ${trace.summary}`,
    `faults: ${trace.faults.length}`,
    JSON.stringify(trace.details, null, 2),
  ];
}

function tracesReport(scopes: ResolvedScopes): string[] {
  const result = readRecentTraces(scopes.globalDir, 10);
  const lines = ["Persistent memory recent traces:"];
  if (result.traces.length === 0) lines.push("  (none recorded)");
  for (const trace of result.traces) {
    lines.push(`  - ${trace.id} ${trace.kind} faults=${trace.faults.length} ${trace.summary}`);
  }
  for (const error of result.errors.slice(0, MAX_LISTED_ERRORS)) lines.push(`  error: ${error}`);
  return lines;
}

function stageRemember(scopes: ResolvedScopes, raw: string): string[] {
  const match = raw.match(/^remember\s+(global|project)\s+([\s\S]+)$/i);
  const scopeToken = match?.[1]?.toLowerCase();
  const text = match?.[2]?.trim() ?? "";
  if ((scopeToken !== "global" && scopeToken !== "project") || text.length === 0) {
    return ["Usage: /memory remember global|project <memory text>"];
  }
  if (scopeToken === "project" && !scopes.projectDir) {
    return ["Project memory requires a trusted Git working tree."];
  }
  const dir = scopeToken === "global" ? scopes.globalDir : scopes.projectDir;
  if (!dir) return ["Memory scope unavailable."];
  const op = stageAppendMemory(dir, scopeToken, text, [{ kind: "manual" }]);
  return [`Staged ${scopeToken} memory operation ${op.id}. Run /memory flush to commit.`];
}

export function registerMemoryCommand(pi: ExtensionAPI, state: MemoryState, cache: IndexCache): void {
  pi.registerCommand("memory", {
    description: "Show persistent memory status, or toggle with: /memory on|off",
    getArgumentCompletions: (prefix: string) => {
      const items = ["on", "off", "pages", "verify", "faults", "traces", "trace", "flush", "remember"]
        .filter((v) => v.startsWith(prefix))
        .map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const raw = args.trim();
      const command = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      if (command === "on" || command === "off") {
        state.enabled = command === "on";
        emit(ctx, `Memory injection ${command} for this session.`);
        return;
      }

      const scopes = resolveScopes(ctx);
      const config = loadConfig(scopes.globalDir, scopes.projectDir);

      if (command === "pages") {
        const lines = ["Persistent memory pages:"];
        lines.push(...pagesReportForScope("Global", scopes.globalDir, "global"));
        if (scopes.projectDir) {
          lines.push(...pagesReportForScope("Project", scopes.projectDir, "project"));
        } else {
          lines.push("Project: (no trusted Git working tree — project memory inactive)");
        }
        emit(ctx, lines.join("\n"));
        return;
      }

      if (command === "verify") {
        const lines = ["Persistent memory page-table verification:"];
        lines.push(...verifyScope("Global", scopes.globalDir, "global"));
        if (scopes.projectDir) {
          lines.push(...verifyScope("Project", scopes.projectDir, "project"));
        } else {
          lines.push("Project: (no trusted Git working tree — project memory inactive)");
        }
        emit(ctx, lines.join("\n"));
        return;
      }

      if (command === "flush") {
        const lines = ["Persistent memory writeback flush:"];
        lines.push(...flushScope("Global", scopes.globalDir, "global", config));
        if (scopes.projectDir) lines.push(...flushScope("Project", scopes.projectDir, "project", config));
        else lines.push("Project: (no trusted Git working tree — project memory inactive)");
        emit(ctx, lines.join("\n"));
        return;
      }

      if (command === "faults") {
        emit(ctx, faultsReport(scopes).join("\n"));
        return;
      }

      if (command === "traces") {
        emit(ctx, tracesReport(scopes).join("\n"));
        return;
      }

      if (command === "trace") {
        const traceId = raw.split(/\s+/, 2)[1];
        emit(ctx, traceId ? traceReport(scopes, traceId).join("\n") : "Usage: /memory trace <trace-id>");
        return;
      }

      if (command === "remember") {
        emit(ctx, stageRemember(scopes, raw).join("\n"));
        return;
      }

      const lines: string[] = [];
      const off = state.enabled === false || !config.enabled;
      lines.push(
        `Persistent memory: ${off ? "OFF" : "on"} (caps: ${config.maxInjectLines} lines / ${formatBytes(config.maxInjectBytes)} per scope; page budget: ${config.maxMemoryTokens} tokens)`,
      );
      lines.push(...scopeReport("Global", scopes.globalDir, cache, config));
      if (scopes.projectDir) {
        lines.push(...scopeReport("Project", scopes.projectDir, cache, config));
      } else {
        lines.push("Project: (no trusted Git working tree — project memory inactive)");
      }
      emit(ctx, lines.join("\n"));
    },
  });
}

function emit(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
  } else {
    console.log(text);
  }
}
