# Dedicated qualification app release bundle

The staging command builds a relocatable EZHarness release from one clean Git
commit. It writes to a new path only. It does not install under `/opt`, stop
services, copy a database, or contact the Incus server.

```sh
cd /path/to/clean/EZHarness
python3 scripts/incus/stage-release-bundle.py stage \
  --source "$PWD" --output /tmp/ezh-qualification-release-REVIEWED-SHA \
  --bun /path/to/pinned/bun-1.3.14 \
  --bun-sha256 REVIEWED_64_CHARACTER_SHA256
python3 scripts/incus/stage-release-bundle.py verify \
  --root /tmp/ezh-qualification-release-REVIEWED-SHA
python3 scripts/incus/stage-release-bundle.py smoke \
  --root /tmp/ezh-qualification-release-REVIEWED-SHA \
  --native-lib-dir /nix/store/REVIEWED-gcc-lib/lib
```

The source must have no tracked or untracked changes. Staging uses `git archive
HEAD`, frozen root and web locks, Bun 1.3.14, and the repository build
commands. The bundle includes the built web server and assets, native tools,
runner and package sources, the Incus supervisor and recipe, and installed root
and web dependency trees. The manifest records the Git SHA, both lock hashes,
the Bun binary hash, and every regular file's hash and mode or internal link
target. `verify` rejects changed files, missing dependencies, and links that
leave the bundle. The stage path must be under `/tmp` or `/var/tmp`, on a
filesystem with enough space for both the temporary build and final release;
the destination must not exist.

The smoke runs the bundled app as the caller's **non-root** UID on a loopback
ephemeral port. It creates disposable PGlite and home directories under `/tmp`,
uses smoke-only credentials, checks the app health endpoint, and stops the app.
It verifies the bundle again after the app stops.
On NixOS, the app's `sharp` native module needs `libstdc++.so.6`. Pin the exact
GCC runtime directory from the reviewed AMD host generation with
`--native-lib-dir`; the qualification service sets the same library path.
The bundle alone does not include that system library.
It does not test real runner authorization or an Incus connection. Run it before
installing a reviewed bundle under `/opt/ezharness`. The NixOS module expects
the bundle root there, including `bin/bun`, `web/build/index.js`,
`packages/@ezcorp/extension-runner/src/main.ts`, and
`scripts/incus/incus-qualification-supervisor.py`.

Review the manifest and exact destination before any root-owned install. The
stage command records the actual build output; it does not claim two web builds
are byte-for-byte identical until a separate repeated-build comparison proves
that property.
