# fast-uri dependency remediation

- [x] Reproduce the CI audit failure locally: four unallowlisted high findings.
  Evidence: `/tmp/ez-fast-uri-audit-red.log`.
- [x] Update the transitive resolution from 3.1.5 to 3.1.6 with Bun 1.3.14.
  No dependency override or new allowlist entry remains. The lock also refreshes
  AI-kit's existing pinned workspace metadata; other resolved versions stay fixed.
- [x] Verify a forced frozen install resolves AJV's actual parser to 3.1.6.
  An ordinary install retained a stale nested copy in the existing local tree.
- [x] Verify the four affected normalization behaviors through AJV's resolved parser.
  Contract build and 23 tests / 291 assertions pass; SDK build and 1,023 tests /
  2,332 assertions pass. Logs: `/tmp/ez-fast-uri-contract-tests.log` and
  `/tmp/ez-fast-uri-sdk-tests.log`.
- [x] Run a real sealed build and two fresh isolated storage/lock smoke invocations.
  Evidence: `/tmp/ez-fast-uri-sealed-smoke.log`: 1 test / 10 assertions pass.
- [x] Re-run the unchanged audit gate: no unallowlisted high findings remain.
  Evidence: `/tmp/ez-fast-uri-audit-green.log`. Three existing allowlisted findings
  and six below-floor findings remain; this is not a zero-advisory claim.

Primary advisories all identify 3.1.6 as the fixed v3 release:
[scheme-relative IDN](https://github.com/advisories/GHSA-5jgf-p345-68v8),
[malformed IPv6](https://github.com/advisories/GHSA-f65p-4m7j-42xc),
[repeated host decoding](https://github.com/advisories/GHSA-fph4-wmhf-6fwf), and
[encoded schemes](https://github.com/advisories/GHSA-jqff-g426-hqxp).

The trusted SDK bundle includes this dependency. Earlier all-50 evidence predates
the dependency update; it must not be presented as a full run with this parser.

- [x] Re-run all 50 sealed candidates without interruption with the patched parser.
  At `3ee4f8cf`, `EXTENSION_VERIFY_ALL=1 bun scripts/verify-first-party-lifecycle-v4.ts`
  exits zero: 50 passed, zero failed, zero untested. Evidence:
  `/tmp/ez-all50-fast-uri-patched.jsonl`; stderr is empty. This verifies candidate
  builds, declared tests, catalogs and declared smoke checks, not every external
  capability. Backend-test and web/E2E typechecking also passes.
