import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryPage } from "../src/memory-domain.ts";
import { scoreResidencyDecision } from "../src/effectiveness.ts";
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

test("utilization metric is perfect when all needed pages are resident", () => {
  const buildRule = page({ id: "project:build-rule", type: "procedure", scope: "project" });
  const packageManager = page({
    id: "project:package-manager",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
  });

  const decision = selectResidentPages([buildRule, packageManager], {
    budgetTokens: 7,
    demandedPageIds: [buildRule.id],
  });
  const metrics = scoreResidencyDecision(decision, {
    neededPageIds: [buildRule.id, packageManager.id],
    relevantPageIds: [buildRule.id, packageManager.id],
    pinnedPageIds: [packageManager.id],
    minimumRequiredTokens: 2,
  });

  assert.equal(metrics.neededRecallRate, 1);
  assert.equal(metrics.pinnedSurvivalRate, 1);
  assert.equal(metrics.usefulMemoryTokenRatio, 1);
  assert.equal(metrics.saturationRatio, 2 / 7);
  assert.equal(metrics.policyControllableFaultCount, 0);
});

test("utilization metric detects omitted needed memory", () => {
  const needed = page({ id: "project:needed", type: "procedure", scope: "project" });
  const pinned = page({
    id: "project:pinned",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
  });

  const decision = selectResidentPages([needed, pinned], { budgetTokens: 2 });
  const metrics = scoreResidencyDecision(decision, {
    neededPageIds: [needed.id],
    relevantPageIds: [needed.id],
    pinnedPageIds: [pinned.id],
  });

  assert.equal(metrics.neededRecallRate, 0);
  assert.equal(metrics.pinnedSurvivalRate, 1);
  assert.equal(metrics.usefulMemoryTokenRatio, 0);
});

test("saturation metric verifies pinned pages survive when minimum set fits", () => {
  const pinned = Array.from({ length: 3 }, (_, index) => page({
    id: `project:pinned-${index}`,
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
    representations: {
      pointer: { fidelity: "pointer", content: `MEMORY.md:${index + 1}`, tokenEstimate: 1 },
      structured: { fidelity: "structured", content: `constraint ${index}`, tokenEstimate: 2 },
    },
    tokenEstimate: { pointer: 1, structured: 2 },
  }));
  const optional = Array.from({ length: 100 }, (_, index) => page({ id: `global:optional-${index}` }));

  const decision = selectResidentPages([...optional, ...pinned], { budgetTokens: 6 });
  const metrics = scoreResidencyDecision(decision, {
    pinnedPageIds: pinned.map((item) => item.id),
    minimumRequiredTokens: 6,
  });

  assert.equal(metrics.saturationRatio, 1);
  assert.equal(metrics.pinnedSurvivalRate, 1);
  assert.equal(metrics.policyControllableFaultCount, 0);
  assert.deepEqual(
    decision.selected.map((resident) => resident.page.id),
    pinned.map((item) => item.id),
  );
});

test("error metric counts policy-controllable invariant pressure", () => {
  const pinned = page({
    id: "project:too-large",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
    representations: {
      structured: { fidelity: "structured", content: "too large", tokenEstimate: 10 },
    },
    tokenEstimate: { structured: 10 },
  });

  const decision = selectResidentPages([pinned], { budgetTokens: 4 });
  const metrics = scoreResidencyDecision(decision, {
    pinnedPageIds: [pinned.id],
    minimumRequiredTokens: 10,
  });

  assert.equal(metrics.saturationRatio, 2.5);
  assert.equal(metrics.pinnedSurvivalRate, 1);
  assert.equal(metrics.policyControllableFaultCount, 1);
  assert.equal(metrics.policyControllableFaults[0]?.type, "invariant_pressure");
});

test("error metric counts missing minimum-fidelity representations", () => {
  const broken = page({
    id: "project:broken",
    type: "constraint",
    scope: "project",
    minFidelity: "structured",
    pins: ["hard"],
    representations: {
      pointer: { fidelity: "pointer", content: "MEMORY.md:1", tokenEstimate: 1 },
    },
    tokenEstimate: { pointer: 1 },
  });

  const decision = selectResidentPages([broken], { budgetTokens: 10 });
  const metrics = scoreResidencyDecision(decision, {
    pinnedPageIds: [broken.id],
    minimumRequiredTokens: 1,
  });

  assert.equal(metrics.pinnedSurvivalRate, 0);
  assert.equal(metrics.policyControllableFaultCount, 1);
  assert.equal(metrics.policyControllableFaults[0]?.type, "pinned_invariant_miss");
});
