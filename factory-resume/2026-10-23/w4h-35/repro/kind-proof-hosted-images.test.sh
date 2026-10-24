#!/usr/bin/env bash
# kind-proof-hosted-images.test.sh: repro/hosted-images.ts against a hosted fleet document built from the repo's own test fixture
# (makeFactoryTestFleetSettings) with release.directory = the worktree. Pass: exactly two references, the fleet's image (pool,
# supervisor, installation pods) and the trusted ingress image, which platform.yml pins (read here from the same file, not restated).
set -uo pipefail
W=/home/<USER>/work/EZCorp/EZHarness/.worktrees/w4h-35; R=evidence/w4h-35/repro
T=$(mktemp -d evidence/w4h-35/repro/.hostedimagestest.XXXX)
. evidence/w00/bun-pin.sh; bun_pin "$W" > /dev/null
(cd "$W" && bun -e '
import { makeFactoryTestFleetSettings } from "./src/__tests__/helpers/factory-private-root";
const base = makeFactoryTestFleetSettings();
const kubernetes = { kubectl: "/usr/bin/kubectl", kubeconfigPath: "/srv/operator/kubeconfig", systemNamespace: "ezcorp-factory-test", runAsUser: 10001,
  runtimeSocketPath: "/run/podman/podman.sock", runnerRoot: "/srv/ezcorp-runner", nodeCidrs: ["<PODMAN-NET>/24"], nodeSelector: {}, ingress: { listenPort: 8443, nodePort: 30443 },
  egressCidrs: ["<PODMAN-NET>/24"], egressPorts: [5432],
  services: { databaseHost: "<PODMAN-NET>", databasePort: 5432, ordinaryEndpoint: "http://<PODMAN-NET>:8333", archiveEndpoint: "http://<PODMAN-NET>:8333", temporalAddress: "<PODMAN-NET>:7233", temporalHttpEndpoint: "https://<PODMAN-NET>:7244" } };
await Bun.write(process.argv[1], JSON.stringify({ ...base, profile: "kubernetes", kubernetes, release: { ...base.release, directory: process.argv[2] } }));
console.log(base.image.reference);' "$T/fleet.json" "$W") > "$T/image" 2> "$T/err" || { echo "FAIL: fixture: $(tail -2 "$T/err")"; rm -r "$T"; exit 1; }
(cd "$W" && bun "$R/hosted-images.ts" "$T/fleet.json") > "$T/out" 2> "$T/err"; rc=$?
image=$(cat "$T/image"); nginx=$(grep -ohE 'docker\.io/library/nginx@sha256:[a-f0-9]{64}' "$W/deploy/factory/compose/platform.yml" | sort -u)
got=$(sort "$T/out" | tr '\n' ' '); want=$(printf '%s\n%s\n' "$image" "$nginx" | sort | tr '\n' ' ')
err=$(tail -2 "$T/err"); rm -r "$T"
echo "rc=$rc"; echo "got:  $got"; echo "want: $want"; [ -n "$err" ] && echo "stderr: $err"
[ "$rc" = 0 ] && [ "$got" = "$want" ] && [ "$(echo "$got" | wc -w)" = 2 ] && { echo PASS; exit 0; }
echo FAIL; exit 1
