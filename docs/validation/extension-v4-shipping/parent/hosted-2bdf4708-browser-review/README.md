# Hosted browser review — 2bdf4708

Read-only review of GitHub Actions run `34158014590` at
`2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7`.

At the terminal browser-job snapshot, mock E2E, Firefox lifecycle, WebKit
lifecycle, visual evidence, the Bun web leg, all three Vitest shards, and web
security coverage passed. The real-auth job failed before browser setup because
the workflow invoked the deleted `web/e2e/real-auth/_sandbox-spawn-probe.bun.ts`.
Its mandatory runner setup completed first and logged `Extension runner kernel
controls verified`.

Counts are only stated where the job log printed them: mock E2E reports 255
passed and 13 skipped; Firefox and WebKit each report 3 passed; visual evidence
reports 191 passed in its first Playwright run and 13 passed in its second; the
three Vitest shards report 183 files each and 2,413, 2,418, and 2,314 tests.
The available job logs do not provide a supported retry counter, so this review
does not claim zero retries. Their `Post job cleanup` records are GitHub job
cleanup records, not an independent fixture-cleanup proof.

Raw job logs and browser artifacts remain under `private/` and are not copied
here because they can contain authenticated browser material. `terminal-steps.tsv`
and `artifact-metadata.json` contain only safe metadata.
