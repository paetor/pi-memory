# Requirements: ClawVM-Style Memory Management for pi

Status: draft requirements for a future `pi-memory`/pi integration. This document is informed by the ClawVM paper and the related reading list in [`docs/research/05-agent-harness-memory-papers.md`](research/05-agent-harness-memory-papers.md). It is not a commitment that all requirements belong in `pi-memory` v1.

## 1. Purpose

Define requirements for integrating **harness-managed virtual memory** into pi: persistent agent state is modeled as typed pages with minimum-fidelity invariants, selected into the prompt under a token budget, committed durably at lifecycle boundaries, and audited with explicit fault/reason codes.

The goal is to evolve from simple capped markdown injection toward a memory layer that makes these properties enforceable:

- important state survives compaction, reset, reload, and session boundaries;
- capture and recall are harness policy, not optional model behavior;
- memory writes are validated, scoped, and non-destructive;
- recall and eviction decisions are observable and replayable.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Page** | A typed unit of agent state selected, evicted, recalled, and written back as a unit. |
| **Page table** | Durable index of pages, metadata, representations, dirty state, scope, and provenance. |
| **Representation** | One of several prompt-ready forms of a page: `full`, `compressed`, `structured`, or `pointer`. |
| **Minimum fidelity** | The lowest representation level allowed for a page while still satisfying its invariant. |
| **Resident set** | Pages/representations selected for the next model call. |
| **Dirty page** | Page with updates that have not yet been committed to durable storage. |
| **Lifecycle boundary** | A pi event where context or extension state may be destroyed or rewritten: compaction, shutdown, new session, reload, switch, fork, reset. |
| **Fault** | Observable memory-management failure or pressure signal, recorded with a reason code. |

## 3. Requirement levels

- **MUST**: required for a ClawVM-style implementation.
- **SHOULD**: strongly preferred; may be deferred with a documented reason.
- **MAY**: optional extension point.

## 4. Scope

### In scope

- pi extension/harness integration using pi lifecycle hooks.
- Global and project memory scopes.
- Markdown compatibility with current `pi-memory` storage.
- Typed page metadata and deterministic prompt assembly.
- Lifecycle writeback, validation, audit logs, and fault reporting.
- Unit and replay tests for memory policy behavior.

### Out of scope for the first implementation

- Training or fine-tuning models.
- Vector database dependency as a hard requirement.
- Hidden, non-user-inspectable memory.
- Automatically deleting user/team-visible memory without archival.
- Replacing user-authored `AGENTS.md`/`CLAUDE.md` instructions.

## 5. Core requirements from ClawVM

| ClawVM requirement | pi integration requirement |
|---|---|
| Invariants survive destruction | Critical pages MUST be restored deterministically after compaction, reload, reset, and session restart. |
| Capture and recall are policy | The extension/harness MUST decide when designated state is captured and recalled; it MUST NOT rely solely on the model remembering to search or write. |
| Durability is lifecycle-complete | Dirty pages MUST be committed or explicitly rejected before lifecycle boundaries that may destroy the only copy. |
| Writeback is validated and non-destructive | Memory writes MUST be schema-checked, scoped, provenance-aware, and append/merge-safe. |
| Recall is observable | Recall MUST return reason codes distinguishing no match, denied, unavailable, malformed, and backend error. |
| Eviction is cost-aware | Page selection SHOULD consider the cost of reconstructing dropped state, including repeated tool/file operations. |

## 6. Storage and compatibility requirements

### 6.1 Existing markdown memory

- The implementation MUST remain compatible with current `pi-memory` stores:
  - global: `~/.pi/agent/memory/`
  - project: `<repo>/.pi/memory/`
- `MEMORY.md` MUST remain human-readable and user-editable.
- Topic files MUST remain ordinary markdown read by normal pi file tools.
- The extension MUST NOT write to `AGENTS.md`, `CLAUDE.md`, or other user-authored instruction files.

### 6.2 Machine-readable sidecars

A ClawVM-style implementation SHOULD add machine-readable sidecars per scope, for example:

```text
.pi/memory/
├── MEMORY.md
├── <topic>.md
├── archive/
├── page-table.jsonl        # typed page metadata and representation pointers
├── writeback-journal.jsonl # staged/validated/rejected commits
└── traces/
    └── YYYY-MM-DD.jsonl    # prompt assembly and fault decisions
```

Requirements:

- Sidecars MUST be deterministic, line-oriented, and diffable where practical.
- Sidecars MUST tolerate manual edits to markdown files by rebuilding or validating page metadata.
- Sidecars in project scope MUST be safe to commit: no secrets, no hidden local paths unless explicitly scoped/local.
- Corrupt sidecars MUST degrade gracefully to markdown-only behavior with an observable fault.

## 7. Page model requirements

Each page MUST have at least:

```ts
interface MemoryPage {
  id: string;                       // stable across sessions
  type: PageType;
  scope: "global" | "project" | "session" | "local";
  title: string;
  provenance: Provenance[];
  minFidelity: "pointer" | "structured" | "compressed" | "full";
  representations: Partial<Record<Fidelity, PageRepresentation>>;
  pins: PinClass[];
  tokenEstimate: Partial<Record<Fidelity, number>>;
  recomputeCost?: number;
  dirty: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

### 7.1 Page types

The implementation MUST support at least these page classes:

| Type | Examples | Minimum fidelity guidance |
|---|---|---|
| `bootstrap_policy` | memory rules, required protocols, post-compaction bootstrap instructions | `structured` or `full` |
| `constraint` | hard user/project constraints, safety rules, “always/never” requirements | `structured` |
| `plan` | active goal, current step, unresolved TODOs | `structured` while active |
| `preference` | user preferences, project conventions | `pointer` or `structured` |
| `evidence` | tool outputs, file reads, command results, cited sources | `pointer` if resolvable, else `structured` |
| `conversation_segment` | transcript ranges or summaries | `pointer` |
| `decision` | durable decisions and rationale | `structured` |
| `procedure` | reusable workflow, build/test protocol, checklist | `structured` |

The implementation MAY add domain-specific page types.

### 7.2 Provenance

Pages MUST record provenance sufficient for audit and reconstruction:

- source kind: user message, assistant message, tool call/result, file path, URL, manual edit, imported memory;
- timestamp/session ID when available;
- scope and trust context;
- source pointer, such as file path, line range, session entry ID, or URL.

## 8. Representation requirements

Each page SHOULD support up to four representations:

| Fidelity | Description | Requirement |
|---|---|---|
| `full` | Verbatim or near-verbatim content | SHOULD exist for constraints/evidence when token-feasible. |
| `compressed` | Lossy but human-readable summary | SHOULD preserve citations/provenance pointers. |
| `structured` | Typed fields sufficient to satisfy invariant | MUST exist for pinned constraints, active plans, decisions, and procedures. |
| `pointer` | Resolvable handle plus minimal metadata | MUST include enough information to recover or inspect the full state. |

Representation generation SHOULD happen when pages are created or updated, not during token-pressure prompt assembly. Prompt assembly MUST NOT require an LLM call.

## 9. Prompt assembly and residency requirements

### 9.1 Hooking into pi

- The implementation MUST inject memory through pi prompt/context hooks rather than modifying user messages destructively.
- `before_agent_start` MAY provide stable baseline memory/bootstrap text.
- `context` SHOULD be used for per-call resident-set selection when page choice depends on current messages, tool availability, or token pressure.
- The implementation SHOULD use `ctx.getContextUsage()` or equivalent context metadata when available to size the memory budget.

### 9.2 Budgeting

- The implementation MUST reserve space for system prompt, tool schemas, user content, and model output.
- The memory budget MUST be bounded by configuration.
- If the minimum required resident set cannot fit, the implementation MUST record an `invariant_pressure` or `pinned_invariant_miss` fault rather than silently dropping pinned state.

### 9.3 Selection policy

Prompt assembly MUST be deterministic for identical inputs.

Required algorithm shape:

1. install all hard-pinned pages at minimum fidelity;
2. install pages explicitly demanded by the current turn at minimum fidelity;
3. sort optional upgrades by utility per additional token;
4. apply upgrades while preserving invariants and staying under budget;
5. emit a decision trace containing selected pages, omitted pages, token estimates, and reasons.

Utility SHOULD include:

- pin class;
- page type;
- current-turn demand;
- recency;
- scope specificity;
- dirty/active status;
- recompute cost;
- retrieval confidence.

## 10. Capture and writeback requirements

### 10.1 Capture triggers

The implementation MUST support explicit user/model-requested memory writes. It SHOULD also capture or stage candidate updates at these pi lifecycle points:

| pi event | Requirement |
|---|---|
| `session_before_compact` | SHOULD stage memory updates from messages about to be summarized/dropped. |
| `session_compact` | SHOULD verify that required bootstrap/constraint pages remain available after compaction. |
| `session_before_switch` | SHOULD flush dirty pages before switching sessions. |
| `session_before_fork` | SHOULD mark which dirty/session pages fork with the new branch. |
| `session_shutdown` | MUST attempt final dirty-page commit. |
| `session_start` | MUST reload/rebuild page tables and report corrupt/missing stores. |

### 10.2 Writeback protocol

Writeback MUST be staged and validated before commit:

1. **Stage** typed operations: `append`, `merge`, `set_with_version`, `archive`, or `reject`.
2. **Validate** schema, scope, trust, provenance, non-secret policy, and non-destructive semantics.
3. **Commit** with deterministic merge rules.
4. **Journal** accepted and rejected updates with reason codes.

The implementation MUST reject destructive full-file overwrite of memory stores unless explicitly authorized by the user.

### 10.3 Dirty-page handling

- Dirty pages MUST NOT be discarded silently.
- At lifecycle shutdown, each dirty page MUST end in one of: committed, archived, rejected with reason, or still-dirty with an error fault.
- Rejected updates MUST remain inspectable in the journal.

## 11. Recall requirements

Recall APIs and internal lookups MUST return structured results:

```ts
interface RecallResult {
  status: "ok" | "no_match" | "denied" | "malformed" | "unavailable" | "backend_error";
  pages: MemoryPage[];
  reason: string;
  traceId: string;
}
```

Requirements:

- Empty recall MUST NOT be ambiguous.
- Scope denial MUST be distinguishable from no match.
- Backend/file errors MUST be visible to the agent or user through `/memory` status or logs.
- Project memory recall MUST be disabled when `ctx.isProjectTrusted()` is false.

## 12. Fault and audit requirements

The implementation MUST record observable faults for at least:

| Fault | Meaning |
|---|---|
| `pinned_invariant_miss` | Required page missing or below minimum fidelity. |
| `post_compaction_bootstrap_loss` | Required bootstrap/policy page absent after compaction. |
| `flush_miss` | Dirty page not committed before destructive boundary. |
| `silent_recall` | Backend denied/errored but lookup would otherwise look empty. |
| `writeback_rejected` | Staged write failed validation. |
| `sidecar_corrupt` | Page table/journal/trace could not be parsed or validated. |
| `duplicate_tool_signature` | Equivalent costly tool call repeated while prior evidence page should have been available. |
| `refetch` | File/URL/tool evidence had to be fetched again after eviction. |
| `invariant_pressure` | Minimum resident set exceeds token budget. |

Decision traces SHOULD include:

- trace ID, session ID, event name, timestamp;
- memory budget and token estimates;
- selected page IDs and fidelity levels;
- omitted page IDs and omission reasons;
- lifecycle writeback decisions;
- fault IDs and reason codes.

## 13. Commands and user surface

`/memory` MUST continue to show current memory status. A ClawVM-style implementation SHOULD extend it with:

- `/memory pages` — list pages, types, scopes, fidelity, dirty state, and token estimates;
- `/memory faults` — show recent faults and rejected writes;
- `/memory trace <id>` — inspect a prompt assembly/writeback trace;
- `/memory verify` — rebuild/validate sidecars against markdown files;
- `/memory flush` — manually commit or inspect dirty pages;
- `/memory off|on` — preserve current injection toggle behavior.

All command output MUST degrade gracefully in non-TUI modes.

## 14. Configuration requirements

Configuration SHOULD support per-scope overrides via existing memory `config.json` files.

Recommended keys:

```json
{
  "enabled": true,
  "maxInjectLines": 200,
  "maxInjectBytes": 8192,
  "pageTableEnabled": true,
  "maxMemoryTokens": 4096,
  "traceEnabled": true,
  "captureOnCompact": true,
  "captureOnShutdown": true,
  "strictWriteback": true
}
```

Requirements:

- Invalid config MUST be ignored with a warning/fault, not crash startup.
- Project config MUST only apply in trusted projects.
- Secure defaults MUST avoid writing secrets to project memory.

## 15. Security, privacy, and trust requirements

- Project memory MUST remain trust-gated.
- The agent MUST be instructed not to store secrets, credentials, private tokens, or sensitive personal data in project memory.
- Provenance SHOULD avoid leaking absolute local paths into committed project memory unless they are already repo-relative or intentionally shared.
- Global memory MAY contain user-specific preferences but SHOULD still avoid secrets.
- Rejected/staged journal entries in project scope MUST be safe to commit or placed in a local-only area.

## 16. Concurrency and integrity requirements

- Writes MUST be atomic per file.
- Extension tools that mutate files MUST use pi's file mutation queue or equivalent serialization.
- Cross-session write conflicts SHOULD be detected through versions/checksums where possible.
- The implementation MUST tolerate manual edits between prompts.
- The implementation SHOULD be able to rebuild page metadata from markdown and journals.

## 17. Performance requirements

- Prompt assembly MUST be deterministic and local; no network calls or model calls in the hot path.
- Page selection SHOULD be linear or near-linear in the number of candidate pages.
- Sidecar parsing SHOULD be cached by mtime/size, matching the current `MEMORY.md` cache pattern.
- Added prompt-assembly overhead SHOULD target sub-millisecond operation for typical memory stores.
- Trace logging MUST be bounded or rotatable.

## 18. Testing and acceptance criteria

### 18.1 Unit tests

- page schema validation;
- fidelity ordering and invariant checks;
- deterministic resident-set selection;
- token-budget pressure behavior;
- writeback validation and rejection;
- recall reason codes;
- config merge and trust gating;
- sidecar rebuild from markdown.

### 18.2 Lifecycle tests

Simulate pi events and assert:

- dirty pages are committed or rejected before `session_shutdown`;
- compaction does not lose bootstrap/constraint pages;
- untrusted projects do not load project memory;
- `/memory off` suppresses injection without deleting memory;
- corrupt sidecars fall back to markdown with visible faults.

### 18.3 Replay tests

Build deterministic traces for:

- evidence-heavy tool use;
- interruption and session switch;
- reset/reload after dirty writes;
- multi-session conflict;
- tight token budget with pinned pages.

Acceptance target: no policy-controllable faults in traces where the minimum required resident set fits within the configured memory budget.

## 19. Suggested implementation phases

### Phase 1 — Page metadata without changing UX

- Add page-table sidecar for existing `MEMORY.md` entries.
- Add page IDs, page types, scope, provenance, and dirty state.
- Add `/memory pages` and `/memory verify`.
- Preserve current injected markdown block.

### Phase 2 — Deterministic resident-set selection

- Add per-call page selection under `maxMemoryTokens`.
- Support structured/pointer representations.
- Emit decision traces and invariant-pressure faults.

### Phase 3 — Lifecycle writeback

- Stage updates on compaction/shutdown.
- Validate append/merge operations.
- Add writeback journal and rejected-update reporting.

### Phase 4 — Recall controller and cost-aware eviction

- Add reason-coded recall API.
- Track evidence/tool-call pages and duplicate/refetch faults.
- Incorporate recompute cost into selection.

### Phase 5 — Evaluation harness

- Add trace replay fixtures and oracle-style comparisons.
- Measure token usage, policy-controllable faults, and prompt-assembly overhead.

## 20. Open questions

1. Should sidecars be committed in project memory by default, or should some traces/journals be local-only?
2. Should `session` scope exist as a first-class page scope, or should session-only state remain in pi's session JSONL?
3. What is the first supported structured representation for existing markdown bullets?
4. Should capture-on-compaction propose memory updates for agent approval, or commit validated facts automatically?
5. How much of this belongs in the `pi-memory` package versus pi core prompt assembly?
