# Gates: coverage

- [ ] C1: Inventory every source exclusion and unmeasured executable surface; distinguish literal/type-only/generated output from executable behavior.
  EVIDENCE: 64 route Svelte files all contain scripts (only 9 have colocated tests), so they remain an explicit executable backlog; 13 migrations were executable and are now unexcluded. Pure declaration files compile to empty JavaScript and are structurally exempt. Worker had no prior LCOV; it now has a real HTTP producer. Shared api.ts (27.5%) and server/context.ts (72.9%) are real gaps still under repair; final inventory review remains pending.

- [ ] C2: Close executable coverage blind spots with real tests and strict measured enforcement, without lowering existing floors or hiding failed producers.
  EVIDENCE: init, search messages, 13 migrations (exact 100), test-agent-config (exact 100), 15 providers (97–100 with exact floors), and worker (direct canonical LF132/LH132, exact 100) have real producers. The 64 scripted Svelte routes remain open until the browser producer gathers and checks their merged source records.

- [ ] C3: Prove producer selection, merged coverage and failure controls; record added coverage and run-time cost.
  EVIDENCE: a full expanded Node/V8 run took 98.58s for 548 files / 7,146 tests. Its 555 product-source records pass the 556-candidate source guard (one declaration-only file); the manifest filter retains DA:0 records and removes fixture/style artifacts. Worker’s focused producer is 11 tests / 60 assertions with LF132/LH132. The first combined run correctly failed its broad lib floor on unfiltered fixture/style records; the corrected final combined run remains pending browser and final source integration.
