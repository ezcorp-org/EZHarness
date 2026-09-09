# Launcher cleanup receipt contract

This evidence freezes the three private controllers used for source `79108f9d` validation. Each controller requires exactly one numeric `command_exit`, `app_log_exit`, `owned_cleanup_exit`, and `verifier_cleanup_exit` field. A successful launcher requires all four values to be zero.

`controls/` contains five safe fixture logs and the parser bodies extracted from all three frozen controllers. `results.tsv` has 15 rows: five fixtures for each controller. `valid-zero` passes parser and policy. `verifier-nonzero` has valid receipt syntax but fails the all-zero consumer policy. `missing`, `duplicate`, and `malformed` fail parsing and policy.

The historical failed controls are retained in `history/`. The first harness exited 2 because its generated shell source contained a literal `\\n` before `esac`; it did not run a parser. The second extraction attempt exited 1 because fixtures were not written after an extraction comparison stopped; its parser failures are not control evidence. The final 15-row control is the authoritative result.

The controllers and control scripts are inert `.txt` copies. No launch, image, authenticated receipt, or secret is included.
