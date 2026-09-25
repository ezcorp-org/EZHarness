# Isolated app sealed-settings candidate, 24 September 2026

Status: **manifest template only**. No traffic hold, environment capture,
service change, database move, or write to `/etc/ezharness` occurred.

The private stage directory is
`/root/ezh-qualification-settings-candidate-20260924` (root:root 0700,
empty). The exact-key manifest template is
`/root/incus-qualification-settings-candidate-20260924.json` (root:root 0600),
SHA-256 `67c3d06b212db1d9b7679098efac3178a532f44296f37957e7e1cce3d266ee1f`.
It contains no secret values. It pins the live app PID 3878560, start ticks
28758896, boot ID `12e34c4a-efb4-4b11-8e95-8b74e262b5b5`, the dedicated
server principal `ezh-incus-setup@sandbox-server.taile1c5b0.ts.net`, and the
installed recipe `/opt/ezharness/scripts/incus/recipe.json` (SHA-256
`450dead42654157e3ff59e3965c82c4dc6007424856dfe556cb511ee745ce59a`).
Refresh the process identity and recipe digest before use.

The manifest now passes the settings tool's exact-key and value parser. It uses
`/var/lib/ezharness-qual-data/control-probes` as the proposed private probe
directory, the existing `global` user project ID, and the immutable BusyBox
Compose image tested in the direct Incus guest fixture. These are candidate
inputs; the new app has not used them. A root-owned 0600 Ed25519 supervisor key candidate was generated
under `/root/ezh-qual-supervisor-key-candidate-20260924`; its public DER SHA-256
is `fd84b35b412d5f0ec4bd469d9067dde2838dfbea6c2f88c47e62fad2f3f0d3af`.
It has not been installed or used to sign a receipt. The dedicated SSH
identity and one pinned known-hosts entry are now installed at the manifest
paths, both root:ezharness-qual mode 0640 under a root-owned mode 0750
directory. The key fingerprint is
`SHA256:OnzXcp0enZGflnUeycmXGju1C3YafdlELmcw75Z+XrQ` and the host key is
`SHA256:a3VHX02pT5agIluq6K12E9oCuTg09ErbQ5wK9Vvk8Co`. A read-only
`uname -r` gate call succeeded as UID 62040, and that UID cannot write the
key. The expected hold receipt path is absent.

The settings tool validates all manifest values, then requires a root-owned
mode 0600 receipt asserting a real traffic hold before it reads the old app
environment. No receipt was made because traffic was not held. Thus
`prepare --execute`, `check`, and `check-live-source` remain pending; none of
the five sealed candidate files exist. During the later authorized hold,
finish the manifest, review its digest, make the exact hold receipt, run
`prepare --execute` while the pinned old process still lives, then run
`check` and `check-live-source` immediately before stopping it. Keep the
three crypto settings byte-equal and keep values out of logs and Git.

The dedicated UID stage also has a live preflight blocker: UID 62041 has a
lingered user manager even though its runner service is inactive. Its live
processes are systemd, sd-pam, geoclue, and D-Bus; `podman ps` and
`podman ps -a` showed no containers. The stage script rejects any process
under UID 62041. A later operator can disable linger and terminate that
user session after checking for new workloads, then restore linger before
starting the runner. A later NixOS activation can restore the declared
`linger = true`; verify the UID is idle at the stage gate.
