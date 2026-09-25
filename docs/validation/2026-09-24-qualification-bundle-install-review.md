# Qualification app bundle install: AMD review packet, 24 September 2026

**Status: installed and verified at 17:52 UTC on 24 September 2026.** The
rollback command has not run. This step installed one built EZHarness app tree
on AMD. It did not start a service, move a database, use a
credential, or change the Incus server. Run them only after review of this
exact source, destination, and rollback path. Keep the old isolated app and
runner running until the separate cutover review.

| Item | Pinned value or read-only observation |
| --- | --- |
| Source | `/tmp/ezh-qualification-release-0b81c087e`; `dev:users`, mode `0755`, 2.5 GiB |
| Source Git SHA | `0b81c087e7b2e5e896e0eea83e4bff16cfd91384` |
| Manifest SHA-256 | `82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17` |
| Bundled verifier SHA-256 | `838a3b2acba001333340d728f0aa43e924a974ba3284ea36ff315a9790015d2c` |
| Manifest | 76,066 entries; Bun 1.3.14 SHA-256 `80d5578a593f0c954739e7f14ec1e3c4dc00757cda1ff4bb8383e82b1e44871e` |
| Destination | `/opt/ezharness`, root-owned; absent at review |
| Sibling staging | `/opt/.ezharness-release-0b81c087e`, absent at review |
| Rollback hold | `/opt/.ezharness-held-0b81c087e`, absent at review |
| Host | `/opt` is root-owned mode `0711`; `/tmp` and `/opt` are on the same filesystem with about 205 GiB free at review |
| New services | `ezharness-qual-runner.service` and `ezharness-qual-supervisor.service` are not loaded and inactive at review |

The source passed `stage-release-bundle.py verify` again during packet
preparation. Its earlier non-root smoke returned HTTP 200 with the pinned GCC
runtime directory; see the [cutover readiness review](2026-09-24-isolated-app-cutover-ready-review.md).
The app service still needs the reviewed NixOS `LD_LIBRARY_PATH` setting.

## Recheck immediately before the first write

Run the blocks in one shell. Stop on any failed command or changed
observation. Check that `/opt` has at least 6 GiB
free for the copy and that no planned path exists, including a dangling link.

```sh
set -eu
source=/tmp/ezh-qualification-release-0b81c087e
stage=/opt/.ezharness-release-0b81c087e
target=/opt/ezharness
held=/opt/.ezharness-held-0b81c087e
manifest_sha=82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17
verifier_sha=838a3b2acba001333340d728f0aa43e924a974ba3284ea36ff315a9790015d2c
verify_bundle() {
  test "$(sha256sum "$1/release-bundle-manifest.json" | cut -d' ' -f1)" = "$manifest_sha"
  test "$(sha256sum "$1/scripts/incus/stage-release-bundle.py" | cut -d' ' -f1)" = "$verifier_sha"
  python3 "$1/scripts/incus/stage-release-bundle.py" verify --root "$1"
}
test "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gitSha"])' "$source/release-bundle-manifest.json")" = 0b81c087e7b2e5e896e0eea83e4bff16cfd91384
verify_bundle "$source"
test "$(stat -c %d "$source")" = "$(stat -c %d /opt)"
test "$(df -Pk /opt | awk 'NR==2 {print $4}')" -ge 6291456
sudo python3 - "$stage" "$target" "$held" <<'PY'
import os, sys
assert all(not os.path.lexists(path) for path in sys.argv[1:]), "planned /opt path exists"
PY
test "$(systemctl show ezharness-qual-runner.service -p ActiveState --value)" = inactive
test "$(systemctl show ezharness-qual-supervisor.service -p ActiveState --value)" = inactive
```

## Copy and publish

Keep the same shell variables. Copy into a sibling under `/opt`, then
give every copied entry to root. Verify the **copied** manifest and full file
inventory before publication. `mv --no-copy --update=none-fail -T` uses a
same-filesystem rename, refuses to replace an existing target, and fails if a
copy would be needed. The source bundle stays under `/tmp` for independent
comparison. The installed tree is readable by the dedicated app UID through
its existing file modes.

```sh
sudo install -d -o root -g root -m 0755 "$stage"
sudo cp -a "$source"/. "$stage"/
sudo chown -hR root:root "$stage"
verify_bundle "$stage"
test -z "$(sudo find "$stage" \( ! -user root -o ! -group root \) -print -quit)"
test "$(systemctl show ezharness-qual-runner.service -p ActiveState --value)" = inactive
test "$(systemctl show ezharness-qual-supervisor.service -p ActiveState --value)" = inactive
sudo mv --no-copy --update=none-fail -T "$stage" "$target"
test ! -e "$stage"
test "$(sudo stat -c %U:%G "$target")" = root:root
verify_bundle "$target"
test -z "$(sudo find "$target" \( ! -user root -o ! -group root \) -print -quit)"
```

Record the installed manifest hash, `verify` result, ownership check, and
service states in the cutover receipt. Do not start either service as part of
this install. A successful bundle check does not prove runner authorization,
database transfer, or Incus access.

## Failure and rollback

If copy or staging verification fails, leave `$target` absent. Keep the
staging tree for diagnosis; remove it only in a separately reviewed
cleanup. If publication succeeds but the post-install checks fail, keep the
services inactive and move only this exact target to the empty hold path:

```sh
test "$(systemctl show ezharness-qual-runner.service -p ActiveState --value)" = inactive
test "$(systemctl show ezharness-qual-supervisor.service -p ActiveState --value)" = inactive
sudo mv --no-copy --update=none-fail -T /opt/ezharness /opt/.ezharness-held-0b81c087e
test ! -e /opt/ezharness
sudo stat -c '%n %U:%G %a' /opt/.ezharness-held-0b81c087e
```

The rollback hold retains the exact installed bytes. Do not delete it or the
source bundle during this step. If either service has started, use the
separate cutover rollback procedure before changing its app path.

## Review result

The three shell blocks passed Bash syntax checks. The read-only preflight
block passed on AMD: the source Git SHA and pinned hashes match, the complete
bundle verifies, the filesystems match, free space exceeds 6 GiB, the three
planned `/opt` paths are absent, and both new services are inactive. The
copy, publish, and post-install checks then passed. The source remained at
`/tmp/ezh-qualification-release-0b81c087e`; the sibling staging path was
absent after the no-clobber rename. `/opt/ezharness` and its manifest read
back as root:root, with manifest SHA-256
`82b2bfeaa7c311097b280a6156e936bf5c0627c14d3fc38736bbde3180194b17`.
The full installed inventory verified. Both new services remained
`LoadState=not-found`, `ActiveState=inactive`, and the old isolated app health
endpoint still returned HTTP 200. The rollback hold remains absent; no
rollback or dedicated-UID service test ran.
