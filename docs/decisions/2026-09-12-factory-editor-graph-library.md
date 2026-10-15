# Decision: use Svelte Flow and ELK for the factory editor, not the hand-rolled chat graph

**Date:** 2026-09-12 · **Status:** Accepted · **Area:** factory console / web dependencies
**Code:** planned; `web/src/lib/factory/` (not yet created); existing `web/src/lib/graph/layout.ts` stays as it is · **Feature:** [factory plan](../plans/2026-09-12-composable-factory-platform.md)

## Context

The repository has a recorded rule against graph libraries. `tasks/2026-07-26-chat-dag-graph.md` rejected d3, dagre, elk, cytoscape, and svelte-flow for the chat DAG, and `web/src/lib/graph/layout.ts` names that rule in its header comment. The result is a small, pure, deterministic layered layout whose tests pin exact coordinates because visual-evidence screenshots hash on them.

The factory console needs an interactive editor: drag to create nodes, connect typed ports with validation, select and delete edges, pan and zoom, keyboard access to every action, aggregate rendering of large maps, and live run overlays. That is a different product from a read-only DAG view. The plan named Svelte Flow and ELK without saying that the rule existed.

## Analysis

Measured: `web/src/lib/graph/` is three modules (layout, canvas view, panel logic) with pinned-coordinate tests. It has no interaction model, hit testing, edge routing, viewport, or virtualization. Not measured: the size of an in-house interactive editor. No prototype was built.

The known cost of Svelte Flow plus ELK is two runtime dependencies in `web/package.json`, a bundle increase to be measured in F09, and the coverage rule that every wrapper file is 100% covered while the libraries themselves live in `node_modules` and are not measured. The known cost of building in-house is an unbounded UI project on the critical path of stage 5, plus a second interaction model to keep accessible and evidence-tested.

## Decision

Use Svelte Flow for the interactive editor and the run canvas, and ELK for automatic layout of factory graphs. Confine both to `web/src/lib/factory/` with a boundary test that fails any import from elsewhere. Keep `web/src/lib/graph/` for the chat DAG unchanged; do not port it. Update the header comment in `layout.ts` and the task note so the rule scopes to the chat graph instead of the whole web tree. Pin both libraries in the release lock. Render large maps as aggregate groups with paginated inspection (C09).

## Consequences

- Two new runtime dependencies against a documented no-graph-library rule. The rule is narrowed, not removed.
- Two graph renderers ship. The chat DAG keeps its deterministic screenshot contract; factory views get their own evidence specs.
- ELK layout is deterministic for identical input, which the F09 round-trip and evidence tests rely on. A library upgrade that changes layout is a visual-evidence change and is reviewed as one.
- Wrapper components need 100% coverage keys; the libraries are not measured, and the boundary test is the only thing that stops them spreading.

## When to reconsider

Reconsider if F09 shows the editor bundle or interaction latency fails the C11 browser target on the recorded device, or if the boundary test is bypassed or weakened. The lever is the import boundary test and `web/package.json`. Removing the libraries means building the interaction model in `web/src/lib/graph/`, which then needs the same accessibility and evidence proofs.
