# Seccomp compiler baseline proof

Production source: `19d9da92f771a5771d491234c9cff75eb104660b`, tree
`5bf40268df5184c05cbdc1298e16fefc5fd33883`.

Production image:
`2d069cc64bc0bf06d5216517b0ee6724a865fe88ead28850f31219c2e2ade4de`.

Compiler environment: GCC 15.2.0 and libseccomp 2.6.0 from Nix. The container
command and compiler commands ran under the shared `flock --close` lock.

The source blobs at the production revision match the audited checkout:

- `build/compile-seccomp.c`: `298859e17755043212cc47fd8878bccffca265629d62271adc80cc26d6058ed3`
- `src/extensions/mcp-seccomp.json`: `42aeb7dbff8d0fafd4b4816193e26929814b49668517c2da78d9375ea6a3cd67`

`reproduce.sh.txt` compiles a two-rule profile and the production profile. It
then decodes the tiny cBPF and compares the production compilation with the
blob in the final image.

Baseline result:

- Tiny profile: `added=0`, `skipped=0`, 48 bytes.
- Tiny final RET action: `0x00050026`, which is `SCMP_ACT_ERRNO(38)`.
- Production profile: `added=0`, `skipped=0`, 48 bytes.
- Production compile and image blob have the same SHA-256:
  `c3c7cbd8856ebb406b1c75d8e5b86e86f6553b6c5a26c93ba07c74cb27ae1bd6`.

This proves default-action parsing works and no syscall rules are emitted.
The parser's whitespace helper consumes the opening names-array bracket before
the caller checks for it. The profile explicitly assigns `ptrace` the LOG
action, so a repaired compiler must not retain the legacy expectation that
`ptrace` is denied.

Raw sanitized output is `baseline.txt.gz`. The stronger adversarial execution
path was not used.
