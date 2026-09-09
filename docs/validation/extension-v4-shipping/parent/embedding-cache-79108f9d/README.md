# Embedding cache verification checkpoint

This is a safe evidence checkpoint for the frozen source
`79108f9deb128ffa9780a08530f0121273ddc5ef` and the controller run beginning
at `2026-09-07T17:31:48Z`.

## Result

The controller exits `0`; its main and cleanup exits are both `0`. It built
and transferred one image with matching Docker and native Podman identity
`4da2058ff34b7f87fb9036dfa038e9ef71a74b52c8af434088fe6772c37c9098` and the
full source revision above. Both image records identify the runtime user as
`bun`.

Two real verifier phases passed. In each phase, the command, app-log
collection, owned cleanup, verifier cleanup, and boundary checks exit `0`.
The first run creates the cache; the second starts with that cache read-only.
The two nonempty cache-file digest lists are identical. The UID 1001 probe
reports four cache files, writable cache entries, and a non-writable installed
Transformers package directory.

The first verifier records a ready stored vector with 384 dimensions,
normalized norm `0.9999999760164612`, after 30 polls. The second records the
same check with norm `0.9999999777457041` after two polls. This is an online
production verification. It does not prove offline inference.

## App-log classification

The controller logs are not used as an app-log proxy. The two private
`compose.log` files were parsed separately. Each contains one plain-text
`EACCES` write failure to Transformers' package-relative `.cache` directory.
The hub warning text says `browser cache` for any cache backend, so it does not
identify the backend or resource URL. Therefore the vector/cache proof is
successful, but the app logs are **not clean**. No structured error-level
records were found.
The first run also has one warning-level structured `embed-worker` record with
no message or code; the second has no warning-level structured record.
Nonstructured rows are retained only as counts and are not treated as approved.
Raw logs, HTTP/auth data, runtime state, and archives remain private.

## Retained inputs and integrity

`controllers/` and `inputs/` are inert copies of the exact controller and
frozen source inputs. `inputs/original-input-hashes.sha256.txt` is the original
path-based controller receipt, retained as evidence rather than as a local index. `metadata/private-raw-identities.json` identifies each
private raw build, transfer, verifier, compose, and cache record by hash and
size. `SHA256SUMS` covers every retained safe file.
