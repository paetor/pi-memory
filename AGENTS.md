# Fork development

Read README.md and docs/fork-maintenance.md. Keep this fork narrow: Git-aware memory scope and scoped QMD integration, not a new memory platform. Preserve upstream ancestry, tests and MIT attribution.

Memory sources and credentials must never be committed. Project memories live under Git's common metadata directory, not the working tree. Use temporary HOME, agent, memory, QMD config/cache and Git fixture roots for tests. Do not call real providers in routine checks.

Use `npm ci --ignore-scripts` and run `npm run check` before committing. Search changes also require isolated real QMD testing when the local CLI is available; semantic/deep tests require existing local models. Distinguish tests that passed from optional tests that were skipped.

Do not publish to npm, force-push, bypass hooks, modify unrelated work, or install/reload a live extension without applicable authorization. GitHub source publication and local activation are separate steps. After authorized publication verify the destination SHA and exact-commit CI.
