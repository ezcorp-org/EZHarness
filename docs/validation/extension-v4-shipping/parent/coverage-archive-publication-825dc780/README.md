# Coverage archive publication sanitization

Date: 2026-09-07 UTC

The two public coverage producer archives were rebuilt for publication. Each rebuild replaces one fixture extension identifier in `final-coverage-curated-19d/host/result_1423` with `<fixture-extension-id>`. It does not change test result fields, coverage records, timestamps, paths, or any other logical tar member.

The original compressed archives remain private. Their historical SHA-256 identities are retained in [archive-identities.json](archive-identities.json). The current public archives have different compressed-container SHA-256 values in the build [SHA256SUMS](../../../extension-v4-independent/build/SHA256SUMS). This is a sanitized-publication representation; it is not byte-identical to the historical archive and does not erase prior publication history.

The successful streamed level-19 reconstruction exited 0. [reconstruction-comparison.actual.json](reconstruction-comparison.actual.json) records the member-by-member comparison: 9,336 and 9,349 members respectively, with one required payload transformation in each archive. [execution.json](execution.json) records the command form, exit, compression settings, and script digest. [reconstruct-sanitized-coverage-archives.py.txt](reconstruct-sanitized-coverage-archives.py.txt) is the exact script used for that successful reconstruction.

The parent runs a separate verifier against both current archives and exact original Git blobs. It compares every logical header and every regular member byte, checks all hardlink identities, and permits only the one declared field replacement in each archive. `parent-independent-verification.json` records 18,685 headers and 12,462 regular payloads checked. Its actual exit is zero.
