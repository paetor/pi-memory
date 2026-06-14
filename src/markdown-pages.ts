import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  estimateTokens,
  minFidelityForType,
  pinsForType,
  type Fidelity,
  type MemoryPage,
  type MemoryScope,
  type PageRepresentation,
  type PageType,
} from "./memory-domain.ts";

export interface MarkdownPageExtraction {
  path: string;
  pages: MemoryPage[];
  warnings: string[];
  missing: boolean;
}

const UNKNOWN_TIME = "unknown";

export function derivePagesFromMemoryFile(dir: string, scope: MemoryScope): MarkdownPageExtraction {
  const path = join(dir, "MEMORY.md");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { path, pages: [], warnings: [], missing: true };
    return {
      path,
      pages: [],
      warnings: [`could not read ${path}: ${error instanceof Error ? error.message : "unknown error"}`],
      missing: false,
    };
  }
  return derivePagesFromMarkdown(raw, { path, scope, sourcePath: "MEMORY.md" });
}

export function derivePagesFromMarkdown(
  raw: string,
  opts: { path: string; scope: MemoryScope; sourcePath?: string },
): MarkdownPageExtraction {
  const pages: MemoryPage[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const sourcePath = opts.sourcePath ?? opts.path;
  const lines = raw.split("\n");
  let topic = "General";

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const heading = line.match(/^##+\s+(.+?)\s*$/);
    if (heading?.[1]) {
      topic = stripMarkdown(heading[1]);
      return;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet?.[1]) return;

    const rawText = bullet[1].trim();
    const text = stripMarkdown(rawText);
    if (text.length === 0) {
      warnings.push(`ignored empty bullet at ${sourcePath}:${lineNumber}`);
      return;
    }

    const page = pageFromBullet({ scope: opts.scope, sourcePath, topic, rawText, text, lineNumber });
    if (seenIds.has(page.id)) {
      warnings.push(`duplicate page id ${page.id} at ${sourcePath}:${lineNumber}`);
    }
    seenIds.add(page.id);
    pages.push(page);
  });

  return { path: opts.path, pages, warnings, missing: false };
}

function pageFromBullet(args: {
  scope: MemoryScope;
  sourcePath: string;
  topic: string;
  rawText: string;
  text: string;
  lineNumber: number;
}): MemoryPage {
  const type = classifyPage(args.topic, args.text);
  const minFidelity = minFidelityForType(type);
  const structured = representation("structured", structuredContent(args.topic, args.text));
  const pointer = representation("pointer", `${args.sourcePath}:${args.lineNumber} (${args.topic})`);
  const full = representation("full", args.rawText);
  const representations: MemoryPage["representations"] = { pointer, structured, full };

  return {
    id: stablePageId(args.scope, args.topic, args.text),
    type,
    scope: args.scope,
    title: titleFromText(args.text),
    provenance: [
      {
        kind: "memory_index",
        path: args.sourcePath,
        lineStart: args.lineNumber,
        lineEnd: args.lineNumber,
        topic: args.topic,
      },
    ],
    minFidelity,
    representations,
    pins: pinsForType(type),
    tokenEstimate: {
      pointer: pointer.tokenEstimate,
      structured: structured.tokenEstimate,
      full: full.tokenEstimate,
    },
    dirty: false,
    createdAt: UNKNOWN_TIME,
    updatedAt: UNKNOWN_TIME,
    version: 1,
  };
}

function classifyPage(topic: string, text: string): PageType {
  const haystack = `${topic} ${text}`.toLowerCase();
  if (hasAny(haystack, ["must", "always", "never", "required", "constraint", "uses npm", "not pnpm"])) {
    return "constraint";
  }
  if (hasAny(haystack, ["procedure", "workflow", "runbook", "build", "test", "deploy", "command"])) {
    return "procedure";
  }
  if (hasAny(haystack, ["bootstrap", "protocol", "instruction", "preamble"])) return "bootstrap_policy";
  if (hasAny(haystack, ["decision", "decided", "rationale"])) return "decision";
  if (hasAny(haystack, ["plan", "todo", "next step", "roadmap", "milestone"])) return "plan";
  if (hasAny(haystack, ["evidence", "source", "paper", "citation", "url", "arxiv"])) return "evidence";
  if (hasAny(haystack, ["preference", "prefers", "style", "likes", "dislikes"])) return "preference";
  return "preference";
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function representation(fidelity: Fidelity, content: string): PageRepresentation {
  return { fidelity, content, tokenEstimate: estimateTokens(content) };
}

function structuredContent(topic: string, text: string): string {
  return `Topic: ${topic}\nMemory: ${text}`;
}

function stablePageId(scope: MemoryScope, topic: string, text: string): string {
  const hash = createHash("sha256")
    .update(scope)
    .update("\0")
    .update(topic)
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 16);
  return `${scope}:${hash}`;
}

function titleFromText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 96) return compact;
  return `${compact.slice(0, 95).trimEnd()}…`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\s+/g, " ")
    .trim();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
