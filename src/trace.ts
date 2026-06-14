import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFault } from "./memory-domain.ts";
import type { ResidencyDecision } from "./residency.ts";

export type MemoryTraceKind = "residency" | "writeback" | "verify";

export interface MemoryTrace {
  id: string;
  kind: MemoryTraceKind;
  timestamp: string;
  summary: string;
  faults: MemoryFault[];
  details: Record<string, unknown>;
}

export interface TraceReadResult {
  traces: MemoryTrace[];
  errors: string[];
}

const TRACE_DIR = "traces";
const MAX_TRACE_FILES = 14;

export function createTraceId(kind: MemoryTraceKind, timestamp = new Date()): string {
  const stamp = timestamp.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${kind}-${stamp}-${suffix}`;
}

export function traceDir(memoryDir: string): string {
  return join(memoryDir, TRACE_DIR);
}

export function appendTrace(memoryDir: string, trace: MemoryTrace): void {
  const dir = traceDir(memoryDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(traceFileForDate(dir, new Date(trace.timestamp)), `${JSON.stringify(trace)}\n`, { flag: "a" });
  rotateTraceFiles(dir);
}

export function residencyTrace(decision: ResidencyDecision, summary: string): MemoryTrace {
  const timestamp = new Date().toISOString();
  return {
    id: createTraceId("residency", new Date(timestamp)),
    kind: "residency",
    timestamp,
    summary,
    faults: decision.faults,
    details: {
      budgetTokens: decision.budgetTokens,
      usedTokens: decision.usedTokens,
      selected: decision.selected.map((resident) => ({
        pageId: resident.page.id,
        type: resident.page.type,
        scope: resident.page.scope,
        fidelity: resident.fidelity,
        tokens: resident.representation.tokenEstimate,
        reason: resident.reason,
      })),
      omitted: decision.omitted,
    },
  };
}

export function writebackTrace(summary: string, faults: MemoryFault[], details: Record<string, unknown>): MemoryTrace {
  const timestamp = new Date().toISOString();
  return {
    id: createTraceId("writeback", new Date(timestamp)),
    kind: "writeback",
    timestamp,
    summary,
    faults,
    details,
  };
}

export function readRecentTraces(memoryDir: string, limit = 50): TraceReadResult {
  const dir = traceDir(memoryDir);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return { traces: [], errors: [] };
  }

  const traces: MemoryTrace[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).reverse();
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : "read failed"}`);
      continue;
    }
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isMemoryTrace(parsed)) traces.push(parsed);
        else errors.push(`${path}: invalid trace record`);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
      }
      if (traces.length >= limit) return { traces, errors };
    }
  }
  return { traces, errors };
}

export function readTrace(memoryDir: string, traceId: string): MemoryTrace | undefined {
  return readRecentTraces(memoryDir, 500).traces.find((trace) => trace.id === traceId);
}

export function recentFaults(memoryDir: string, limit = 20): Array<{ trace: MemoryTrace; fault: MemoryFault }> {
  const faults: Array<{ trace: MemoryTrace; fault: MemoryFault }> = [];
  for (const trace of readRecentTraces(memoryDir, 100).traces) {
    for (const fault of trace.faults) {
      faults.push({ trace, fault });
      if (faults.length >= limit) return faults;
    }
  }
  return faults;
}

function traceFileForDate(dir: string, date: Date): string {
  return join(dir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

function rotateTraceFiles(dir: string): void {
  let files: Array<{ name: string; mtimeMs: number }>;
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  for (const file of files.slice(MAX_TRACE_FILES)) {
    try {
      unlinkSync(join(dir, file.name));
    } catch {
      // Best-effort rotation; failed cleanup must not block memory injection.
    }
  }
}

function isMemoryTrace(value: unknown): value is MemoryTrace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && (record.kind === "residency" || record.kind === "writeback" || record.kind === "verify")
    && typeof record.timestamp === "string"
    && typeof record.summary === "string"
    && Array.isArray(record.faults)
    && typeof record.details === "object"
    && record.details !== null;
}
