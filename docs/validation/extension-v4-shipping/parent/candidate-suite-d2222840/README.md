# Candidate production suite: d2222840 checkout on 9ca27583 image

The checked-out test revision was `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`.
The immutable product image was `localhost/ezcorp-extension-v4:shipping-9ca27583`,
ID `sha256:0f64f92d69ca2c38512f6a0f202c2027494166a250d82a7cd9621c10b42f63c0`,
built from `9ca275838faf30666da5dba1c0eba141dd053050`.

`checkout-image-source-diff.txt` records the four permitted test/verifier paths.
`frozen-inputs/` retains the exact stage and guard bytes plus copies of those source
inputs. The controller and all three stages exited `0`.

All eight canonical leaves exited `0`: File Organizer, embeddings, R1 restart
recovery, durable delivery, R3 revocation, bounded R4 resources, historical
upgrade/restore, and legacy-main adoption. `proof-command-cleanup-exits.tsv`
records every lifecycle phase command, app-log collector, and owned-cleanup exit.
No compose log or authenticated trace is copied. `parent-log-review.json` is the
safe post-run review: it hashes all 11 raw logs and reports 9 current-candidate
logs with no error or fatal record. The accompanying review program is post-run
analysis tooling, not an input to the executed controller.

`runtime/bundled-bootstrap-r1.json` and
`delivery/bundled-bootstrap-r2.json` retain each 28-installation observer record;
`bootstrap-observer-summary.txt` records their terminal `verified:28` states.

The upgrade proof keeps exact seed, candidate, and separate-restore lifecycle
receipts and `upgrade-state.json`, which records the seeded installation, owner,
workspace, release, approval, linked conversation, stored sentinel, and invocation
output. Its predecessor is source `3ec53eaa66409a39d66b502f79d74139ec94dcf2`, a
prior v4 candidate; it is not historical main or a published release.

Legacy adoption uses source `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3` from the
derived compatibility image `sha256:0552ca8b37dfbfe6b43752b68dcfeeaa443d7127d523e78ae7dcb5a0188b68c1`.
That image derives from historical-main image
`sha256:5f78e42b03fd4963ebdc7e535dc79219c4d5e2f890d431c82bb78e92a8b1d834` and adds
the compatibility asset SHA-256
`bc318f06884e68874ba57613ca2ae88e93e9845445c2a0f19383606b041f77cc`.
This does not claim that the unmodified main image passed. `adoption-state.json`
and the seed/adopt verifier records preserve the adoption boundary and retained
installation, owner, conversation link, and stored value checks.

This evidence does not claim hosted CI, a release publication, paid-provider
inputs, or the separate 24-hour soak.
