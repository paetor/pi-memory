import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryPage } from "../src/memory-domain.ts";
import { selectResidentPages } from "../src/residency.ts";

function page(overrides: Partial<MemoryPage> = {}): MemoryPage {
  const base: MemoryPage = {
    id: "global:base",
    type: "preference",
    scope: "global",
    title: "base page",
    provenance: [{ kind: "memory_index", path: "MEMORY.md", lineStart: 1, lineEnd: 1 }],
    minFidelity: "pointer",
    representations: {
      pointer: { fidelity: "pointer", content: "MEMORY.md:1", tokenEstimate: 1 },
      structured: { fidelity: "structured", content: "Topic: General\nMemory: base page", tokenEstimate: 2 },
      full: { fidelity: "full", content: "base page", tokenEstimate: 5 },
    },
    pins: [],
    tokenEstimate: { pointer: 1, structured: 2, full: 5 },
    dirty: false,
    createdAt: "unknown",
    updatedAt: "unknown",
    version: 1,
  };
  return { ...base, ...overrides };
}

test("selectResidentPages always installs hard-pinned pages first", () => {
  const constraint = page({
    id: "project:constraint",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
  });
  const optional = page({ id: "global:optional" });

  const decision = selectResidentPages([optional, constraint], { budgetTokens: 2 });

  assert.deepEqual(decision.faults, []);
  assert.equal(decision.usedTokens, 2);
  assert.deepEqual(
    decision.selected.map((selected) => selected.page.id),
    ["project:constraint"],
  );
  assert.equal(decision.selected[0]?.fidelity, "structured");
});

test("selectResidentPages reports invariant pressure when required pages exceed budget", () => {
  const constraint = page({
    id: "project:constraint",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
    representations: {
      structured: { fidelity: "structured", content: "large", tokenEstimate: 50 },
    },
    tokenEstimate: { structured: 50 },
  });

  const decision = selectResidentPages([constraint], { budgetTokens: 10 });

  assert.equal(decision.selected.length, 1);
  assert.equal(decision.faults[0]?.type, "invariant_pressure");
});

test("selectResidentPages upgrades pages when budget allows", () => {
  const preference = page({ id: "global:preference" });

  const decision = selectResidentPages([preference], { budgetTokens: 5 });

  assert.equal(decision.usedTokens, 5);
  assert.equal(decision.selected[0]?.page.id, "global:preference");
  assert.equal(decision.selected[0]?.fidelity, "full");
});

test("selectResidentPages can demand an otherwise optional page", () => {
  const preference = page({ id: "global:preference" });

  const decision = selectResidentPages([preference], {
    budgetTokens: 1,
    demandedPageIds: ["global:preference"],
  });

  assert.equal(decision.selected[0]?.page.id, "global:preference");
  assert.equal(decision.selected[0]?.reason, "required");
  assert.equal(decision.omitted.length, 0);
});
