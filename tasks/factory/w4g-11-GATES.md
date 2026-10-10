# Gates: W4G-11, the MCP suites that failed when run in one process

Brief: the coordinator's order (the 14 test files that use the MCP SDK fail 57 tests in one `bun test` process and
pass 138/0 one per process; find the shared state, fix the root cause, no per-file skip and no serial-only flag).
Base integ/w00 `a818ff85d`, branch `wp/w4g-11`. Evidence: `/tmp/factory-platform-evidence/w4g-11/`. Pinned Bun 1.4.2.

## The shared state, with evidence

- The polluter, found by pairs (`logs/pairs-mcp-server.txt`): only
  `docs/extensions/examples/substack-pilot/tests/mcp-sdk-resolution.test.ts` before `packages/@ezcorp/ai-kit/test/unit/mcp-server.test.ts`
  breaks it (6 fails); every other file before it leaves it green. Without the polluter the other 13 files pass 134/0
  in one process (`logs/without-polluter.log`).
- What leaks: that file registers `mock.module()` for `@modelcontextprotocol/sdk/client/index.js` (a fake `Client`)
  and `@modelcontextprotocol/sdk/client/stdio.js` (a fake transport) at module level. A Bun module mock holds for the
  whole process and `mock.restore()` does not undo it, so every later file that builds a real MCP client got the fake
  (`mcpClient.listTools is not a function`, `JSON Parse error: Unexpected identifier "OK"`): 57 failures across 7
  test groups.
- Why a plain restore was not enough: `mock.module()` patches the cached module in place, so a module namespace kept
  before mocking reads the fakes later. The real exports must be copied at capture time.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| The 14 files in one process | `logs/red-14-one-process.log`: 81 pass, 57 fail; the failing set `red-fails.txt` equals the set at 84a9ef717 | `logs/green-14-one-process.log`: 138 pass, 0 fail | this commit |
| One file per process | — | 138 pass, 0 fail (`logs/green-legs.txt`) | this commit |
| The fix | — | the polluter copies the real SDK exports before mocking them and registers them back in `afterAll`; no other file changes behaviour | this commit |
| A regression guard | `logs/regression-red.log`: the new pair in `src/__tests__/web-mock-pair-pollution.test.ts`, before the fix, 6 fails | `logs/regression-green.log` 1/0; the whole file 6/0 (`logs/regression-all.log`). The file's one helper now takes the directory a pair runs in | this commit |
| Mutant: keep the live namespace instead of copying | — | red, the same 81 pass and 57 fail (`logs/mutant-live-namespace.log`) | — |
| Package suites | — | the ai-kit package suite 224/0; the substack-pilot example tests 117/0 | this commit |
| Repository legs | — | typecheck 0, lint 0, guard set 62/0. Only test files change, so no product line needs coverage. substack-pilot is a bundled extension, so `manifest.lock.json` carries its new source digest and size (two lines, `scripts/regenerate-manifest-lock.ts`) | this commit |
