# Local sandbox provider

This provider connects the reviewed extension lifecycle to the local sandbox
controller. It accepts only previously admitted operations. The host owns the
runtime image, limits, workspace paths, credentials, and process supervision.

Build, review, approve, and activate this source through the normal v4
extension lifecycle. Installing source does not grant approval. The provider
requests one host API route and no network, filesystem, or secret access.

The MVP supports native EZHarness tools in an offline persistent workspace.
External hosts, Infisical, previews, Compose services, and Claude/Codex guest
workers are outside this release.

## Local host configuration

Run EZHarness as an unprivileged Linux user with rootless Podman, cgroups v2,
seccomp, `/dev/fuse`, `fuse2fs`, `fusermount3`, and e2fsprogs. Run `bun run build`
to produce the native tool bundle and detached process supervisor.

Set `EZHARNESS_LOCAL_SANDBOX_CONFIG` to an absolute path to a mode-0600 JSON file
owned by that user. These settings are host configuration, never provider input:

```json
{
  "stateRoot": "/var/tmp/ezharness-local-workspaces",
  "imageReference": "localhost/ezharness-workspace@sha256:<manifest-digest>",
  "imageId": "<64-character-image-id-without-sha256-prefix>",
  "podmanPath": "/absolute/path/to/podman",
  "fuse2fsPath": "/absolute/path/to/fuse2fs",
  "supervisorPath": "/absolute/path/to/EZHarness/dist/sandbox-supervisor",
  "nativeToolsArtifact": "/absolute/path/to/EZHarness/dist/native-tools.js",
  "workspaceUid": 0,
  "workspaceGid": 0
}
```

The digest-pinned image must already exist locally and provide Bun at
`/usr/local/bin/bun`, Bash, and basic Unix tools. The runtime never pulls an
image. See the [tested image setup](../../scripts/pluggable-infrastructure/README.md)
for the local artifact, verification command, and candidate build recipe. UID 0 is inside the rootless user namespace and maps to the invoking
unprivileged host user. All capabilities are dropped. The container has no
network, a read-only root, and fixed memory, CPU, PID, and workspace disk bounds.
The filesystem mount remains private; no `allow_other` host change is needed.

Start EZHarness with that environment variable. Use the normal extension review
screen to approve and activate `local-sandbox`, then create a sandbox from
project settings. This MVP reserves one workspace at a time, including stopped
workspaces. Dispose it explicitly before creating the next one.

Application restart with the same state root is qualified. Host reboot and
helper-crash recovery are not qualified for this MVP. Persistent storage is an
operator precaution, not a claim of recovery support.
Stop the application before changing its runtime image or host paths.
Keep the configuration, compiled supervisor, and tool bundle with the matching
application revision. A mismatch denies operations instead of adopting a
container by name.

## Local qualification

After the ordinary test/build gates, use the real browser fixture with an
isolated database and the configured local host:

```sh
cd web
bunx playwright test --config qualification/local-sandbox/playwright.config.ts
```

This requires the same rootless extension runner used by the real-auth suite.
The fixture approves only its own test installation. It does not approve an
existing user installation. Only model responses are scripted; provider review,
worker dispatch, host admission, native tools, filesystem, and cleanup are real.
