#!/usr/bin/env bash
# kind-proof-runnerroot.test.sh [driver]: the driver's own prepare_runner_root (extracted, never restated), the operator step of the
# C12 prerequisites row, with a recording stub podman binary first on PATH. Pass: inside the node it hands the runner root to
# RUN_AS_USER with mode 0700 (one exec, the values as arguments), checks owner and mode with stat, and returns 0 with a log line;
# a node that answers another owner or mode returns 77 with the seen value named. The exact podman calls are asserted.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
T=$(mktemp -d evidence/w4h-35/repro/.runnerroottest.XXXX)
awk '/^prepare_runner_root\(\) \{/,/^\}/' "$DRIVER" > "$T/fn.sh"
cat > "$T/podman" <<STUB
#!/usr/bin/env bash
echo "podman \$*" >> "$T/calls"
case "\$*" in *" stat -c "*) cat "$T/stat" ;; esac
STUB
chmod 700 "$T/podman"
run() {  # <stat answer>
  mkdir -p "$T/p"; : > "$T/calls"; : > "$T/log"; printf '%s\n' "$1" > "$T/stat"
  T=$T PATH=$T:$PATH bash -c 'P=$T/p; NODE=w4h35-control-plane; RUNNER_ROOT=/home/<USER>/.w4h35-runner; RUN_AS_USER=10001
    log() { echo "$*" >> "$T/log"; }; . "$T/fn.sh"; prepare_runner_root' > /dev/null 2>&1
  echo "rc=$? calls=$(tr '\n' '|' < "$T/calls") log=$(tr '\n' '|' < "$T/log")"
}
ok=$(run "10001:10001 700"); bad=$(run "0:0 755")
rm -r "$T"
echo "ok:  $ok"; echo "bad: $bad"
want_calls="podman exec w4h35-control-plane sh -c chown \"\$1:\$1\" \"\$2\" && chmod 0700 \"\$2\" sh 10001 /home/<USER>/.w4h35-runner|podman exec w4h35-control-plane stat -c %u:%g %a /home/<USER>/.w4h35-runner|"
[ "$ok" = "rc=0 calls=$want_calls log=cluster: runner root prepared in the node (/home/<USER>/.w4h35-runner 10001:10001 700)|" ] \
  && [ "$bad" = "rc=77 calls=$want_calls log=cluster: runner root not prepared in the node: 0:0 755 (want 10001:10001 700)|" ] && { echo PASS; exit 0; }
echo FAIL; exit 1
