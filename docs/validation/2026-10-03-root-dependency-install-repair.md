# Root dependency installation repair — 3 October 2026

The full fast gate on `e177f21e6` reported six failures in `src/__tests__/root-dependency-security.test.ts`. Pinned Bun 1.3.14 reproduced the failures against the existing installation: 1 pass, 6 fail. The package manifest, lockfile, and test matched the committed source.

The real dependency callers still resolved old installed packages. Drizzle's loader used esbuild 0.18.20 and exposed wildcard CORS. AJV used fast-uri 3.1.6; the MCP rate limiter used ip-address 10.4.0; schema minimatch used brace-expansion 5.0.9. ExcelJS's UUID bounds check also failed. The committed lockfile already selected patched dependencies. A successful ordinary frozen install had not repaired the existing caller resolutions.

A separate worktree at `e177f21e6`, with frozen root and web installs, passed the unchanged security test: 7 pass, 0 fail, 25 assertions. This isolated the defect to existing installation state.

The existing tree was then repaired with:

```sh
/home/dev/.bun/bin/bun install --force --frozen-lockfile
/home/dev/.bun/bin/bun test --timeout 30000 src/__tests__/root-dependency-security.test.ts
```

The install exited 0. The unchanged test passed: 7 pass, 0 fail, 25 assertions. Readback from each actual caller confirmed:

| Dependency | Resolved version |
| --- | --- |
| Drizzle loader esbuild | 0.28.1 |
| ExcelJS UUID | 11.1.1 |
| AJV fast-uri | 3.1.8 |
| MCP rate limiter ip-address | 10.7.3 |
| Schema brace-expansion | 5.0.12 |
| Readdir glob brace-expansion | 2.1.7 |
| Legacy archiver glob brace-expansion | 1.1.21 |

No package, lockfile, test, threshold, or security gate changed. No shared global cache was deleted. No live qualification app or Incus resource changed.

After merging dependency overrides, inspect the versions resolved from their real callers. If they differ from the committed lockfile, reproduce with a clean frozen install, then repair the existing installation with a forced frozen install. Do not weaken the security assertions to match stale packages.
