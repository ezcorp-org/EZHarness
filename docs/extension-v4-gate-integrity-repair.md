# Extension v4 Gate integrity repair

At `93742772`, the unchanged gate reports 83 findings: one removed coverage obligation, 28 deleted tests, 24 renamed tests, and 30 reduced test files.

The repair restores all 82 protected test paths with current v4 behavior. Existing lifecycle, source import, approval, credential, and route cases move to those paths; shared fixtures avoid duplicate test bodies. New cases check missing authority, credential revocation, stale revisions, rejected reviews, failed candidate builds, and retained uninstall history. The previous private-source HTTP secrecy and credential recheck tests remain intact.

Host integration tests use an exact `// @ezcorp-host-integration` first line. The first-party source collector excludes only marked test/spec files from extension build snapshots. It retains runtime files and nonleading markers, and rejects marking the required portable `extension.test.ts`. Normal host test and coverage discovery still run the restored files. Portable tests for Code Quality, Code Review, Memory Extractor, and Extension Author remain in their source snapshots; their four lock records change accordingly.

The restored `bundled-drift-reapprove.ts` owns the live release grant normalization and equality functions. Both host authorization and publication use that shared implementation. Its original 100% coverage obligation is restored; a focused coverage run measures all six executable lines. Approval remains bound to the human, owner, scope, release, and requested grants.

The parent independently reviews the Terra changes, checks all 82 protected test paths with the unchanged gate functions, and runs affected tests. This working-tree preview clears the original findings. Delivery also requires the full gate against a normal commit, local static/test/coverage checks, and all CI on the pushed head. No approval label or gate bypass is used. Historical production and browser results retain their recorded source scope.

Local checks use the normal commands: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:coverage`, and `bun scripts/gate-integrity.ts`. The focused author journey uses a real durable repository and blob store with an injected deterministic runner; the production CI lane checks the actual worker boundary.
