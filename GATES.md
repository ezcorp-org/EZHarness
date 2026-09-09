# Gates: Extension v4 implementation and PR

- [x] G1: The production rewrite and current `origin/main` are integrated at `181b7512` (tree `faa5d8ac42d605ccdbd9e079942c80269278e01d`).
- [x] G2: Final local executable validation passes after the consolidated dependency refresh. See `gates/final-validation.md` and `docs/extension-v4-validation.md`.
- [x] G3: Security, revocation, transaction, browser, image, candidate and PostgreSQL proofs pass. No remaining production blocker was found in independent review.
- [ ] G4: A maintainer reviews the 84 migration-policy findings and applies `gate-change-approved` only if the recorded dispositions are acceptable.
- [ ] G5: Draft PR 246 is updated, hosted CI passes, and a non-author approves it. Local results do not authorize merge.
