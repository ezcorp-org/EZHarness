# Gates: Reviewed guest image

Scope: The deterministic Incus recipe supplies a guest with the exact helper, user, storage, and runtime expected by the provider preset.

- [ ] M1: Image recipe pins artifact/source digests and installs helper, Python 3, guest user, and private state directory.
  EVIDENCE: `recipe.json` pins the helper SHA-256 and fixed `sandbox` 1000:1000 identity. `build-guest-image.sh` verifies exact base, Docker archive, Compose binary and helper digests before launch, installs fixed helper/state paths, and prints the published fingerprint. The image source/artifact pins remain `null`; no image was built or installed.
- [ ] M2: Setup planner and preflight refuse a missing or drifted image/helper without replacing reviewed commands through inference.
  EVIDENCE: `plan.ts` checks the recipe helper digest against local source and blocks unpinned image inputs or a missing/drifted image fingerprint/alias in `inspect.ts` inventory. Host preflight still requires a live helper `hello` and image check before workload admission; integration owns that gate.
- [x] M3: Recipe and planner tests pass; any live image build or guest Compose test not run is stated as an unmet gate.
  EVIDENCE: Pinned Bun 1.3.14: 15 `scripts/incus/setup.test.ts` tests passed, backend TypeScript and Biome passed, and `bash -n` accepted the builder. **Unmet live gate:** no Incus image build, helper install, or nested Compose run occurred. The checked-in image fingerprint and artifact inputs are intentionally unpinned, so setup remains blocked.
