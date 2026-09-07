# Backend adbba8a6 first receipt

The backend receipt failed only at the SDK tarball hook after 120002.80 ms. Residual, new-file, and patch coverage gates passed. The merged coverage run exited 1, so its coverage is not authoritative and is not published here. The isolated SDK run omitted `EZCORP_RUN_PODMAN_TESTS=1`; it skipped one Podman-dependent test and cannot establish equivalence to the production container path.

The controller reports 25,970 passing tests, one failed SDK coverage leg, and 1,556 shards. The SDK summary has 1,028 passes and one failed hook. All 1,251 merged file thresholds pass, but the failed producer makes that coverage unsuitable for final proof. New-file and patch gates cover 133 and 389 files respectively.
