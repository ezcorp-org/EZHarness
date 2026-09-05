# Pure workflow evaluation

- [x] Reproduce the namespaced template dry-run regression after release authority enforcement.
- [x] Keep real direct execution subject to release authority.
- [x] Recognize only executors constructed inside the fixed dry-run factory. The private weak set has no public registration function or caller flag.
- [x] Keep the private event bus, disabled persistence, forbidden tool/agent adapters and absent nested resolver.
- [x] Test that an unsafe substitution predicate cannot dispatch real effects and that matching public constructor options do not grant the pure exemption.

Red proof: `/tmp/ez-leaf-workflow-templates.test.ts.red.log`.
Green template and evaluator proof: `/tmp/ez-pure-workflow-green.log`, 132 tests and 390 assertions.
Authority and evaluator coverage proof: `/tmp/ez-pure-workflow-coverage.log`, 41 tests and 194 assertions.

This evaluates data and substitutions only. It does not grant an extension execution permission or replace the HTTP route's live release authorization.
