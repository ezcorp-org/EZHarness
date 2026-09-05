# Gates: Production container and runner

- [x] G1: A disposable production image completes the authenticated lifecycle with a real rootless runner.
  CHECK: bash scripts/verify-extension-container.sh localhost/ezcorp-extension-v4:validation
  EXPECT: "passed":true
  EVIDENCE: `/tmp/ez-container-script2.log`, eight checks pass; image `c7562e05e00c`. Final image still requires rerun.
- [ ] G2: The final branch image passes the same check after all integration commits.
  EVIDENCE: pending
