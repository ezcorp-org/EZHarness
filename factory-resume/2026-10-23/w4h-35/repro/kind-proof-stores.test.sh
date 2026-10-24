#!/usr/bin/env bash
# kind-proof-stores.test.sh [driver]: the driver's own step_stores, stores_setup and stores_dir (extracted, never restated)
# against a fake checkout holding the REAL scripts/setup-factory-storage.sh and a stub engine library whose compose is a recorder.
# Pass: the setup script runs under project w4h35-stores with tenants 01 and 35 and the proof's ports; its identity files hold
# exactly tenant-01 and tenant-35; no key value in any log or output; the marker is written; stores_dir finds the one directory.
set -uo pipefail
DRIVER=${1:-evidence/w4h-35/repro/kind-proof.sh}; REPO=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35
T=$(mktemp -d evidence/w4h-35/repro/.storestest.XXXX)
python3 -I - "$DRIVER" > "$T/fns.sh" <<'PYX'
import re, sys
lines = open(sys.argv[1]).read().split("\n"); out = []; i = 0
while i < len(lines):
    if re.match(r"^(step_stores|stores_setup|stores_dir)\(\) \{", lines[i]):
        if lines[i].rstrip().endswith("}"): out.append(lines[i]); i += 1; continue
        while True:
            out.append(lines[i]); i += 1
            if lines[i - 1] == "}": break
    else: i += 1
print("\n".join(out))
PYX
grep -q '^stores_setup()' "$T/fns.sh" || { echo "FAIL: stores_setup not found (the driver does not use setup-factory-storage.sh)"; rm -r "$T"; exit 1; }
mkdir -p "$T/w/scripts/lib" "$T/runtime"; chmod 700 "$T/runtime"
cp "$REPO/scripts/setup-factory-storage.sh" "$T/w/scripts/"
cat > "$T/w/scripts/lib/container-engine.sh" <<STUB
ENGINE=podman; export ENGINE
resolve_compose() { COMPOSE=("$T/compose-rec"); }
STUB
printf '#!/usr/bin/env bash\necho "project=$COMPOSE_PROJECT_NAME ports=$EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT/$EZCORP_FACTORY_STORAGE_ARCHIVE_S3_PORT/$EZCORP_FACTORY_STORAGE_ORDINARY_ADMIN_PORT/$EZCORP_FACTORY_STORAGE_ARCHIVE_ADMIN_PORT args=$*" >> %s/compose-calls\ncase " $* " in *" exec "*) cat > /dev/null;; esac\nexit 0\n' "$T" > "$T/compose-rec"; chmod 700 "$T/compose-rec"
mkdir -p "$T/bin"; printf '#!/usr/bin/env bash\nexit 0\n' > "$T/bin/podman"; chmod 700 "$T/bin/podman"
T=$T bash -c '
  set -euo pipefail
  export PATH=$T/bin:$PATH XDG_RUNTIME_DIR=$T/runtime
  W=$T/w; P=$T/p; mkdir -p "$P"; STORES_PROJECT=w4h35-stores; STORAGE_NET=w4h35-stores_default; STORES_TENANTS="01 35"
  STORE_ORDINARY=o; STORE_ARCHIVE=a; STORE_PORTS=(37333 37334 37343 37344)
  log() { echo "LOG $*" >> "$P/proof.log"; }; mark() { :; }
  . "$T/fns.sh"; step_stores > "$T/stdout" 2>&1; stores_dir > "$T/found"' 2> "$T/err"; rc=$?
dir=$(cat "$T/found" 2>/dev/null)
names() { python3 -I -c "import json,sys; print(' '.join(i['name'] for i in json.load(open(sys.argv[1]))['identities']))" "$1" 2>/dev/null; }
o=$(names "$dir/ordinary.json"); a=$(names "$dir/archive.json")
leak=0; for f in "$dir/ordinary.json" "$dir/archive.json"; do [ -f "$f" ] || continue
  for k in $(python3 -I -c "import json,sys; [print(c['accessKey'], c['secretKey']) for i in json.load(open(sys.argv[1]))['identities'] for c in i['credentials']]" "$f"); do
    grep -rqF -- "$k" "$T/p" "$T/stdout" "$T/err" "$T/compose-calls" 2>/dev/null && leak=1; done; done
projects=$(sed -E 's/ ports=.*//' "$T/compose-calls" 2>/dev/null | sort -u | tr '\n' ' '); ports=$(grep -oE 'ports=[0-9/]+' "$T/compose-calls" 2>/dev/null | sort -u | tr '\n' ' ')
marker=$([ -f "$T/p/stores-created-by-proof" ] && echo yes || echo no); base=$(basename "$dir" 2>/dev/null)
modes=$(awk '{print $1}' "$T/p/stores-modes.txt" 2>/dev/null | tr "\n" " "); modelines=$(grep -c . "$T/p/stores-modes.txt" 2>/dev/null)
modeleak=0; for f in "$dir/ordinary.json" "$dir/archive.json"; do [ -f "$f" ] || continue; for k in $(python3 -I -c "import json,sys; [print(c['accessKey'], c['secretKey']) for i in json.load(open(sys.argv[1]))['identities'] for c in i['credentials']]" "$f"); do grep -qF -- "$k" "$T/p/stores-modes.txt" 2>/dev/null && modeleak=1; done; done
rm -r "$T"
echo "rc=$rc dir=${base%.*}.* ordinary=[$o] archive=[$a] key-in-logs=$leak marker=$marker projects=[$projects] ports=[$ports] modes=[$modes] mode-lines=$modelines key-in-modes=$modeleak"
[ "$rc" = 0 ] && [ "${base%.*}" = w4h35-stores ] && [ "$o" = "tenant-01 tenant-35" ] && [ "$a" = "tenant-01 tenant-35" ] && [ "$leak" = 0 ] && [ "$marker" = yes ] \
  && [ "$projects" = "project=w4h35-stores " ] && [ "$ports" = "ports=37333/37334/37343/37344 " ] \
  && [ "$modes" = "drwx------ drwxr-xr-x -rw-r--r-- -rw-r--r-- " ] && [ "$modelines" = 4 ] && [ "$modeleak" = 0 ] && { echo PASS; exit 0; }
echo FAIL; exit 1
