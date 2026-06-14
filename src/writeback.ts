import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryFault, MemoryScope, Provenance } from "./memory-domain.ts";
import { rebuildPageTableFromMarkdown } from "./page-table.ts";
import { appendTrace, writebackTrace } from "./trace.ts";
import type { MemoryConfig } from "./storage.ts";

export type WritebackAction = "append" | "merge" | "set_with_version" | "archive" | "reject";
export type WritebackStatus = "pending" | "committed" | "rejected";

export interface WritebackOperation {
  id: string;
  action: WritebackAction;
  status: WritebackStatus;
  scope: MemoryScope;
  text: string;
  topic: string;
  provenance: Provenance[];
  createdAt: string;
  updatedAt: string;
  reason?: string;
}

export interface FlushResult {
  path: string;
  /** Operations newly committed by this flush call. */
  committed: WritebackOperation[];
  /** Operations newly rejected by this flush call. */
  rejected: WritebackOperation[];
  /** Operations intentionally left pending by this flush call. */
  pending: WritebackOperation[];
  faults: MemoryFault[];
}

interface JournalReadResult {
  operations: WritebackOperation[];
  errors: string[];
}

export const WRITEBACK_JOURNAL_FILE = "writeback-journal.jsonl";

export function writebackJournalPath(dir: string): string {
  return join(dir, WRITEBACK_JOURNAL_FILE);
}

export function stageAppendMemory(
  dir: string,
  scope: MemoryScope,
  text: string,
  provenance: Provenance[] = [{ kind: "manual" }],
  topic = "General",
): WritebackOperation {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const operation: WritebackOperation = {
    id: createOperationId(now),
    action: "append",
    status: "pending",
    scope,
    text: text.trim(),
    topic,
    provenance,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(writebackJournalPath(dir), `${JSON.stringify(operation)}\n`, { flag: "a" });
  return operation;
}

export function flushWritebackJournal(dir: string, scope: MemoryScope, config: MemoryConfig): FlushResult {
  const path = writebackJournalPath(dir);
  const journal = readJournal(path);
  const existing: WritebackOperation[] = [];
  const committed: WritebackOperation[] = [];
  const rejected: WritebackOperation[] = [];
  const pending: WritebackOperation[] = [];
  const faults: MemoryFault[] = journal.errors.map((reason) => ({ type: "sidecar_corrupt", reason }));

  if (journal.errors.length > 0) {
    traceFlushIfNeeded(dir, config, path, committed, rejected, pending, faults);
    return { path, committed, rejected, pending, faults };
  }

  for (const operation of journal.operations) {
    if (operation.status !== "pending") {
      existing.push(operation);
      continue;
    }

    const validationError = validateOperation(dir, operation, scope, config);
    if (validationError) {
      const updated = markRejected(operation, validationError);
      rejected.push(updated);
      faults.push({ type: "writeback_rejected", reason: validationError, pageId: operation.id });
      continue;
    }

    try {
      commitAppend(dir, operation);
      committed.push(markCommitted(operation));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "writeback failed";
      const updated = markRejected(operation, reason);
      rejected.push(updated);
      faults.push({ type: "flush_miss", reason, pageId: operation.id });
    }
  }

  rewriteJournal(path, [...existing, ...committed, ...rejected, ...pending]);
  try {
    rebuildPageTableFromMarkdown(dir, scope);
  } catch (error) {
    faults.push({
      type: "flush_miss",
      reason: `page-table rebuild failed after writeback: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
  traceFlushIfNeeded(dir, config, path, committed, rejected, pending, faults);
  return { path, committed, rejected, pending, faults };
}

export function readWritebackJournal(dir: string): WritebackOperation[] {
  return readJournal(writebackJournalPath(dir)).operations;
}

function readJournal(path: string): JournalReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { operations: [], errors: [] };
  }
  const operations: WritebackOperation[] = [];
  const errors: string[] = [];
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isWritebackOperation(parsed)) operations.push(parsed);
      else errors.push(`${path}:${index + 1}: invalid writeback operation`);
    } catch (error) {
      errors.push(`${path}:${index + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  });
  return { operations, errors };
}

function rewriteJournal(path: string, operations: WritebackOperation[]): void {
  if (operations.length === 0 && !existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, operations.map((operation) => JSON.stringify(operation)).join("\n") + (operations.length ? "\n" : ""));
  renameSync(tmpPath, path);
}

function commitAppend(dir: string, operation: WritebackOperation): void {
  const path = join(dir, "MEMORY.md");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "## General\n";
  const needsTopic = !new RegExp(`^##\\s+${escapeRegex(operation.topic)}\\s*$`, "m").test(existing);
  const prefix = existing.endsWith("\n") ? existing : `${existing}\n`;
  const topicHeader = needsTopic ? `\n## ${operation.topic}\n` : "";
  writeFileSync(path, `${prefix}${topicHeader}- ${operation.text}\n`);
}

function validateOperation(
  dir: string,
  operation: WritebackOperation,
  scope: MemoryScope,
  config: MemoryConfig,
): string | undefined {
  if (operation.scope !== scope) return `operation scope ${operation.scope} does not match ${scope}`;
  if (operation.action !== "append") return `action ${operation.action} is not supported by this flush implementation`;
  if (operation.text.trim().length === 0) return "memory text is empty";
  if (exactBulletExists(dir, operation.text)) return "duplicate memory bullet already exists";
  if (config.strictWriteback && operation.scope === "project" && looksSecret(operation.text)) {
    return "project memory appears to contain a secret or credential";
  }
  if (config.strictWriteback && /overwrite|replace entire|delete all/i.test(operation.text)) {
    return "destructive writeback language rejected";
  }
  return undefined;
}

function traceFlushIfNeeded(
  dir: string,
  config: MemoryConfig,
  path: string,
  committed: WritebackOperation[],
  rejected: WritebackOperation[],
  pending: WritebackOperation[],
  faults: MemoryFault[],
): void {
  if (!config.traceEnabled || (committed.length === 0 && rejected.length === 0 && faults.length === 0)) return;
  appendTrace(dir, writebackTrace("writeback journal flush", faults, {
    committed: committed.length,
    rejected: rejected.length,
    pending: pending.length,
    journal: path,
  }));
}

function markCommitted(operation: WritebackOperation): WritebackOperation {
  return { ...operation, status: "committed", updatedAt: new Date().toISOString() };
}

function markRejected(operation: WritebackOperation, reason: string): WritebackOperation {
  return { ...operation, status: "rejected", reason, updatedAt: new Date().toISOString() };
}

function createOperationId(timestamp: string): string {
  return `wb-${timestamp.replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function exactBulletExists(dir: string, text: string): boolean {
  const path = join(dir, "MEMORY.md");
  if (!existsSync(path)) return false;
  const normalized = text.replace(/\s+/g, " ").trim();
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => line.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim() === normalized);
}

function looksSecret(text: string): boolean {
  return /(api[_-]?key|secret|password|token\s*=|sk-[a-z0-9]{12,})/i.test(text);
}

function isWritebackOperation(value: unknown): value is WritebackOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.action === "string"
    && typeof record.status === "string"
    && typeof record.scope === "string"
    && typeof record.text === "string"
    && typeof record.topic === "string"
    && Array.isArray(record.provenance)
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string";
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
