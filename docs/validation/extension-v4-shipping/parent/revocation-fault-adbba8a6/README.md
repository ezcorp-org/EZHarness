# R3 revocation fault control — adbba8a6

This receipt records the final candidate's expected-red R3 sensitivity control.

- Source revision: `adbba8a693cdcd4410c51023dfca93517f9db1e8`.
- Image: `localhost/ezcorp-extension-v4:shipping-adbba8a6`.
- Image ID: `sha256:3800bd95cd2e106d1d3b9fb304cddce94db5872006f5a4b782d673e01a601b8f`.
- Injected condition: `EZ_SHIPPING_REVOKE_FAULT=1` omitted the disable action before the held worker resumed.
- Raw command exit: `1`, as intended. Harness cleanup exit: `0`.
- The expected denial assertion failed at `scripts/verify-shipping-revocation.ts:101`: `disable must deny the paused handler's next storage effect`.

The matching normal green proof is [candidate-suite-adbba8a6/revocation](../candidate-suite-adbba8a6/revocation/): it records control success, disable/uninstall tool failures, and no denied storage effect.

`command.log`, `verification.log`, and `provenance.txt` are safe retained command, predicate, and candidate identity records. Compose logs, runner logs, and authentication material are intentionally excluded.
