import {
  FIDELITY_ORDER,
  fidelityAtLeast,
  type Fidelity,
  type MemoryFault,
  type MemoryPage,
  type PageRepresentation,
  type PageType,
} from "./memory-domain.ts";

export interface ResidentPage {
  page: MemoryPage;
  fidelity: Fidelity;
  representation: PageRepresentation;
  reason: "required" | "optional" | "upgrade";
}

export interface ResidencyDecision {
  budgetTokens: number;
  usedTokens: number;
  selected: ResidentPage[];
  omitted: Array<{ pageId: string; reason: string }>;
  faults: MemoryFault[];
}

export interface ResidencyOptions {
  budgetTokens: number;
  demandedPageIds?: Iterable<string>;
}

interface Candidate {
  page: MemoryPage;
  fidelity: Fidelity;
  representation: PageRepresentation;
  reason: ResidentPage["reason"];
  extraTokens: number;
  score: number;
}

const TYPE_UTILITY: Record<PageType, number> = {
  bootstrap_policy: 1000,
  constraint: 900,
  plan: 700,
  procedure: 420,
  decision: 360,
  preference: 260,
  evidence: 240,
  conversation_segment: 120,
};

/**
 * Deterministic ClawVM-style resident-set selection.
 *
 * Phase 1 installs hard-pinned and current-turn-demanded pages at minimum
 * fidelity. Phase 2 greedily installs optional pages or upgrades selected pages
 * by marginal utility per token. This is intentionally pure: no filesystem,
 * network, or LLM calls happen on the prompt hot path.
 */
export function selectResidentPages(pages: MemoryPage[], options: ResidencyOptions): ResidencyDecision {
  const demanded = new Set(options.demandedPageIds ?? []);
  const budgetTokens = Math.max(0, Math.floor(options.budgetTokens));
  const sortedPages = [...pages].sort(comparePages);
  const selected = new Map<string, ResidentPage>();
  const omitted: Array<{ pageId: string; reason: string }> = [];
  const faults: MemoryFault[] = [];
  let usedTokens = 0;

  for (const page of sortedPages) {
    if (!isRequired(page, demanded)) continue;
    const representation = minimumAvailableRepresentation(page);
    if (!representation) {
      faults.push({
        type: "pinned_invariant_miss",
        pageId: page.id,
        reason: `no representation satisfies minimum fidelity ${page.minFidelity}`,
      });
      omitted.push({ pageId: page.id, reason: "missing minimum representation" });
      continue;
    }
    selected.set(page.id, { page, fidelity: representation.fidelity, representation, reason: "required" });
    usedTokens += representation.tokenEstimate;
  }

  if (usedTokens > budgetTokens) {
    faults.push({
      type: "invariant_pressure",
      reason: `required pages need ${usedTokens} tokens but budget is ${budgetTokens}`,
    });
    return orderedDecision({ budgetTokens, usedTokens, selected, omitted, faults });
  }

  while (true) {
    const candidate = bestCandidate(sortedPages, selected, budgetTokens - usedTokens);
    if (!candidate) break;
    selected.set(candidate.page.id, {
      page: candidate.page,
      fidelity: candidate.fidelity,
      representation: candidate.representation,
      reason: candidate.reason,
    });
    usedTokens += candidate.extraTokens;
  }

  for (const page of sortedPages) {
    if (!selected.has(page.id)) omitted.push({ pageId: page.id, reason: "budget or utility" });
  }

  return orderedDecision({ budgetTokens, usedTokens, selected, omitted, faults });
}

export function minimumAvailableRepresentation(page: MemoryPage): PageRepresentation | undefined {
  for (const fidelity of FIDELITY_ORDER) {
    if (!fidelityAtLeast(fidelity, page.minFidelity)) continue;
    const representation = page.representations[fidelity];
    if (representation) return representation;
  }
  return undefined;
}

function bestCandidate(
  pages: MemoryPage[],
  selected: Map<string, ResidentPage>,
  remainingTokens: number,
): Candidate | undefined {
  const candidates: Candidate[] = [];
  for (const page of pages) {
    const current = selected.get(page.id);
    const candidate = current
      ? upgradeCandidate(page, current)
      : installCandidate(page);
    if (!candidate || candidate.extraTokens <= 0 || candidate.extraTokens > remainingTokens) continue;
    candidates.push(candidate);
  }
  candidates.sort(compareCandidates);
  return candidates[0];
}

function installCandidate(page: MemoryPage): Candidate | undefined {
  const representation = minimumAvailableRepresentation(page);
  if (!representation) return undefined;
  return {
    page,
    fidelity: representation.fidelity,
    representation,
    reason: "optional",
    extraTokens: representation.tokenEstimate,
    score: utility(page, representation.fidelity) / Math.max(1, representation.tokenEstimate),
  };
}

function upgradeCandidate(page: MemoryPage, current: ResidentPage): Candidate | undefined {
  const currentRank = FIDELITY_ORDER.indexOf(current.fidelity);
  if (currentRank < 0) return undefined;
  for (const fidelity of FIDELITY_ORDER.slice(currentRank + 1)) {
    const representation = page.representations[fidelity];
    if (!representation) continue;
    const extraTokens = representation.tokenEstimate - current.representation.tokenEstimate;
    return {
      page,
      fidelity,
      representation,
      reason: "upgrade",
      extraTokens,
      score: (utility(page, fidelity) - utility(page, current.fidelity)) / Math.max(1, extraTokens),
    };
  }
  return undefined;
}

function isRequired(page: MemoryPage, demanded: Set<string>): boolean {
  return page.pins.includes("hard") || page.pins.includes("active") || demanded.has(page.id);
}

function utility(page: MemoryPage, fidelity: Fidelity): number {
  const pinBonus = page.pins.includes("hard") ? 300 : page.pins.includes("active") ? 180 : 0;
  const scopeBonus = page.scope === "project" ? 35 : page.scope === "global" ? 20 : 0;
  const recomputeBonus = page.recomputeCost ?? 0;
  const fidelityBonus = FIDELITY_ORDER.indexOf(fidelity) * 12;
  return TYPE_UTILITY[page.type] + pinBonus + scopeBonus + recomputeBonus + fidelityBonus;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const pageCompare = comparePages(a.page, b.page);
  if (pageCompare !== 0) return pageCompare;
  return FIDELITY_ORDER.indexOf(a.fidelity) - FIDELITY_ORDER.indexOf(b.fidelity);
}

function comparePages(a: MemoryPage, b: MemoryPage): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function orderedDecision(args: {
  budgetTokens: number;
  usedTokens: number;
  selected: Map<string, ResidentPage>;
  omitted: Array<{ pageId: string; reason: string }>;
  faults: MemoryFault[];
}): ResidencyDecision {
  return {
    budgetTokens: args.budgetTokens,
    usedTokens: args.usedTokens,
    selected: [...args.selected.values()].sort((a, b) => comparePages(a.page, b.page)),
    omitted: args.omitted.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0)),
    faults: args.faults,
  };
}
