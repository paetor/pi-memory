import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derivePagesFromMemoryFile } from "./markdown-pages.ts";
import { isMemoryPage, type MemoryPage, type MemoryScope } from "./memory-domain.ts";

export const PAGE_TABLE_FILE = "page-table.jsonl";

export interface PageTableReadResult {
  path: string;
  pages: MemoryPage[];
  errors: string[];
  missing: boolean;
}

export interface PageTableWriteResult {
  path: string;
  pagesWritten: number;
}

export interface PageTableRebuildResult {
  path: string;
  pagesWritten: number;
  warnings: string[];
  missing: boolean;
}

export function pageTablePath(dir: string): string {
  return join(dir, PAGE_TABLE_FILE);
}

export function readPageTable(dir: string): PageTableReadResult {
  const path = pageTablePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { path, pages: [], errors: [], missing: true };
    return {
      path,
      pages: [],
      errors: [`could not read ${path}: ${error instanceof Error ? error.message : "unknown error"}`],
      missing: false,
    };
  }

  const pages: MemoryPage[] = [];
  const errors: string[] = [];
  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isMemoryPage(parsed)) {
        pages.push(parsed);
      } else {
        errors.push(`${path}:${index + 1}: invalid memory page record`);
      }
    } catch (error) {
      errors.push(`${path}:${index + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  });

  return { path, pages, errors, missing: false };
}

export function writePageTable(dir: string, pages: MemoryPage[]): PageTableWriteResult {
  mkdirSync(dir, { recursive: true });
  const path = pageTablePath(dir);
  const tmpPath = `${path}.${process.pid}.tmp`;
  // Stable key order makes JSONL sidecars easier for users and agents to diff.
  const body = pages.map(serializePage).join("\n");
  writeFileSync(tmpPath, body.length > 0 ? `${body}\n` : "");
  renameSync(tmpPath, path);
  return { path, pagesWritten: pages.length };
}

export function rebuildPageTableFromMarkdown(dir: string, scope: MemoryScope): PageTableRebuildResult {
  const extraction = derivePagesFromMemoryFile(dir, scope);
  if (extraction.missing) {
    return {
      path: pageTablePath(dir),
      pagesWritten: 0,
      warnings: [`${extraction.path} does not exist; page table not written`],
      missing: true,
    };
  }

  const written = writePageTable(dir, extraction.pages);
  return {
    path: written.path,
    pagesWritten: written.pagesWritten,
    warnings: extraction.warnings,
    missing: false,
  };
}

export function formatPageForList(page: MemoryPage): string {
  const provenance = page.provenance[0];
  const source = provenance?.path
    ? `${provenance.path}${provenance.lineStart ? `:${provenance.lineStart}` : ""}`
    : "unknown source";
  const pins = page.pins.length > 0 ? page.pins.join(",") : "none";
  return `${page.id} ${page.type} min=${page.minFidelity} pins=${pins} ${source} — ${page.title}`;
}

function serializePage(page: MemoryPage): string {
  return JSON.stringify({
    id: page.id,
    type: page.type,
    scope: page.scope,
    title: page.title,
    provenance: page.provenance,
    minFidelity: page.minFidelity,
    representations: page.representations,
    pins: page.pins,
    tokenEstimate: page.tokenEstimate,
    recomputeCost: page.recomputeCost,
    dirty: page.dirty,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    version: page.version,
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
