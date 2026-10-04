# Incus Git image candidate

The normal UID/GID 1000 guest from image 0.1.2 has no Git. This correction adds Git to future builds. The existing image, alias, recipe, provider release, and running guest remain unchanged.

## Package and local proof

The exact Debian 12 amd64 pin is `git=1:2.39.5-0+deb12u3`. The [Debian package page](https://packages.debian.org/bookworm/amd64/git) lists this version. The downloaded Bookworm InRelease signatures were checked against the [official archive keys](https://ftp-master.debian.org/keys.html). Its SHA-256 entry matches the Packages index, which pins the downloaded package. [The small evidence receipt](./2026-10-04-incus-git-package-evidence.json) records the hashes and signing identities.

A rootless container used an already present Debian 12 image, no network, no pulls, a read-only root filesystem, and disposable tmpfs paths. It extracted the exact verified package and ran the builder's Git test as UID/GID 1000 with `HOME=/workspace`. Init, add, commit, clean status, and test-directory removal passed. This verifies the package and Git test. It does not prove publication or operation of the new Incus image.

The complete builder regression rejects missing/mismatched Git pins before launch, and a failed Git check before publication. The builder verifies the installed package version and `git --version`, then runs the same Git test through `setpriv --reuid=1000 --regid=1000 --clear-groups`. The existing Docker state cleanup remains mandatory; the published image contains no cached Compose workload image.

## Review and execution sequence

Use a new recipe version `1.2.3` and alias `ezharness-guest-0-1-3`. Keep its published fingerprint null until a reviewed build returns one. Reuse the exact reviewed base, Python, Docker, Compose, and helper pins. The builder now takes eleven arguments:

The temporary build guest is bounded at initial launch: 4 GiB hard memory, two CPUs with `2000ms/1000ms` hard allowance, 1,024 processes, and a 20 GiB root disk. These are fixed builder limits, not a new image capability. The operator's external execution wrapper must also enforce the reviewed 20-minute total deadline.

```text
build-guest-image.sh RECIPE_JSON BASE_FINGERPRINT PYTHON_PACKAGE_VERSION GIT_PACKAGE_VERSION DOCKER_TAR DOCKER_SHA256 COMPOSE_BINARY COMPOSE_SHA256 HELPER_PY HELPER_SHA256 ALIAS
```

After separate approval, build in a new private staging directory. Require the real builder's UID 1000 proof and clean-state checks before publication. Review the exact returned fingerprint and alias readback. Then bind that fingerprint in both provider presets of a new immutable release, review and activate that release through the existing v4 lifecycle, and complete the existing drain rules. Create and approve a fresh setup plan for the new recipe/release and connection pins. Run qualification before new user work.

A connection setting alone cannot select the new image: the active preset pins the image digest, and the setup planner rejects a recipe whose image differs. Old bindings and operation receipts must retain their original release, image, and generation. Do not replace an old alias, patch the current guest, or present an unpublished fingerprint as approved.
