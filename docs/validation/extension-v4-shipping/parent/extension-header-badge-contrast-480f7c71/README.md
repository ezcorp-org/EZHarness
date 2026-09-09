# Extension header contrast checkpoint

This is a safe UI evidence checkpoint for the isolated patch based on
`480f7c71bc9e23839a6b526ccbfe453ea426ce17`. Parent review confirms that the
tested patch equals the pending parent integration diff. The two final input
hashes are verified in `metadata/final-input-verification.json`.

## Controls and final result

- **Header old-class control:** exit 1. The focused status tests had 2 failures
  and 2 passes. The light `Verified` header measured 1.21:1, below the 4.5:1
  threshold.
- **Whole-old-page control:** exit 1. This restored old header and banner
  classes together and had 4 failures. Header assertions can fail before a
  light banner measurement, so this control does **not** establish a numeric
  light-banner contrast value.
- **Final fixed run:** exit 0. The full deep-link spec passed 16 tests across
  Chromium and mobile Chromium. Parent review records 0 retries, 0 errors, and
  10 PNG attachments. `diff-check` also exited 0.

The patch gives light surfaces dark foregrounds with light status/banner tints.
It preserves the prior dark banner palette except for the banner path text,
raised to `red-300` after the old dark path measured below the 4.5:1 threshold.
The violation fixture sets `enabled: false`; its visible status is `Disabled`.

## Visual evidence

`metadata/all-png-attachments.json` maps all 10 final PNG attachments by
project, test ID, label, size, and hash. Only the four reviewed desktop theme
images are published in `reviewed-images/`. Parent opened all four and recorded
that header badges and the security-violation notice are readable in both
themes. Raw blob reports, logs, traces, and browser state remain private.

`raw-hashes/private-identities.json` provides exact identities for the private
red/green logs, patches, and final blob without publishing their contents.
