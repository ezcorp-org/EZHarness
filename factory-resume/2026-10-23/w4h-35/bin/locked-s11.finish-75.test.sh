#!/usr/bin/env bash
# locked-s11.finish-75.test.sh [<script>]: the F1 order (validator-8; team-lead option b). finish() of the session script, taken from
# the script itself, is run with a fake podman: on 75 it removes ONLY the recorded builder id, writes legs.log and the manifest, and
# exits 75; with no recorded id it calls no podman. Static checks (F2): after the builder image is built, no bare `exit 75`; a 75
# of commit 08 re-queues (finish 75); after commit 08, every 75 (commits 09-11, fast-c9) ends with a named STOP and finish 1.
set -u; SCRIPT=${1:-evidence/w4h-35/bin/locked-s11.sh}; pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); echo "ok   $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
T=$(mktemp -d /tmp/w4h35-f75.XXXXXX); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/W"; git -C "$T/W" init -q; git -C "$T/W" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
# The fake podman logs every call; `image inspect` answers the id in $T/tag-id (empty file: the tag is absent).
printf '#!/usr/bin/env bash\necho "podman $*" >> "%s/podman.calls"\n[ "$1" = image ] && { [ -s "%s/tag-id" ] && cat "%s/tag-id" || exit 125; }\nexit 0\n' "$T" "$T" "$T" > "$T/bin/podman"; chmod +x "$T/bin/podman"
FUNCS=$(sed -n -e '/^say() {/p' -e '/^manifest() {/p' -e '/^finish() {/,/manifest; exit "\$1"; }$/p' "$SCRIPT")
run() { ( PATH="$T/bin:$PATH"; D=$T/D-$1; mkdir -p "$D"; S=$D/legs.log; W=$T/W; HB=localhost/w4h35-hosted-builder:podman-4.9.3; hbid=$2
  echo leg > "$D/some-leg.log"; eval "$FUNCS"; finish 75 ); }
echo sha256:abc123 > "$T/tag-id"; run a sha256:abc123; rc=$?
ok "finish 75 exits 75"                        '[ "$rc" = 75 ]'
ok "it removes OUR TAG, never the id"          '[ "$(grep " rmi " "$T/podman.calls")" = "podman rmi localhost/w4h35-hosted-builder:podman-4.9.3" ]'
ok "the removal is recorded"                   'grep -q "podman rmi localhost/w4h35-hosted-builder:podman-4.9.3 (our tag; id sha256:abc123)" "$T/D-a/builder-removal.log"'
ok "legs.log has the final exit 75 line"       'grep -q "final exit 75:" "$T/D-a/legs.log"'
ok "the manifest lists the records"            'grep -q " ./some-leg.log$" "$T/D-a/s11-shas.txt" && grep -q " ./legs.log$" "$T/D-a/s11-shas.txt"'
rm -f "$T/podman.calls"; run b ""; rc=$?
ok "no recorded id: exit 75, no podman call"   '[ "$rc" = 75 ] && [ ! -e "$T/podman.calls" ]'
rm -f "$T/podman.calls"; echo sha256:other999 > "$T/tag-id"; run c sha256:abc123; rc=$?
ok "tag now on another id: nothing removed"    '[ "$rc" = 75 ] && ! grep -q " rmi " "$T/podman.calls" && grep -q "not the recorded sha256:abc123: nothing removed" "$T/D-c/builder-removal.log"'
ok "the script never removes the builder by id" '! grep -qE "podman rmi \"?\\\$hbid" "$SCRIPT"'
built=$(grep -n 'leg c08-builder-image' "$SCRIPT" | head -1 | cut -d: -f1)
ok "no bare exit 75 after the builder build"   '[ -n "$built" ] && ! sed -n "$built,\$p" "$SCRIPT" | grep -qE "(&&|\|\|) *exit 75|^ *exit 75"'
c08=$(grep -n '^commit_fix 08 ' "$SCRIPT" | head -1 | cut -d: -f1)
ok "a 75 of commit 08 re-queues (finish 75)"  '[ -n "$c08" ] && sed -n "$((c08+1))p" "$SCRIPT" | grep -q "\[ \"\$r\" = 75 \] && finish 75;"'
ok "after commit 08 no 75 re-queues"          '! sed -n "$((c08+2)),\$p" "$SCRIPT" | grep -qE "finish 75|exit 75"'
ok "after commit 08 a 75 ends named, exit 1"  '[ "$(sed -n "$((c08+2)),\$p" "$SCRIPT" | grep -cE "= 75 \] && \{ say \"STOP: .*no re-queue after commit 08.*finish 1; \}")" = 4 ]'
echo "finish-75 test: $pass pass $fail fail"; [ "$fail" = 0 ]
