# Gates: Incus release artifact pin

Scope: Bind the released Incus preset to the reviewed live image and reject any setup whose recipe does not match the active release.

- [x] G1: The Incus provider's released presets contain the reviewed nonzero image fingerprint and current helper digest; image or helper change changes the immutable release identity.
  EVIDENCE: `extensions/incus-sandbox/manifest.ts` release `0.1.1` pins guest image `57c0d028e4456a3847fb9822802d6a8f613ba4e6ef03002999e8c957a1f40c6c` and helper `804d68bd8d83ca817c6413eb3b2365216778aa26421c81fb3e9f3810b82dcb75` in both presets. `manifest.test.ts` proves either pin change changes the preset digest. The immutable release digest includes the manifest.
- [x] G2: Operator Plan fails before any server mutation if preset image/helper/recipe identity does not match the pinned reviewed recipe or server image inventory.
  EVIDENCE: `plan.ts` compares every active release preset with the reviewed recipe and checks the exact fingerprint plus alias in fresh inventory. `setup.test.ts` rejects zero, changed image/helper, and absent image. `service.test.ts` blocks an operator Plan with a zero release image before any SSH runner call.
- [x] G3: A new checked-in template and revised reviewed recipe can produce a ready Plan only for the matching image; unsupported versions and absent image remain blocked.
  EVIDENCE: `recipe.template.json` retains null build pins; `recipe.json` pins the reviewed base, Python, Docker, Compose, helper, and published image. A synthetic matching Incus 6.0.6 inventory plus scoped client certificate yields a ready Plan. Missing image, changed image/alias, and Incus 6.1.0 block it. This is local plan evidence, not live setup Apply.
- [ ] G4: Focused tests, typecheck, lint, contract build, and existing coverage thresholds pass.
  EVIDENCE: Pinned Bun 1.3.14: `bun test ./scripts/incus/setup.test.ts ./extensions/incus-sandbox/manifest.test.ts ./src/infrastructure/incus-operator/service.test.ts` passed 44/44; same files with `--coverage --coverage-reporter=text` passed 44/44 and reported manifest 100% lines/functions, planner 100% lines and 98.65% functions, operator service 100% lines/functions. `bun run typecheck`, `bun run lint`, and `bun run --cwd packages/@ezcorp/extension-contract build` passed. Repository-wide coverage thresholds remain for the integrated final head.
