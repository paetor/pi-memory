# pi-memory — paetor fork

A small fork of [Joseph Kern's pi-memory](https://github.com/josephkern/pi-memory), retaining its Markdown indexes, topic files, capped/resident prompt injection and writeback journal. This fork adds **Git-based private project scopes** and **scoped local QMD search**.

## Scopes and storage

| Scope | Storage | Default behavior |
|---|---|---|
| Global | `<Pi agent directory>/memory/` | Available in every project |
| Project | `<git-common-dir>/pi-memory/` | Available only in a trusted Git working tree |
| Historical archive | Explicitly configured directory | Search only with `scope=archive`; never injected automatically |

Global storage respects `PI_CODING_AGENT_DIR` and the optional `PI_MEMORY_DIR` override. An existing `~/.pi/agent/memory` symlink can be retained.

Project identity comes from Git, not the cwd basename. Starting in a subdirectory resolves to the repository's common Git directory. Linked worktrees share that directory and therefore share one project memory. Separate Git-directory layouts also work. Outside a Git working tree there is only global memory.

Project notes are **private and untracked**, not team documents: the common Git directory is outside the tracked working tree. Different clones remain separate, even when their directory basenames or remotes match. No folders are created merely by resolving or reading scopes. No legacy `.pi/memory/` files are silently imported or rewritten.

This is scope selection, not an OS sandbox. Do not store secrets or treat remembered state as a substitute for live operational truth. Git cloning does not copy this private project memory; Git metadata backups may include it.

## Install

Requires Pi **1.0+**, Node **22.19+**, and Git. QMD **2.8.3+** on PATH is optional for injection and required for `memory_search`. Existing QMD installations/models are reused; no new vector engine, service or remote memory API is introduced.

```bash
pi install git:github.com/paetor/pi-memory@account-routing
```

For reproducible installations pin a reviewed commit or the `v0.3.0-paetor.1` tag instead of the branch. Do not load another extension registering `memory_search` at the same time (including jayzeng's unrelated npm package `pi-memory`). Removing/replacing an installed package is a separate local activation step; source publication does not alter that installation.

This public fork is Git-distributed; `private: true` prevents accidentally publishing it over an upstream npm package. The upstream MIT attribution is retained.

## Usage

The agent sees a bounded global index plus the current trusted project's index and reads topic files on demand. Durable notes are written using ordinary Pi file tools or staged through the existing commands:

- `/memory` — show scope paths, sizes and enabled state.
- `/memory remember global|project <text>` — stage an append-only memory entry.
- `/memory flush` — commit pending entries and rebuild page tables.
- `/memory pages`, `/memory verify`, `/memory faults`, `/memory traces` — existing upstream diagnostics.
- `/memory off|on` — toggle prompt injection for this session.
- `pi --no-memory` — disable injection and the search tool.

Always choose global scope for portable user preferences and project scope for repository-specific knowledge. Do not save facts already maintained in code, AGENTS.md, Git history or authoritative operational data.

### Scoped QMD search

`memory_search` parameters:

| Parameter | Default | Values |
|---|---|---|
| `query` | Required | 1–4000 characters |
| `scope` | `active` | `active`, `global`, `project`, `archive` |
| `mode` | `keyword` | `keyword`, `semantic`, `deep` |
| `limit` | `8` | Integer 1–20 |

`active` searches **only global + the current trusted Git project**. Other projects and historical archives are not fallbacks. Untrusted/non-Git directories cannot supply a project scope.

Each source root has a deterministic, path-bound collection in the dedicated named QMD index `pi-memory-fork`. Existing QMD indexes/collections are not renamed or overwritten, and unrelated project-local `.qmd` configurations are not selected. Collection path/mask bindings are checked before indexing; results outside selected collection namespaces are rejected.

Active collections include top-level `*.md` index/topic files, excluding nested `archive/` and unrelated files. Only explicit historical archive collections recurse over Markdown. Selected collections refresh before retrieval; semantic/deep modes generate missing local embeddings. Derived-index mutations and their dependent queries are serialized within one Pi process. QMD handles its own database concurrency between processes.

Missing QMD, invalid bindings, malformed output or unavailable models fail visibly: there is no unscoped search or remote-service fallback. Local model downloads are QMD's behavior; no source memories are uploaded by this extension.

Configure historical memory in **global** `memory/config.json`:

```json
{
  "archiveDir": "/absolute/path/to/historical-memory"
}
```

Or set `PI_MEMORY_ARCHIVE_DIR`. Project config cannot redirect the archive. Nothing is moved, deleted or promoted automatically.

## Injection configuration

Optional `config.json` in either active memory directory; project keys override global for upstream injection/writeback options:

```json
{
  "enabled": true,
  "maxInjectLines": 200,
  "maxInjectBytes": 8192,
  "pageTableInjection": true,
  "maxMemoryTokens": 4096,
  "traceEnabled": true,
  "strictWriteback": true
}
```

Set `pageTableInjection=false` for simple capped Markdown injection. Pi 1.0+ structured prompt sections are preserved rather than flattening the whole prompt.

Plain-file memory retains upstream's concurrency model: direct edits and writeback do not add cross-process transactional merging. A shared worktree scope is not a new collaborative database.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
```

Routine checks contain unit tests and an isolated real Pi SDK smoke test. They use temporary repositories/HOME, no live credentials and no provider calls. The SDK test covers trusted/untrusted injection, structured prompt preservation and project writeback.

Real QMD tests use isolated config/cache roots and a dedicated fixture database:

```bash
npm run test:qmd
# Also exercise semantic/deep search using already installed local models:
PI_MEMORY_QMD_AI_TESTS=1 npm run test:qmd
```

The AI variant reuses the existing local model cache. It is opt-in and is not run in public CI. Provider-backed inference is separately opt-in with `npm run test:provider`; routine checks must not claim those live-provider tests passed.

GitHub Actions runs deterministic checks on Ubuntu/macOS for exact fork commits. A separate daily upstream report compares the frozen upstream base with upstream main; it never merges or publishes automatically.

See [fork maintenance](docs/fork-maintenance.md), the retained [upstream design](docs/design.md) and [memory effectiveness tests](docs/memory-effectiveness-testing.md).
