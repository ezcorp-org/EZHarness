#!/usr/bin/env bash
# kind-proof-nodepin.test.sh [driver]: the driver's own node_image_pin and image_id (extracted, never restated) against a stub podman
# BINARY first on PATH that serves the node probe's RECORDED output (probe-20261017T072317Z: raw crictl JSON and ctr images ls, before
# and after the tag). Never typed fixtures (team-lead, run 8). Cases:
#   accept: node-image.ref = <repo>@<the node's index digest>, raw records written, and the stub was hit (the tag call);
#   tag refused -> 72; the digest name does not resolve after the tag -> 72; no index line for the image -> 72; a different id -> 73.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}
# BYTE copies of the probe's records (repro/fixtures/probe-20261017T072317Z.sha256 lists their hashes; equal to the probe folder's).
PD=evidence/w4h-35/repro/fixtures/probe-20261017T072317Z
# N2: each fixture must hash to the probe's own record (logs/probe-shas.txt), so a changed fixture fails the test.
for pair in "factory-crictl-images-before.json=<IMAGE-ID>" "factory-crictl-images-after.json=<IMAGE-ID>" "factory-ctr-images-before.txt=<IMAGE-ID>" "factory-ctr-images-after.txt=<IMAGE-ID>"; do
  [ "$(sha256sum "$PD/${pair%%=*}" 2> /dev/null | cut -d" " -f1)" = "${pair##*=}" ] || { echo "FAIL: fixture ${pair%%=*} does not hash to the probe record"; exit 1; }
done
T=$(mktemp -d evidence/w4h-35/repro/.nodepintest.XXXX)
python3 -I - "$DRIVER" > "$T/fns.sh" <<'PYX'
import re, sys
lines = open(sys.argv[1]).read().split("\n"); out = []; i = 0
while i < len(lines):
    if re.match(r"^(node_image_pin|image_id)\(\) \{", lines[i]):
        if lines[i].rstrip().endswith("}"): out.append(lines[i]); i += 1; continue
        while True:
            out.append(lines[i]); i += 1
            if lines[i - 1] == "}": break
    else: i += 1
print("\n".join(out))
PYX
if ! grep -q '^node_image_pin()' "$T/fns.sh"; then
  # The red on an old driver: its own resolver, run on the REAL "before" shape, refuses (run 8's stop).
  awk '/^node_image_ref\(\) \{/,/^\}/' "$DRIVER" > "$T/old.sh"
  if [ -s "$T/old.sh" ]; then
    mkdir -p "$T/ob"; printf '#!/usr/bin/env bash\necho "podman $*" >> "%s/ocalls"\n[ "$3 $4" = "crictl images" ] && cat "%s/factory-crictl-images-before.json"\nexit 0\n' "$T" "$PD" > "$T/ob/podman"; chmod 700 "$T/ob/podman"
    out=$(T=$T PATH=$T/ob:$PATH bash -c 'NODE=n; IMAGE=localhost/w4h35-probe-factory:58b3ab8d91a0; . "$T/old.sh"; node_image_ref; echo "rc=$?"' 2>/dev/null | tail -1)
    echo "old resolver node_image_ref on the real before shape: $out (refused; stub hit: $(grep -c "crictl images" "$T/ocalls" 2>/dev/null))"
  fi
  echo "FAIL: node_image_pin not found"; rm -r "$T"; exit 1
fi
ID=$(python3 -I -c "import json,sys; print([i['id'] for i in json.load(open(sys.argv[1]))['images'] if 'localhost/w4h35-probe-factory:58b3ab8d91a0' in (i.get('repoTags') or [])][0])" "$PD/factory-crictl-images-before.json")
IDX=$(awk '$1 == "localhost/w4h35-probe-factory:58b3ab8d91a0" { print $3 }' "$PD/factory-ctr-images-before.txt")
mkdir -p "$T/bin"; cat > "$T/bin/podman" <<STUB
#!/usr/bin/env bash
# Serves the probe's recorded node output; state: \$S/tagged after a successful tag. MODE: ok, tagfail, noresolve, iddiff, noline.
echo "podman \$*" >> "\$S/calls"
[ "\$1 \$2" = "exec n" ] || exit 0
shift 2
state=before; [ -e "\$S/tagged" ] && state=after
case "\$*" in
  "crictl images --digests -o json") cat "$PD/factory-crictl-images-\$state.json";;
  "ctr -n k8s.io images ls") if [ "\$MODE" = noline ]; then grep -v '^localhost/w4h35-probe-factory:' "$PD/factory-ctr-images-\$state.txt"; else cat "$PD/factory-ctr-images-\$state.txt"; fi;;
  "ctr -n k8s.io images tag "*) [ "\$MODE" = tagfail ] && { echo "ctr: tag refused"; exit 1; }; : > "\$S/tagged"; echo "\$5";;
  "crictl inspecti -o json "*)
    ref=\$5
    if [ "\$ref" = localhost/w4h35-probe-factory:58b3ab8d91a0 ]; then echo '{"status":{"id":"$ID"}}'; exit 0; fi
    if [ "\$ref" = "localhost/w4h35-probe-factory@$IDX" ] && [ -e "\$S/tagged" ] && [ "\$MODE" != noresolve ]; then
      [ "\$MODE" = iddiff ] && { echo '{"status":{"id":"sha256:<IMAGE-ID>"}}'; exit 0; }
      echo '{"status":{"id":"$ID"}}'; exit 0; fi
    echo "not found" >&2; exit 1;;
esac
STUB
chmod 700 "$T/bin/podman"
run() {  # <mode>
  local d=$T/c-$1; mkdir -p "$d"
  S=$d MODE=$1 PATH=$T/bin:$PATH bash -c '
    P=$S; NODE=n; IMAGE=localhost/w4h35-probe-factory:58b3ab8d91a0; echo "localhost/w4h35-probe-factory@sha256:3418fdda" > "$P/image.ref"
    log() { echo "LOG $*" >> "$S/log"; }; mark() { :; }
    . "'"$T/fns.sh"'"; node_image_pin > /dev/null 2>&1; rc=$?
    echo "rc=$rc ref=$(cat "$S/node-image.ref" 2>/dev/null || echo none) records=$(ls "$S" | grep -cE "^node-(images|ctr-images)-(before|after)\.(json|txt)$") tagcall=$(grep -c "images tag" "$S/calls") hits=$(grep -c " crictl images --digests -o json" "$S/calls"),$(grep -c " ctr -n k8s.io images ls" "$S/calls"),$(grep -c " crictl inspecti " "$S/calls")"' 2>/dev/null
}
ok=$(run ok); tf=$(run tagfail); nr=$(run noresolve); nl=$(run noline); idd=$(run iddiff)
rm -r "$T"
echo "accept:      $ok"; echo "tag refused: $tf"; echo "no resolve:  $nr"; echo "no line:     $nl"; echo "id differs:  $idd"
[ "$ok" = "rc=0 ref=localhost/w4h35-probe-factory@$IDX records=4 tagcall=1 hits=2,2,2" ] && [[ "$tf" == "rc=72 ref=none "* ]] && [[ "$nr" == "rc=72 ref=none "* ]] \
  && [[ "$nl" == "rc=72 ref=none "* ]] && [[ "$idd" == "rc=73 ref=none "* ]] && { echo PASS; exit 0; }
echo FAIL; exit 1
