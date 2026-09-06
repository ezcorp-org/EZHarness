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

## Parser repair review

Runtime repair `548f6ab3c71745612e5e8e5e328f8c7366436085` separates key separators
from array separators, so neither array bracket is consumed by whitespace
handling. An independent compile produced:

- Tiny profile: `added=2`, `skipped=0`, 72 bytes. The BPF contains ALLOW for
  both declared syscalls and retains default `SCMP_ACT_ERRNO(38)`.
- Production profile: 407 unique declared names, `added=333`, `skipped=74`,
  2,736 bytes, 342 BPF instructions.
- Production RET actions include `SCMP_ACT_LOG` and `SCMP_ACT_ERRNO(38)`.
- `getpid` is explicitly LOG and `io_uring_setup` is absent from the profile.
- Fixed production BPF SHA-256:
  `4b9755245461ac5e8bed6bd3b9c3933faebd6cbc2638e50bbf6920d98efa2a1a`.

The old production image still contains the baseline SHA and must be rebuilt.
The compiler regression invokes the real C compiler with a fake libseccomp,
requires `added=2`, and inspects the default and rule actions. The baseline C
source produces `added=0`, so the regression detects restoration of the cursor
bug. The focused regression passed with 4 assertions on Bun 1.3.14.

Sanitized repair output is `fixed-compiler.txt.gz`.

## Final integrated freeze

Final source `939a2b30f5a9f6dfe06b6be00a8e87bad8344c5c`, tree
`5c12b4fe6e5f1f4bcc88aeaa15ed003ece1e5d83`, retains the reviewed repair.
Its compiler source SHA-256 is
`e938b2fdbb5d53543ea4744169817dfb145d36c840482513d541f48b70874fc4`.
The exact final compile repeats the result above: tiny `added=2`, production
`added=333`/`skipped=74`, 2,736 bytes, and fixed BPF SHA `4b975524...`.

The final no-override Gate integrity command exits 1 with the unchanged 84
findings: 1 threshold, 27 deletions, 25 renames, and 31 gutted files. Runner
discovery is P=1,564, C=1,550, W=221, residual=14, critical=38, with `C ∖ P`
empty. Runtime changed existing test files, so discovery counts did not change.

Final sanitized compiler and gate outputs are `final-compiler.txt.gz` and
`final-gate.txt.gz`.
