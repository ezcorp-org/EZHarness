#!/usr/bin/env bash
# kind-proof-stageimages.test.sh [driver]: the driver's own own_stage_images and remove_own_stage_images (extracted, never restated)
# on run 11's REAL image-build.log (a byte copy, hash asserted), with a recording stub podman binary first on PATH (lesson 28).
# Pass: the build's own stage images are the "--> <id>" results it created, newest first, never a FROM result (the pinned base
# image <IMAGE-ID>) and never a cached id; podman rmi is called by id only for those that are dangling, in that order, never for a
# cached id (a481809abf94, 0d71e8338753) or a dangling image of another build (ffffffffffff); a refused rmi is recorded as kept;
# the exact total of podman calls is asserted.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
FIX=evidence/w4h-35/repro/fixtures/run11/image-build.log
[ "$(sha256sum "$FIX" | cut -d' ' -f1)" = 24fc8951d31082e6fd4427f9eee6384faeeb21e239b25fd4f3febe42ce456fa3 ] || { echo "FAIL: fixture is not run 11's build log"; exit 1; }
T=$(mktemp -d evidence/w4h-35/repro/.stagetest.XXXX)
awk '/^own_stage_images\(\) \{/,/^\}/; /^remove_own_stage_images\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
cat > "$T/podman" <<STUB
#!/usr/bin/env bash
echo "podman \$*" >> "$T/calls"
case "\$1" in
  images) printf '%s\n' 148836c78674 4daa33658e58 6b8214d4e120 b6c93fdfe26b a481809abf94 0d71e8338753 ffffffffffff ;;
  rmi) [ "\$2" = 6b8214d4e120 ] && exit 1; exit 0 ;;
esac
STUB
chmod 700 "$T/podman"; mkdir -p "$T/p"; cp "$FIX" "$T/p/image-build.log"; : > "$T/calls"
own=$(T=$T bash -c '. "$T/fn.sh"; own_stage_images "$T/p/image-build.log"' | tr '\n' ' ')
T=$T PATH=$T:$PATH bash -c 'P=$T/p; log() { echo "LOG $*" >> "$T/log"; }; . "$T/fn.sh"; remove_own_stage_images' > /dev/null 2>&1
rmis=$(grep '^podman rmi' "$T/calls" | awk '{ print $3 }' | tr '\n' ' ')
got="own=$own| rmi=$rmis| total=$(wc -l < "$T/calls" | tr -d ' ') record=$(tr '\n' ';' < "$T/p/stage-images.txt") log=$(grep -c '3 removed, 1 kept' "$T/log" 2>/dev/null)"
rm -r "$T"
echo "$got"
[ "$got" = "own=148836c78674 9496ea3fa07a 4daa33658e58 6b8214d4e120 b6c93fdfe26b | rmi=148836c78674 4daa33658e58 6b8214d4e120 b6c93fdfe26b | total=5 record=removed 148836c78674;not dangling 9496ea3fa07a;removed 4daa33658e58;kept 6b8214d4e120 (in use or has children);removed b6c93fdfe26b; log=1" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
