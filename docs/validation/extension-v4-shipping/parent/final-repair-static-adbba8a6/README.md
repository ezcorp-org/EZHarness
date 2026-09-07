# Final repair source checks

Parent replay on the exact bytes committed atadbba8a6:7109 Vitest tests in544files pass, allfour type-check sections pass, shipping suite wiring passes, lint/boundaries pass, and frozen web dependency installation passes. Lint retains97 warnings and11 informational findings. The shell syntax check also passes. Every recorded command exits0; controller exits0.

`committed-source-equivalence.json` compares each changed file with the committed blob. The tests ran before commit; this evidence does not invent a post-commit run. The only following source change was the verifier wrapper executable bit. Product-image and complete final backend/browser checks have separate receipts.

The committed-source dependency audit exits0 under the existing high-severity policy:four existing dated high-advisory suppressions andsix below-floor advisories remain across both lockfiles. No allowlist or severity rule was changed. The added web runtime now shares the existing native ONNX dependency; this result does not mean all dependencies have zero advisories.
