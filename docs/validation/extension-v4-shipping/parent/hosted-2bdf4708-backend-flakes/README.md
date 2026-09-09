# Hosted coverage first-pass flake metadata

Private raw provenance: CI run `34158014590`, head `2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7`; coverage shard logs `101853766506`, `101853766688`, and `101853766905` remain private.

Three first coverage passes failed at file level and then passed one serial isolated plain retry:

- shard 0: `src/__tests__/chat-tools-integration.test.ts` — 2389 pass, 1 fail, 129 files;
- shard 1: `src/__tests__/db-live-holder-guard.test.ts` — parent-owned;
- shard 2: `src/extensions/first-party-integration/auto-note/legacy-subprocess.integration.test.ts` — 2043 pass, 1 fail, 130 files.

No original assertion text, stderr, or stack trace survived in the retained hosted logs. The copied metadata records the job identities, retry policy, and successful decisive gates without raw logs or artifacts.
