# Embedding cache v4 verification checkpoint

This safe checkpoint records the clean controller run for source
`2c542bace8f13c58eefa2db715fe54aab4111a62`. It is separate from the earlier
rejected `4da2058f` cache checkpoint.

## Image and terminal result

The controller, main, cleanup, and terminal exits are all zero. Docker and
native Podman retain the same image identity
`c0941c22a713f343eee54e846c01fe630fe6ac7f8831b58afc3fd4155508fa95`, label it
with the exact source revision, and report user `bun`.

Both verifier phases pass. Each has verifier exit zero, app-health exit zero,
boundary exit zero, and zero exits for command, app-log collection, owned
cleanup, and verifier cleanup.

## Vector, cache, and app logs

The first phase stores a ready 384-dimensional normalized vector after 30
polls. The read-only-cache second phase stores the same proof after one poll.
The cache has four nonempty files, every retained ownership row is UID:GID
1001:1001, and both digest lists are identical. UID 1001 can write the cache
but not the installed Transformers package directory.

The app-log guard passes in both phases. The private compose logs contain no
structured error or fatal records and no native cache/error signature. The
first contains one `embed-worker` degraded-mode warning during initialization;
the second has no warning-level structured record. Raw logs, auth data, state,
and archives remain private.

## Retained inputs

`controllers/` and `inputs/` contain inert exact copies of the frozen
controller and source inputs. `inputs/original-input-hashes.sha256.txt` is the
original path-based controller receipt, retained as evidence rather than as a
local checksum index. `metadata/private-raw-identities.json` records hashes and
sizes for private build, transfer, verifier, app-log, and cache artifacts.
`SHA256SUMS` covers every safe retained file.
