# Gates: Production container and runner

- [x] G1: A disposable production image completes the authenticated lifecycle with a real rootless runner.
  CHECK: bash scripts/verify-extension-container.sh localhost/ezcorp-extension-v4:validation
  EXPECT: "passed":true
  EVIDENCE: `/tmp/ez-container-script2.log`, eight checks pass; image `c7562e05e00c`. Final image still requires rerun.
- [x] G2: The final branch image passes the same check after all integration commits.
  CHECK: bash scripts/verify-extension-container.sh localhost/ezcorp-extension-v4:runner-final
  EXPECT: "passed":true
  EVIDENCE: `/tmp/ez-container-final-build3.log` and `/tmp/ez-container-final-verify3.log`; image `815764c0a0adc87d7206f1fe8cf0ae2ac7a85791700488d1e2fd88f5b7cd271b` passes all eight checks. Includes the file-organizer authority fix and final preview gutters. Later test or evidence edits do not change production image source.
