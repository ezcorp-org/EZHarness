# Code quality and ease of use repairs

The audit reviewed main at `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.
Four Terra agents gathered evidence and implemented assigned repairs in separate
worktrees. The parent reviewed the designs, integrated the changes, and owns the
findings below.

## Changes

| Finding | Result | Main proof |
| --- | --- | --- |
| F01: extension memory loses project scope | All memory inserts share one transaction for the row, project memberships, and audit record. Membership changes also update the legacy project field. | Database tests check project/global search and unassignment across migration restart. |
| F02: compaction selects itself or crosses scope | Candidate search excludes the source and requires the same owner, project set, and injection policy. The final transaction rechecks both locked rows. | Tests cover different scopes, concurrent edits, rollback, and successful replacement. |
| F03: memory quota resets or races | A conditional database counter update and memory insert share one transaction. | Concurrent writes admit only the quota; failed inserts restore the allowance. |
| F04: members see admin-only provider actions | Onboarding, chat, and the sidebar checklist share the provider access rule. Members receive setup guidance and can finish onboarding. | Component tests and a real invited-member browser journey. |
| F05: workflow form drops unsupported YAML | Both editor entry points strip API provenance through the shared definition helper. Unsupported definitions open in YAML before an edit can discard fields. | Round-trip tests and the workflow editor browser journey. |
| F06: bundled GitHub example requests unavailable credentials | GitHub stats uses the public API, declares its actual capabilities, and explains its public-repository limit. | Tests call the shipped GitHub API handlers; SDK transport and bundled installation are also tested. |
| F07: generated author workflow is incomplete | Scaffolds use the SDK dispatcher and current manifests. Documentation gives executable host-checkout verification and installation commands. | Generated project tests, verifier tests, and tutorial checks. |
| F08: author and host contracts drift | The host composes shared SDK types with explicit host-only metadata. Unknown manifest fields fail with their path. Marketplace import handles its export timestamp separately. | Type checks, strict manifest tests, and export/import route tests. |
| F09: browser counts overstate real coverage | First-run setup uses the shipped route and a dedicated fresh-database lane. Core onboarding, provider, quickstart, and workflow regressions run in CI. Screenshot capture dispatches mock and real-auth specs to their own runners. | Browser lane and evidence manifests; real setup and auth runs. |
| F10: contributor commands disagree | Root and web instructions use the pinned runtime, both installs, isolated backend tests, and the same browser lanes as local CI. | Frozen installs and local check commands. |
| F11: progress and save errors stay stale | Quickstart refreshes after mutations and rejects stale responses. Failed chat and onboarding saves retain input and show an error. Provider inputs have labels and readable error text. | Store, component, and browser tests. |
| F12: failed setup has separate cleanup | Provider validation precedes tool acquisition. Setup errors use the common cleanup function before terminal persistence. | The public chat regression fails on the original code and passes after repair; terminal-write failure tests verify cleanup. |
| F13: duplicated persistence and unchecked tests | Workflow steps share one prepared durable record and insert/update projection. Two auth suites share a typed redirect capture helper and keep explicit assertions and rejoin type checking. Unused Fallow configs are removed. | Workflow persistence tests, auth tests, lint scope regression, and the reduced typecheck ratchet. |

Final verification also exposed these defects outside the original audit list:

- Bun 1.3.14 reused an old database path from its runtime transpiler cache.
  Two fresh-process probes received different environment paths but returned the
  same stale module value. Disabling the cache returned the correct paths.
  Both browser preview launchers now set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
- A tooltip could remain over a drawer after a click because mouse and focus
  events scheduled separate timers. The tooltip now owns one timer. Its resize
  and scroll listeners also remain active when the tooltip opens.
- The screenshot job used only the mock runner, which excludes real-auth
  specs. Capture now uses the correct runner for each selected spec and retains
  both reports. A credited failure remains a failed check.
- Caller-tool browser tests minted separate keys under one user and could hit
  that user's write limit. The two test groups now use separate invited
  members; each test has its own key and conversation. Each group stays within
  the write limit, and two invites stay within the full suite's invite budget.
  Production limits are unchanged. The ownership test also now probes a real
  admin-owned conversation, alongside its missing-ID control.

## Design limits

- Compaction requires identical project memberships. Merging different project
  sets would broaden where remembered content is visible.
- Junction-table backfill runs only when that table is first created. Repeating
  it can restore a project membership that a user removed. Existing ambiguous
  legacy rows need an explicit data-repair decision; this change does not guess.
- Extension manifests now reject unrecognized fields. This makes spelling
  errors visible. JSON Schema property maps and other declared open maps remain
  open. The removed example `subAgents` field had no runtime consumer;
  GitHub Projects still starts through the bundled registry's `bootSpawn` flag.
- GitHub stats supports public repositories and GitHub's unauthenticated rate
  limit. Private-repository support needs a separately designed credential path.
- The typecheck ratchet shrinks from 52 files to 50. Existing lint/Svelte warnings
  and browser backlog remain visible; this repair does not claim they are gone.

## Validation

Validation used the pinned Bun 1.3.14 and Node 24.14.1, with frozen root and web
installs. Browser runs used generated disposable databases and the shipped
production build.

| Check | Result |
| --- | --- |
| Full backend pool | 24,004 passed across 1,395 files. |
| Full web Bun pool | 4,238 passed across 224 files. |
| Full Node Vitest pool | 7,019 passed across 525 files; the later actual-store dock test also passed in the coverage producer. |
| Full coverage pipeline | 25,197 Bun tests passed across 1,382 shards; 4,496 Node tests passed. |
| Final coverage producer refresh | 1,370 package tests and 4,497 Node tests passed. Merged with the unchanged full host coverage. |
| Coverage gates | All 1,081 thresholds pass; the new source file and every changed executable line pass. |
| Typecheck and Svelte check | No errors. The checked-file exception count is 50; Svelte reports 18 existing warnings. |
| Lint and integrity | Lint, gate integrity, manifest hashes, lane checks, and diff checks pass. Lint reports 87 warnings and 14 informational findings. |
| Fresh first-user setup | 3/3 pass against a new database. |
| Full mock browser gate | 241 pass; 12 existing Docker-only tests skip. Process exits 0. |
| Real-auth browser lane | All 52 tests pass on a fresh database; process exits 0. Includes isolated caller-tool users and the actual cross-user ownership check. |
| Visual capture | 71 mock tests and 2 real-auth tests pass; 92 screenshots from both reports are retained. |

The final Node coverage refresh also removed generated Svelte-check copies from
source matching by rooting the existing route patterns under `src/`. No source
file was excluded and no threshold was reduced.

One local preview launch reached its startup timeout before opening a port.
Controlled later launches started normally. The log did not establish a
deterministic blocking operation; this change does not claim that startup
incident is repaired. No timeout increase or test retry was added.

The public chat setup regression was run against the original source and the
repair. It fails on the original source and passes after provider validation is
moved before tool acquisition. Memory tests cover concurrent quota writes,
rollback, scope changes during compaction, and migration restart. GitHub stats
tests call the shipped API handlers rather than a copied implementation.

Browser screenshots were inspected for member guidance at desktop and mobile
sizes, provider controls, workflow fallback, and failed-save drafts. The
screenshot capture helper is also tested with stub processes: it preserves both
reports, rejects stale reports, routes real-auth correctly, and propagates each
tier's actual exit code.
