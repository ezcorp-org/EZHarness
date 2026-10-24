# Gates: sensitive provider results wave 2

Scope: Add a bounded provider-secret result lane that only the credential broker can consume.

- [x] S1: Sensitive methods are classified and callable only through the credential-broker capability.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./packages/@ezcorp/extension-runner/tests/sensitive-protocol.test.ts ./packages/@ezcorp/extension-runner/tests/sensitive-service.test.ts ./src/extensions/__tests__/provider-secret-transport.test.ts ./packages/@ezcorp/sdk/src/v4/serve.test.ts --timeout 30000
  EXPECT: /0 fail/
  EVIDENCE: 105 expect() calls | Ran 27 tests across 4 files. [1482.00ms]

- [x] S2: Plaintext cannot enter normal RPC results, model tools, logs, audits, diagnostics, caches, or thrown errors.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./packages/@ezcorp/extension-runner/tests/sensitive-protocol.test.ts ./packages/@ezcorp/extension-runner/tests/sensitive-service.test.ts ./src/extensions/__tests__/provider-secret-transport.test.ts ./packages/@ezcorp/sdk/src/v4/serve.test.ts --timeout 30000
  EXPECT: /0 fail/
  EVIDENCE: 105 expect() calls | Ran 27 tests across 4 files. [1482.00ms]

- [x] S3: Malformed, oversized, timed-out, crashing, stdout, stderr, and unauthorized provider responses fail closed without canary leakage.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./packages/@ezcorp/extension-runner/tests/sensitive-protocol.test.ts ./packages/@ezcorp/extension-runner/tests/sensitive-service.test.ts ./src/extensions/__tests__/provider-secret-transport.test.ts ./packages/@ezcorp/sdk/src/v4/serve.test.ts --timeout 30000
  EXPECT: /0 fail/
  EVIDENCE: 105 expect() calls | Ran 27 tests across 4 files. [1482.00ms]

- [x] S4: Existing encrypted static credentials and ordinary extension methods remain compatible.
  CHECK: PATH=/home/dev/.bun/bin:$PATH bun test ./packages/@ezcorp/extension-runner/tests/protocol.test.ts ./packages/@ezcorp/extension-runner/tests/service.test.ts ./src/extensions/__tests__/credential-network-broker.test.ts ./src/extensions/__tests__/secrets-store.test.ts --timeout 30000
  EXPECT: /0 fail/
  EVIDENCE: 160 expect() calls | Ran 45 tests across 4 files. [7.33s]

- [x] S5: Owned code passes typecheck, lint, and whitespace validation with Bun 1.3.14.
  CHECK: test "$(PATH=/home/dev/.bun/bin:$PATH bun --version)" = "1.3.14" && PATH=/home/dev/.bun/bin:$PATH bun run typecheck && PATH=/home/dev/.bun/bin:$PATH bun run lint && git diff --check && echo SECRET_STATIC_CHECKS_PASS
  EXPECT: SECRET_STATIC_CHECKS_PASS
  EVIDENCE: Bun 1.3.14; root typecheck, root lint, and git diff --check all exited 0.

- [x] S6: The complete SDK compatibility suite preserves existing author and runtime behavior.
  CHECK: cd packages/@ezcorp/sdk && PATH=/home/dev/.bun/bin:$PATH bun test --timeout 30000
  EXPECT: /1020 pass[\s\S]*0 fail/
  EVIDENCE: 2276 expect() calls | Ran 1021 tests across 55 files. [7.45s]

- [x] S7: Every new sensitive-transport source file has complete line and function coverage.
  CHECK: coverage_dir=$(mktemp -d /tmp/ez-sensitive-gate.XXXXXX) && PATH=/home/dev/.bun/bin:$PATH bun test ./packages/@ezcorp/extension-runner/tests/protocol.test.ts ./packages/@ezcorp/extension-runner/tests/service.test.ts ./packages/@ezcorp/extension-runner/tests/sensitive-protocol.test.ts ./packages/@ezcorp/extension-runner/tests/sensitive-service.test.ts ./src/extensions/__tests__/credential-network-broker.test.ts ./src/extensions/__tests__/provider-secret-transport.test.ts ./packages/@ezcorp/sdk/src/v4/serve.test.ts --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$coverage_dir" >/dev/null && awk 'BEGIN { selected=0; complete=0 } /^SF:/ { matchFile=($0 ~ /(sensitive-host|provider-secret-transport|provider-credentials)\.ts$/); if (matchFile) selected++ } matchFile && /^FNF:/ { fnf=substr($0,5) } matchFile && /^FNH:/ { functions=(substr($0,5)==fnf) } matchFile && /^LF:/ { lf=substr($0,4) } matchFile && /^LH:/ { if (substr($0,4)==lf && functions) complete++ } END { if (selected==3 && complete==3) print "3 source files 100%"; else exit 1 }' "$coverage_dir/lcov.info"
  EXPECT: 3 source files 100%
  EVIDENCE: 205 expect() calls | Ran 50 tests across 7 files. [2.14s]

- [x] S8: A process that handles a classified secret cannot publish ordinary notifications, reverse RPC, or ordinary responses, including after its sensitive result completes.
  CHECK: for file in packages/@ezcorp/extension-runner/tests/protocol.test.ts packages/@ezcorp/extension-runner/tests/service.test.ts packages/@ezcorp/extension-runner/tests/sensitive-protocol.test.ts packages/@ezcorp/extension-runner/tests/sensitive-service.test.ts packages/@ezcorp/sdk/src/v4/serve.test.ts src/extensions/__tests__/provider-secret-transport.test.ts src/extensions/__tests__/credential-network-broker.test.ts; do PATH=/tmp/bun1314:$PATH bun test "./$file" --timeout 30000 || exit 1; done
  EXPECT: Every isolated file exits 0; 57 tests pass in total.
  EVIDENCE: Astra review, 2026-09-22: five new regressions failed on the previous implementation. After the fix, protocol 8, service 5, sensitive protocol 13, sensitive service 4, SDK serve 14, provider transport 3, and credential/network broker 10 all passed with Bun 1.3.14. Full repository typecheck, lint, and git diff --check exited 0; lint reported eight existing informational findings outside the edited files.

## Astra notification and reverse-RPC review — 2026-09-22

A real worker emitted a valid `provider/log` notification containing a canary
before and after its classified response. The previous framing code delivered
both notifications to ordinary listeners; the Unix service returned them from
`/v4/events`. Additional regressions reproduced ordinary reverse-RPC forwarding,
ordinary responses after secret handling, and classification while an ordinary
request was still active.

The worker and service now keep permanent sensitive state. Notifications are
dropped and ordinary requests and reverse RPC are denied with fixed errors.
Classification requires ordinary requests and reverse RPC to finish first.
The service clears queued events and also enforces this boundary independently
of the execution implementation. Tests cover a real child process, the real
Unix service, injected execution behavior, queued events, and concurrent calls.
Promise barriers control concurrency; no timed sleeps are used by the new tests.

Ordinary host reverse RPC is unavailable after classification. Live provider
integration must supply a separate reviewed path for any necessary protected
host access. These checks do not qualify a live Infisical deployment.

## Independent security review

The review found and fixed one mutable-memory lifetime defect. A sensitive
response that timed out before its newline left raw provider bytes in the
runner's partial control-frame buffer. Sensitive stdout and stderr chunks were
also released without an explicit wipe. The runner now clears prior partial
buffers, complete frame buffers, current stdout chunks, stderr chunks, and the
retained partial buffer on failure. The regression retains references to the
delivered chunks and verifies that every byte is zero after the timeout.

The final focused log and complete SDK log contain none of the fixed canary
values. The classified suite passed 27 tests with 105 assertions. Compatibility
passed 45 tests with 160 assertions. The complete SDK suite passed 1,020 tests,
skipped one container test, and failed zero. Root lint passed with eight existing
informational findings. Backend, web, and backend-test typecheck passed. The
shared-tree combined typecheck did not produce a stable final receipt because
concurrent sandbox and preview/attachment owners were still changing their
call sites. Every observed type error was outside the secret path; the root
wave must rerun the combined check after those owners finish.

Plaintext still exists transiently as immutable JavaScript strings in the
trusted provider handler, UTF-8 decoding, credential broker, and outbound
authorization header. JavaScript cannot deterministically wipe those strings.
The mutable byte buffers owned by this transport are wiped. Provider code is a
trusted secret principal and can disclose credentials through its own code;
this lane prevents accidental transport/error/log
disclosure, not a malicious trusted provider. This review did not qualify
Infisical or any live provider deployment.
