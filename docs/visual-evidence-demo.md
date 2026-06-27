# Visual evidence — live demo

This file exists only to open a throwaway PR that exercises the
visual-evidence pipeline end-to-end on `main`:

1. CI's `Visual evidence` job runs the `@evidence`-tagged Playwright spec and
   captures a screenshot.
2. On CI success, `visual-evidence-publish.yml` (now fixed in #28) pushes the
   image to an orphan `evidence/pr-<n>` branch and posts an inline sticky
   comment on this PR.

Safe to delete once the screenshot comment appears.
