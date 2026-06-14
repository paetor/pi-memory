/**
 * Domain vocabulary for ClawVM-style memory.
 *
 * The intended data flow is:
 *   MEMORY.md bullets -> typed MemoryPage records -> page-table.jsonl ->
 *   future prompt residency, recall, writeback, and fault traces.
 *
 * Keep this file mostly declarative so future agents can learn the memory
 * model before reading parsing, persistence, or command code.
 */
export type MemoryScope = "global" | "project" | "session" | "local";

export type PageType =
  | "bootstrap_policy"
  | "constraint"
  | "plan"
  | "preference"
  | "evidence"
  | "conversation_segment"
  | "decision"
  | "procedure";

export type Fidelity = "pointer" | "structured" | "compressed" | "full";

export type PinClass = "hard" | "active" | "soft";

export interface Provenance {
  kind: "memory_index" | "topic_file" | "tool_result" | "session" | "manual" | "import";
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  topic?: string;
  sessionId?: string;
  entryId?: string;
  url?: string;
}

export interface PageRepresentation {
  fidelity: Fidelity;
  content: string;
  tokenEstimate: number;
}

export interface MemoryPage {
  id: string;
  type: PageType;
  scope: MemoryScope;
  title: string;
  provenance: Provenance[];
  minFidelity: Fidelity;
  representations: Partial<Record<Fidelity, PageRepresentation>>;
  pins: PinClass[];
  tokenEstimate: Partial<Record<Fidelity, number>>;
  recomputeCost?: number;
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface MemoryFault {
  type:
    | "pinned_invariant_miss"
    | "post_compaction_bootstrap_loss"
    | "flush_miss"
    | "silent_recall"
    | "writeback_rejected"
    | "sidecar_corrupt"
    | "duplicate_tool_signature"
    | "refetch"
    | "invariant_pressure";
  reason: string;
  pageId?: string;
  traceId?: string;
}

export interface RecallResult {
  status: "ok" | "no_match" | "denied" | "malformed" | "unavailable" | "backend_error";
  pages: MemoryPage[];
  reason: string;
  traceId: string;
}

export const FIDELITY_ORDER: readonly Fidelity[] = ["pointer", "structured", "compressed", "full"];

const FIDELITY_RANK: Record<Fidelity, number> = {
  pointer: 0,
  structured: 1,
  compressed: 2,
  full: 3,
};

const PAGE_TYPES = new Set<PageType>([
  "bootstrap_policy",
  "constraint",
  "plan",
  "preference",
  "evidence",
  "conversation_segment",
  "decision",
  "procedure",
]);

const SCOPES = new Set<MemoryScope>(["global", "project", "session", "local"]);
const FIDELITIES = new Set<Fidelity>(FIDELITY_ORDER);
const PINS = new Set<PinClass>(["hard", "active", "soft"]);
const PROVENANCE_KINDS = new Set<Provenance["kind"]>([
  "memory_index",
  "topic_file",
  "tool_result",
  "session",
  "manual",
  "import",
]);

export function fidelityAtLeast(actual: Fidelity, minimum: Fidelity): boolean {
  return FIDELITY_RANK[actual] >= FIDELITY_RANK[minimum];
}

export function bestAvailableRepresentation(
  page: MemoryPage,
  minimum: Fidelity = page.minFidelity,
): PageRepresentation | undefined {
  for (let index = FIDELITY_ORDER.length - 1; index >= 0; index -= 1) {
    const fidelity = FIDELITY_ORDER[index];
    if (!fidelity || !fidelityAtLeast(fidelity, minimum)) continue;
    const representation = page.representations[fidelity];
    if (representation) return representation;
  }
  return undefined;
}

/** Cheap deterministic estimate used only for budgeting and summaries. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

export function minFidelityForType(type: PageType): Fidelity {
  switch (type) {
    case "bootstrap_policy":
    case "constraint":
    case "plan":
    case "decision":
    case "procedure":
      return "structured";
    case "evidence":
    case "conversation_segment":
    case "preference":
      return "pointer";
  }
}

export function pinsForType(type: PageType): PinClass[] {
  switch (type) {
    case "bootstrap_policy":
    case "constraint":
      return ["hard"];
    case "plan":
      return ["active"];
    default:
      return [];
  }
}

export function isMemoryPage(value: unknown): value is MemoryPage {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (!PAGE_TYPES.has(value.type as PageType)) return false;
  if (!SCOPES.has(value.scope as MemoryScope)) return false;
  if (typeof value.title !== "string") return false;
  if (!Array.isArray(value.provenance) || !value.provenance.every(isProvenance)) return false;
  if (!FIDELITIES.has(value.minFidelity as Fidelity)) return false;
  if (!isRepresentations(value.representations)) return false;
  if (!hasRepresentationAtOrAbove(value.representations, value.minFidelity as Fidelity)) return false;
  if (!Array.isArray(value.pins) || !value.pins.every((pin) => PINS.has(pin as PinClass))) {
    return false;
  }
  if (!isTokenEstimateRecord(value.tokenEstimate)) return false;
  if (value.recomputeCost !== undefined && typeof value.recomputeCost !== "number") return false;
  if (typeof value.dirty !== "boolean") return false;
  if (typeof value.createdAt !== "string") return false;
  if (typeof value.updatedAt !== "string") return false;
  if (typeof value.version !== "number") return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvenance(value: unknown): value is Provenance {
  if (!isRecord(value)) return false;
  if (!PROVENANCE_KINDS.has(value.kind as Provenance["kind"])) return false;
  return optionalString(value.path)
    && optionalNumber(value.lineStart)
    && optionalNumber(value.lineEnd)
    && optionalString(value.topic)
    && optionalString(value.sessionId)
    && optionalString(value.entryId)
    && optionalString(value.url);
}

function isRepresentations(value: unknown): value is Partial<Record<Fidelity, PageRepresentation>> {
  if (!isRecord(value)) return false;
  for (const [key, representation] of Object.entries(value)) {
    if (!FIDELITIES.has(key as Fidelity)) return false;
    if (!isPageRepresentation(representation, key as Fidelity)) return false;
  }
  return true;
}

function isPageRepresentation(value: unknown, expectedFidelity: Fidelity): value is PageRepresentation {
  if (!isRecord(value)) return false;
  if (value.fidelity !== expectedFidelity) return false;
  if (typeof value.content !== "string") return false;
  return typeof value.tokenEstimate === "number" && value.tokenEstimate >= 0;
}

function hasRepresentationAtOrAbove(
  representations: Partial<Record<Fidelity, PageRepresentation>>,
  minimum: Fidelity,
): boolean {
  return FIDELITY_ORDER.some((fidelity) => fidelityAtLeast(fidelity, minimum) && representations[fidelity]);
}

function isTokenEstimateRecord(value: unknown): value is Partial<Record<Fidelity, number>> {
  if (!isRecord(value)) return false;
  for (const [key, estimate] of Object.entries(value)) {
    if (!FIDELITIES.has(key as Fidelity)) return false;
    if (typeof estimate !== "number" || estimate < 0) return false;
  }
  return true;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}
