# Local runtime image

The qualified local sandbox uses this immutable image identity:

```text
imageReference=localhost/ezharness-local-mvp@sha256:cbdad798c9d85113d326c04eddcea0e3ce272dedb00465e66aa6c6a2e8e4a437
imageId=d13851b203d0a53c1f83dc64e1eb6457eba2cfeb5a66066cbe5d63ac4f414aa7
```

Run the read-only check before starting the local provider:

```sh
scripts/pluggable-infrastructure/verify-local-runtime-image.sh
```

The qualified artifact was built from [`Dockerfile.dev`](../../Dockerfile.dev). Its image history matches that file: `oven/bun:1.3.14`, the `git` package, root and web frozen-lockfile installs, the repository copy, and the SDK and harness-client builds. The artifact was then given the repository-local `localhost/ezharness-local-mvp` name. If the exact image ID is still in the local Podman store but its name was removed, restore and verify the name without a pull:

```sh
podman --remote=false tag \
  d13851b203d0a53c1f83dc64e1eb6457eba2cfeb5a66066cbe5d63ac4f414aa7 \
  localhost/ezharness-local-mvp:20260920
scripts/pluggable-infrastructure/verify-local-runtime-image.sh
```

`Dockerfile.dev` is the repeatable source recipe for a replacement candidate:

```sh
podman --remote=false build --pull=never \
  --file Dockerfile.dev \
  --tag localhost/ezharness-local-mvp:candidate \
  .
podman --remote=false image inspect \
  localhost/ezharness-local-mvp:candidate \
  --format '{{.Id}} {{.Digest}}'
```

That build uses the current checkout and requires the base image to be cached locally. Package installation can still require network access; `--pull=never` only prevents a base-image pull. It does not claim the qualified digest unless both values match the constants above. A different result is a new image candidate: qualify it, record its full image ID and repository digest, and change runtime configuration in a separate reviewed change. Never retag a different candidate under the qualified digest or enable a network pull at provider startup.

With the verified image present, the production-driver proof is:

```sh
EZ_FUSE2FS_PATH="$(command -v fuse2fs)" \
  scripts/pluggable-infrastructure/qualify-production-local-driver.ts
```
