# Memory Effectiveness Testing

This project uses three test families for memory effectiveness: **utilization**, **saturation**, and **errors**. The goal is to test not just whether memory exists, but whether the harness uses it correctly under budget pressure and fails observably.

## 1. Utilization

**Question:** Is memory used when it should be?

Primary metrics:

- `neededRecallRate` — fraction of task-needed pages selected into the resident set.
- `usefulMemoryTokenRatio` — selected tokens from relevant pages divided by all selected memory tokens.
- future: write utilization — durable facts captured divided by eligible durable facts.

Example assertions:

- A seeded package-manager constraint is resident when answering build/package questions.
- A demanded procedure page is resident when the task calls for that workflow.
- Irrelevant memories do not crowd out explicitly needed memories while budget allows.

## 2. Saturation

**Question:** What happens as memory grows or token budget shrinks?

Primary metrics:

- `pinnedSurvivalRate` — fraction of hard/active pages that remain resident.
- `saturationRatio` — minimum required tokens divided by configured memory budget.
- future: thrash index — repeated evict/refetch/reload events divided by useful hits.
- future: prompt assembly latency by page count.

Expected behavior:

- If `saturationRatio <= 1`, pinned pages should survive and policy-controllable faults should be zero.
- If `saturationRatio > 1`, an explicit `invariant_pressure` fault is expected; silent omission is a bug.
- Optional pages should degrade or be omitted before constraints, bootstrap policy, and active plans.

## 3. Errors

**Question:** Does memory fail safely and observably?

Primary metric:

- `policyControllableFaultCount` — count of faults the harness policy should be able to prevent or explicitly report.

Faults currently modeled:

- `pinned_invariant_miss`
- `post_compaction_bootstrap_loss`
- `flush_miss`
- `silent_recall`
- `writeback_rejected`
- `sidecar_corrupt`
- `duplicate_tool_signature`
- `refetch`
- `invariant_pressure`

Example assertions:

- Missing minimum-fidelity representations produce `pinned_invariant_miss`.
- Required pages that exceed budget produce `invariant_pressure`.
- Corrupt JSONL sidecars are reported, not ignored.
- Project memory stays unavailable when the project is untrusted.

## Current deterministic test coverage

The automated Node test suite now includes:

- `test/page-table.test.ts` — page derivation, page-table sidecar validation, stable IDs, malformed JSONL handling.
- `test/residency.test.ts` — deterministic resident-set selection, pinned-page priority, upgrades, demanded pages, invariant pressure.
- `test/effectiveness.test.ts` — utilization, saturation, and error metrics over deterministic residency decisions.
- `test/git-scope.test.ts` — canonical Git roots, linked worktrees, private storage and non-Git behavior.
- `test/search.test.ts` — scoped QMD selection, archive opt-in, binding/output validation and serialized indexing.
- `scripts/sdk-smoke.mjs` — actual Pi SDK loading, trusted/untrusted injection, structured prompt preservation and fixture writeback.
- `test/qmd-integration.test.ts` — opt-in isolated actual QMD keyword/semantic/deep retrieval, scope isolation and refresh.

Run with:

```bash
npm run typecheck
npm test
```

## Provider-backed pi-agent tests

Provider-backed pi-agent tests stay outside routine deterministic assertions unless explicitly enabled because they are slower, nondeterministic, and require model access. The suite in `test/provider-agent.test.ts` seeds an owned temporary Git repository/private memory and an isolated global memory root, disables tools, context files, skills, prompt templates, themes, sessions, and unrelated extensions, then loads only this package's extension. This isolates the question: can a real provider-backed pi agent answer from injected persistent memory and memory instructions?

Run with:

```bash
npm run test:provider
```

Optional environment variables:

```bash
PI_MEMORY_PROVIDER=google PI_MEMORY_MODEL='gemini*' npm run test:provider
PI_BIN=/path/to/pi npm run test:provider
```

Current black-box scenarios:

1. **Memory utilization:** ask package-manager questions whose only enabled source is injected memory.
2. **Instruction utilization:** ask whether to write `AGENTS.md`, store project secrets, use topic files, archive stale entries, and avoid duplicating code/git history.

Recommended future scenarios:

1. **Scope correctness:** run trusted vs. untrusted project sessions and verify project memory appears only when trusted.
2. **Lifecycle durability:** write a durable fact, start a new no-session/clean session, verify recall.
3. **Saturation:** create oversized memory, verify important constraints still answer correctly.
4. **Error visibility:** corrupt a sidecar, run `/memory pages`, verify the fault is visible.

A useful headline score for black-box runs is:

```text
memory_effectiveness = task_success_with_memory - task_success_without_memory
```

For policy-level tests, the target is stricter:

```text
policy_controllable_fault_count == 0 when saturationRatio <= 1
```
