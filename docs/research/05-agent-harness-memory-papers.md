# Agent Harness Memory Systems — arXiv Reading List

Logged 2026-06-13 from an arXiv/web literature scan focused on **agent harnesses, memory systems, lifecycle durability, retrieval control, and evaluation**. This file is a research-topic index, not yet a design commitment.

## Highest-priority papers for `pi-memory`

| Priority | Paper | Why it matters for this project |
|---:|---|---|
| 1 | [ClawVM: Harness-Managed Virtual Memory for Stateful Tool-Using LLM Agents](https://arxiv.org/abs/2604.10352) | Treats the harness as the enforcement point for memory residency, durability, lifecycle writeback, and auditability. Most directly relevant to hardening `pi-memory` beyond capped markdown injection. |
| 2 | [M$^\star$: Every Task Deserves Its Own Memory Harness](https://arxiv.org/abs/2604.11811) | Frames memory as task-specific executable harness programs with schema, storage logic, and workflow instructions. Useful for future page schemas and task-adaptive memory policies. |
| 3 | [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers](https://arxiv.org/abs/2603.07670) | Survey with a write–manage–read loop and taxonomy across temporal scope, representation substrate, and control policy. Good baseline for terminology. |
| 4 | [Externalization in LLM Agents: A Unified Review of Memory, Skills, Protocols and Harness Engineering](https://arxiv.org/abs/2604.08224) | Systems framing: memory, skills, protocols, and harness engineering as external cognitive infrastructure. Useful for positioning `pi-memory` as harness infrastructure. |
| 5 | [EvoMemBench: Benchmarking Agent Memory from a Self-Evolving Perspective](https://arxiv.org/abs/2605.18421) | Evaluation dimensions: in-episode vs. cross-episode memory and knowledge-oriented vs. execution-oriented content. Useful for future tests/benchmarks. |
| 6 | [EvoArena: Tracking Memory Evolution for Robust LLM Agents in Dynamic Environments](https://arxiv.org/abs/2606.13681) | Introduces patch-based memory evolution histories. Relevant to append-only memory, update provenance, and avoiding destructive rewrites. |

## Retrieval and memory-control papers

| Paper | Main idea to track |
|---|---|
| [Beyond RAG for Agent Memory: Retrieval by Decoupling and Aggregation](https://arxiv.org/abs/2602.02007) | Agent memory is a bounded, coherent stream, not a generic corpus; retrieval should avoid redundant top-k spans and preserve prerequisite context through hierarchy. |
| [Memory is Reconstructed, Not Retrieved: Graph Memory for LLM Agents](https://arxiv.org/abs/2606.06036) | Active memory reconstruction over an associative Cue–Tag–Content graph instead of static retrieve-then-reason. |
| [TA-Mem: Tool-Augmented Autonomous Memory Retrieval for LLM in Long-Term Conversational QA](https://arxiv.org/abs/2603.09297) | Tool-augmented retrieval agent over multi-indexed memory, choosing lookup/retrieval tools adaptively. |
| [MemR$^3$: Memory Retrieval via Reflective Reasoning for LLM Agents](https://arxiv.org/abs/2512.20237) | Closed-loop retrieve/reflect/answer controller with evidence-gap tracking; potential model for reason-coded recall. |
| [AdMem: Advanced Memory for Task-solving Agents](https://arxiv.org/abs/2606.06787) | Combines semantic, episodic, and procedural memory with actor/memory/critic agents and reward-based pruning/merging. |

## Harness and orchestration papers adjacent to memory

| Paper | Main idea to track |
|---|---|
| [Natural-Language Agent Harnesses](https://arxiv.org/abs/2603.25723) | Externalizes high-level harness control logic into editable natural language executed by a shared runtime. |
| [From Model Scaling to System Scaling: Scaling the Harness in Agentic AI](https://arxiv.org/abs/2605.26112) | Argues agent progress depends on auditable, persistent, modular, verifiable harnesses; highlights context governance, trustworthy memory, and dynamic skill routing. |
| [Affordance Agent Harness: Verification-Gated Skill Orchestration](https://arxiv.org/abs/2605.00663) | Closed-loop runtime with evidence store, episodic priors, router, verifier, and cost control. Useful as an orchestration pattern. |
| [Self-Healing Agentic Orchestrators for Reliable Tool-Augmented Large Language Model Systems](https://arxiv.org/abs/2606.01416) | Reliability via orchestration-level recovery from timeouts, malformed arguments, stale context, contradictory evidence, retry loops, and unverified outputs. |
| [The Evolution of Tool Use in LLM Agents: From Single-Tool Call to Multi-Tool Orchestration](https://arxiv.org/abs/2603.22862) | Broad tool-orchestration survey; relevant background for memory as part of long-trajectory tool use. |
| [Observability-Driven Automatic Evolution of Coding-Agent Harnesses](https://arxiv.org/abs/2604.25850) | Harness evolution via observability signals; relevant to memory fault logging and future self-improvement loops. |

## ClawVM requirements to preserve for design work

ClawVM derives six requirements that are especially relevant if `pi-memory` evolves from simple markdown injection toward lifecycle-managed memory:

1. **Invariants survive destruction** — critical instructions, constraints, active plans, and policies must survive compaction/reset/reload.
2. **Capture and recall are policy, not discretion** — the harness decides what designated state must be captured and recalled.
3. **Durability is lifecycle-complete** — dirty state is committed before compaction, reset, save, session end, or any boundary that could destroy the only copy.
4. **Writeback is validated and non-destructive** — updates are schema-checked, scoped, provenance-aware, and merge/append-safe.
5. **Recall is observable** — distinguish no match, scope denial, backend error, malformed query, and unavailable store instead of returning silent emptiness.
6. **Eviction is cost-aware** — retention decisions account for the cost of reconstructing dropped state, including repeated tool calls.

## Design implications for `pi-memory`

- Current `pi-memory` implements durable file-backed token-level memory with global/project scopes and capped injection, but it does not yet implement typed pages, fidelity invariants, dirty-page tracking, validated writeback, recall reason codes, or fault traces.
- A ClawVM-inspired roadmap would add a lightweight page table over `MEMORY.md`/topic files before adding more complex retrieval.
- The most immediate low-risk improvements are: append/merge discipline, explicit scope/provenance metadata for saved facts, lifecycle flush hooks, and audit/fault logs for memory reads/writes.
