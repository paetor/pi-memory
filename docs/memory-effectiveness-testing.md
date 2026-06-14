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

Run with:

```bash
npm run typecheck
npm test
```

## Future black-box pi-agent tests

Provider-backed pi-agent tests should stay outside the default unit suite because they are slower, nondeterministic, and require model access. Recommended scenarios:

1. **Memory utilization:** seed a memory fact, disable tools/context files, ask a question whose only source is injected memory.
2. **Scope correctness:** run trusted vs. untrusted project sessions and verify project memory appears only when trusted.
3. **Lifecycle durability:** write a durable fact, start a new no-session/clean session, verify recall.
4. **Saturation:** create oversized memory, verify important constraints still answer correctly.
5. **Error visibility:** corrupt a sidecar, run `/memory pages`, verify the fault is visible.

A useful headline score for black-box runs is:

```text
memory_effectiveness = task_success_with_memory - task_success_without_memory
```

For policy-level tests, the target is stricter:

```text
policy_controllable_fault_count == 0 when saturationRatio <= 1
```
