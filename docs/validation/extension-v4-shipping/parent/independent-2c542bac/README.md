# Independent image verifier checkpoint — 2c542bac

This receipt curates only the completed independent rootless Podman phase from
`final-production-v2-2c542bac-20260907T184024Z`. It ran source
`2c542bace8f13c58eefa2db715fe54aab4111a62` against image
`c0941c22a713f343eee54e846c01fe630fe6ac7f8831b58afc3fd4155508fa95`.

The independent command exited `0`, reported eight passed checks, and its
owned-cleanup check exited `0`. The empty owned-residue diff shows no new owned
container, temporary root, or runner process after this phase. The raw
before/after inventories are intentionally private because they include
borrowed resources.

The independent boundary used rootless Podman `--userns=keep-id` with UID 1000.
It differs from the separate HTTP verifier boundary (app UID 1001/GID 100 and
cache ownership 1001:1001). This distinction is retained in the safe
provenance.

The 1800-second runtime-resource soak was still active when this receipt was
created. It is not included and this receipt makes no soak or full-suite claim.
Raw authentication material, state data, archives, and full compose logs remain
private.

`inputs/` contains byte-checked copies of the executed outer v2 controller and
the committed direct independent-verifier inputs. `metadata/checkpoint.json`
maps every published item to its private raw hash. `SHA256SUMS` covers every
published file except itself.
