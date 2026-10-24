#!/usr/bin/env bash
# preview-hosted-conmon-leg.sh <image> <receipt dir> (integrator-5, 2026-10-17; team-lead's hold leg (d)): the tree's preview-isolation proof
# (scripts/verify-shipping-preview-isolation.sh) under the HOSTED conmon form: the pinned static conmon 2.2.1 (built without journald) that
# the hosted proof job installs by scripts/lib/extension-runner-conmon.sh, here from the leg-private /tmp/factory-tools/conmon-2.2.1-static
# (checked against the checksum in THAT script of the tree under test), with log_driver = "journald" as the hosted Podman default, set in a
# leg-private CONTAINERS_CONF_OVERRIDE (the host's containers.conf is never touched). Run from the repo root, in the heavy lock (Podman).
#   red by name: the pinned conmon missing or not the tree's checksum; podman not taking the override (conmon path and log driver read
#   back by podman info); the proof script failing (its own exit).
set -u
IMG=${1:?image} RCPT=${2:?receipt dir}
C=${HOSTED_CONMON:-/tmp/factory-tools/conmon-2.2.1-static/conmon}
SUM=$(sed -n 's/.*x86_64) architecture=amd64; checksum=\([0-9a-f]\{64\}\).*/\1/p' scripts/lib/extension-runner-conmon.sh 2>/dev/null)
[ -n "$SUM" ] || { echo "RED: no amd64 checksum in scripts/lib/extension-runner-conmon.sh of the tree under test"; exit 1; }
[ -x "$C" ] && [ "$(sha256sum "$C" | cut -d' ' -f1)" = "$SUM" ] || { echo "RED: the pinned conmon $C is missing or not the tree's checksum $SUM"; exit 1; }
O=$(mktemp /tmp/hosted-conmon-override.XXXXXX.conf); trap 'rm -f "$O"' EXIT
printf '[engine]\nconmon_path = ["%s"]\n\n[containers]\nlog_driver = "journald"\n' "$C" > "$O"
got=$(CONTAINERS_CONF_OVERRIDE=$O podman info --format '{{.Host.Conmon.Path}} {{.Host.LogDriver}}' 2>&1)
[ "$got" = "$C journald" ] || { echo "RED: podman did not take the hosted conmon form (got: $got)"; exit 1; }
echo "hosted conmon form: $got (override $O)"
CONTAINERS_CONF_OVERRIDE=$O EZ_PRODUCTION_IMAGE="$IMG" EZ_PRODUCTION_RECEIPT_DIR="$RCPT" timeout 2400 bash scripts/verify-shipping-preview-isolation.sh; rc=$?
echo "preview-hosted-conmon: proof exit $rc"; exit $rc
