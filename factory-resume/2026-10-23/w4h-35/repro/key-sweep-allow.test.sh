#!/usr/bin/env bash
# key-sweep-allow.test.sh (team-lead's narrow sweep ruling, 2026-10-21): key_sweep_unlisted drops a found file only when the allow
# list names it by its exact path AND its exact sha256. A key-shaped file anywhere else, a fifth file in the same folder, a changed
# copy of a listed file, or a listed file's content at another path is still reported.
set -u
. evidence/w4h-35/repro/key-sweep-allow.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0; n=0
ok() { n=$((n + 1)); [ "$1" = "$2" ] || { echo "FAIL: $3: want [$2] got [$1]"; fail=1; }; }
mkdir -p "$T/merge-plan" "$T/other"
printf 'fixture: BEGIN PRIVATE KEY marker\n' > "$T/merge-plan/a.base"; printf 'fixture 2: BEGIN PRIVATE KEY marker\n' > "$T/merge-plan/b.ours"
sha256sum "$T/merge-plan/a.base" "$T/merge-plan/b.ours" > "$T/allowed.txt"
ok "$(printf '%s\n' "$T/merge-plan/a.base" "$T/merge-plan/b.ours" | key_sweep_unlisted "$T/allowed.txt")" "" "the listed files, unchanged"
printf 'BEGIN PRIVATE KEY\n' > "$T/merge-plan/e.fifth"
ok "$(printf '%s\n' "$T/merge-plan/a.base" "$T/merge-plan/e.fifth" | key_sweep_unlisted "$T/allowed.txt")" "$T/merge-plan/e.fifth" "a fifth file in the same folder"
printf 'BEGIN PRIVATE KEY\n' > "$T/other/new.txt"
ok "$(printf '%s\n' "$T/other/new.txt" | key_sweep_unlisted "$T/allowed.txt")" "$T/other/new.txt" "a key-shaped file anywhere else"
echo 'one more line' >> "$T/merge-plan/b.ours"
ok "$(printf '%s\n' "$T/merge-plan/b.ours" | key_sweep_unlisted "$T/allowed.txt")" "$T/merge-plan/b.ours" "a changed copy of a listed file"
cp "$T/merge-plan/a.base" "$T/other/a.base"
ok "$(printf '%s\n' "$T/other/a.base" | key_sweep_unlisted "$T/allowed.txt")" "$T/other/a.base" "a listed file's content at another path"
ok "$(printf '%s\n' "$T/merge-plan/a.base" | key_sweep_unlisted "$T/missing.txt" 2> /dev/null)" "$T/merge-plan/a.base" "no allow list: nothing is dropped"
[ "$fail" = 0 ] && echo "key-sweep-allow.test.sh: $n of $n pass"
exit "$fail"
