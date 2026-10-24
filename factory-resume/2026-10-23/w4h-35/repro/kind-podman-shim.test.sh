#!/usr/bin/env bash
# kind-podman-shim.test.sh: the shim rewrites only kind's /lib/modules mount and passes every other argument through unchanged.
set -uo pipefail
S=evidence/w4h-35/repro/kind-podman-shim/podman
T=$(mktemp -d evidence/w4h-35/repro/.shimtest.XXXX)
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@"\n' > "$T/echo-podman"; chmod 700 "$T/echo-podman"
out=$(REAL_PODMAN=$T/echo-podman "$S" run --name n --volume /lib/modules:/lib/modules:ro --volume v:/var:suid,exec,dev "a b" image)
want_mod=/lib/modules; [ -d /lib/modules ] || want_mod=/run/booted-system/kernel-modules/lib/modules
want=$(printf '%s\n' run --name n --volume "$want_mod:/lib/modules:ro" --volume v:/var:suid,exec,dev "a b" image)
REAL_PODMAN=$S "$S" version > /dev/null 2>&1; self=$?
rm -r "$T"
echo "rewrite: $([ "$out" = "$want" ] && echo ok || echo FAIL) (modules from $want_mod); self-reference refused: $([ "$self" = 2 ] && echo ok || echo FAIL)"
[ "$out" = "$want" ] && [ "$self" = 2 ] && { echo PASS; exit 0; }; echo FAIL; exit 1
