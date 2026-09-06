# File Organizer journal replay authorization

Pre-fix commit: `70ac5765d811c771937b89d66296d747d05d5354`

Fix commit: `50d9dbe607a7e4372a0fdc0f78ddaadbd18bd988`

Fix tree: `fd5eb40858c584fd796ba84e1c0f3e52f3fe76ee`

Runtime: Bun `1.3.14` (`0d9b296a`)

The stronger adversarial extension and sandbox-chain reproduction was not
performed because automated review restricted the task to defensive hardening.
The permitted reproduction uses the production daemon with a legitimate,
in-anchor recovery journal and owned temporary files.

## Red reproduction

```sh
env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  bun test ./src/__tests__/security/file-organizer-journal-authority.test.ts
```

Exit `1`: the deny-all engine was not called and startup deleted the source.
The allowed recovery case passed. Raw output: `red.txt.gz`.

## Green verification

```sh
env PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH \
  flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock \
  bun test ./src/__tests__/security/file-organizer-journal-authority.test.ts \
    ./src/__tests__/security/file-organizer-security.test.ts \
    ./src/__tests__/file-organizer-applier.test.ts \
    ./src/__tests__/file-organizer-applier-exdev.test.ts
```

Exit `0`: 74 tests passed, 200 assertions, 0 failures. The revoked recovery
preserved the source; the allowed recovery completed; existing containment,
malformed-journal, and filesystem-failure behavior remained green. Raw output:
`green.txt.gz`.

## SHA-256

Pre-fix source:

- `file-organizer-applier.ts`: `b6362766d40b2eeef241584913b0bd73d36f6b868672645b8734d7d18e0934ec`
- `file-organizer-daemon.ts`: `fd11c1207fb762eece5c10393fb3f74546d84dfdb754b436cdb8ddea3399abb5`

Post-fix source:

- `file-organizer-applier.ts`: `ddd8cd88e0bfa15fb5fb789d77fbf199b9b3e07f13e784e3bf015602f10207ba`
- `file-organizer-daemon.ts`: `c6866a8e81ddc3e0a52702663afa3b1374c0d034d16f78b0525440e15e767d37`

Artifacts:

- `red.txt.gz`: `6bbed61b226e819f9e48d2db53346e4904554a445e9b056aa2792afd2b66d9e6`
- `green.txt.gz`: `abce4a105eade2e939a40e5c9490511588ced7456e5c45fe8dfa6d786d6766c0`
