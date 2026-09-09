# Moved assertion inventory

Each row compares the base object at the old path with the candidate file at the new path. Direct assertion lines were trimmed and compared after removing TypeScript non-null markers. Fixture and import changes were inspected in the Git rename diff. All destinations are in both `passfail_files` and `coverage_host_files`.

| Ledger | Old path | Candidate path | Tests old/new | Assertions old/new | Result |
| ---: | --- | --- | ---: | ---: | --- |
| 28 | `packages/@ezcorp/ai-kit/test/e2e/bundled.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/bundled.test.ts` | 3/3 | 7/7 | Same titles and assertions; import path only. |
| 29 | `packages/@ezcorp/ai-kit/test/e2e/doctor.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/doctor.test.ts` | 2/2 | 3/3 | Same titles and assertions; import paths only. |
| 30 | `packages/@ezcorp/ai-kit/test/e2e/fanout.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts` | 4/4 | 6/6 | Same titles and assertions; import path only. |
| 31 | `packages/@ezcorp/ai-kit/test/e2e/internal-auth.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts` | 4/4 | 5/5 | Same titles and assertions; import path only. |
| 32 | `packages/@ezcorp/ai-kit/test/e2e/on-behalf-of.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/on-behalf-of.test.ts` | 1/1 | 2/2 | Same title and assertions; import path only. |
| 33 | `packages/@ezcorp/ai-kit/test/e2e/quickstart.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/quickstart.test.ts` | 1/1 | 4/4 | Same title and assertions; import path only. |
| 34 | `packages/@ezcorp/ai-kit/test/e2e/real-subprocess-obo.test.ts` | `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts` | 4/4 | 17/17 | Same titles and assertions; import path only. |
| 35 | `packages/@ezcorp/ai-kit/test/unit/events.test.ts` | `src/extensions/first-party-integration/ai-kit/unit/events.test.ts` | 2/2 | 1/1 | Same titles and assertion; import path only. |
| 36 | `docs/extensions/examples/docs-updater/index.integration.test.ts` | `src/extensions/first-party-integration/docs-updater/index.integration.test.ts` | 6/6 | 27/27 | Same titles and assertions; fixture paths only. |
| 37 | `extensions/ez-factory/__tests__/unattended-fire-e2e.test.ts` | `src/extensions/first-party-integration/ez-factory/__tests__/unattended-fire-e2e.test.ts` | 31/32 | 92/99 | Changed behavior. Definition-only release now refuses old consent and needs new consent; no silent reauthorization audit is written. Wider agent capability drift adds an exact release-binding and suspended/no-invocation control. |
| 38 | `extensions/ez-factory/lib/sanitize.test.ts` | `src/extensions/first-party-integration/ez-factory/lib/sanitize.test.ts` | 25/25 | 39/39 | Same titles and assertions; import path only. |
| 39 | `extensions/ez-factory/workflow-templates.test.ts` | `src/extensions/first-party-integration/ez-factory/workflow-templates.test.ts` | 115/115 | 211/211 | Same titles and assertions; fixture paths and TypeScript non-null markers only. |
| 40 | `docs/extensions/examples/file-organizer/index.test.ts` | `src/extensions/first-party-integration/file-organizer/index.test.ts` | 39/39 | 52/52 | Same titles and assertions; fixture paths only. |
| 41 | `docs/extensions/examples/file-organizer/lib/page.test.ts` | `src/extensions/first-party-integration/file-organizer/lib/page.test.ts` | 39/39 | 68/68 | Same titles and assertions; fixture paths only. |
| 42 | `docs/extensions/examples/sample-loop/index.integration.test.ts` | `src/extensions/first-party-integration/sample-loop/index.integration.test.ts` | 2/2 | 6/6 | Same titles and assertions; fixture paths only. |
| 43 | `docs/extensions/examples/sample-loop/try-loop.test.ts` | `src/extensions/first-party-integration/sample-loop/try-loop.test.ts` | 2/2 | 6/6 | Same titles and assertions; fixture paths only. |
| 44 | `docs/extensions/examples/seo-watcher/subprocess.integration.test.ts` | `src/extensions/first-party-integration/seo-watcher/subprocess.integration.test.ts` | 2/2 | 15/15 | Same titles and assertions; fixture paths only. |
| 45 | `docs/extensions/examples/substack-pilot/tests/install-gate.test.ts` | `src/extensions/first-party-integration/substack-pilot/tests/install-gate.test.ts` | 20/20 | 31/31 | Same titles and assertions; fixture paths only. |
| 46 | `docs/extensions/examples/substack-pilot/tests/permissions.test.ts` | `src/extensions/first-party-integration/substack-pilot/tests/permissions.test.ts` | 16/16 | 39/39 | Same titles and assertions; fixture paths only. |
| 47 | `docs/extensions/examples/task-stack/e2e-server-pipeline.test.ts` | `src/extensions/first-party-integration/task-stack/e2e-server-pipeline.test.ts` | 7/7 | 27/27 | Same titles and assertions; fixture paths only. |
| 48 | `docs/extensions/examples/task-stack/sandbox-load.test.ts` | `src/extensions/first-party-integration/task-stack/sandbox-load.test.ts` | 2/2 | 3/3 | Same titles and assertions; explicit original fixture `import.meta` path replaces moved-file path. |
| 49 | `docs/extensions/examples/todo-tracker/e2e-server-pipeline.test.ts` | `src/extensions/first-party-integration/todo-tracker/e2e-server-pipeline.test.ts` | 6/6 | 17/17 | Same titles and assertions; fixture paths only. |
| 50 | `docs/extensions/examples/todo-tracker/sandbox-load.test.ts` | `src/extensions/first-party-integration/todo-tracker/sandbox-load.test.ts` | 2/2 | 3/3 | Same titles and assertions; explicit original fixture `import.meta` path replaces moved-file path. |
| 51 | `docs/extensions/examples/web-search/e2e-server-pipeline.test.ts` | `src/extensions/first-party-integration/web-search/e2e-server-pipeline.test.ts` | 5/5 | 15/15 | Same titles and assertions; fixture paths only. |
| 52 | `docs/extensions/examples/webhook-ticket-loop/subprocess.integration.test.ts` | `src/extensions/first-party-integration/webhook-ticket-loop/subprocess.integration.test.ts` | 3/3 | 5/5 | Same titles and assertions; fixture paths only. |

The four adapted deleted suites are separate from Git's rename set:

| Ledger | Old path | Candidate path | Old/new test behavior |
| ---: | --- | --- | --- |
| 2 | `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts` | `src/extensions/first-party-integration/auto-note/e2e-server-pipeline.test.ts` | Seven tests retain framing, malformed-input recovery, concurrency, and state shape. Persistent-process survival changes to fresh isolated workers with durable state. |
| 3 | `docs/extensions/examples/docs-updater/subprocess.integration.test.ts` | `src/extensions/first-party-integration/docs-updater/subprocess.integration.test.ts` | One test retains real Git read, one agent spawn, and deferred cursor through isolated execution. |
| 5 | `docs/extensions/examples/github-stats/e2e-server-pipeline.test.ts` | `src/extensions/first-party-integration/github-stats/e2e-server-pipeline.test.ts` | Parameterized denial still covers all three tools; unknown-tool recovery, sequential/concurrent framing, and no disable after tool errors remain. Persistent-process wording is removed. |
| 6 | `docs/extensions/examples/repo-activity-notify/index.integration.test.ts` | `src/extensions/first-party-integration/repo-activity-notify/index.integration.test.ts` | Real commit still appends and persists once; unchanged commit is declined. |
